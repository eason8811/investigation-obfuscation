/**
 * Sign SDK / Happy DOM diagnostic runner.
 *
 * 放在原工程的 tools/ 或 scripts/ 目录，与 env/ 目录同级。
 * 沿用该工程的 env-happydom、env-monitor、env-overrides、env-trace。
 *
 * SIGN_MODE=probe|fetch|import|initialize|sign (默认 initialize)
 * SIGN_HTML_PATH=data/x-document.html  # 可选；不传时每次重新 fetch
 * SIGN_FETCH_URL=https://x.com/
 * SIGN_SDK_SOURCE=auto|url|local                    # 默认 auto：从当前 HTML 追踪资源链
 * SIGN_SDK_PATH=deobfus/sign-webcrack.js            # local 模式使用
 * SIGN_SDK_FETCH_URL=https://abs.twimg.com/x-web/x-web/assets/sign.o-XXXX.js # url 模式使用
 * SIGN_SDK_REFERER=https://abs.twimg.com/.../startup-dynamic-XXXX.js  # 可选
 * SIGN_SDK_FETCH_HEADERS_JSON='{"accept-language":"en-US,en;q=0.9"}' # 可选
 * SIGN_ALLOW_REMOTE_SDK_EXECUTION=1                 # 显式允许导入已下载的远程源码
 * SIGN_SAVE_DISCOVERY_ASSETS=1                      # 可选；保存 entry/startup 源码
 * SIGN_SVG_SELECTOR='svg[id^="loading-x-anim-"]'  # 可选；稳定结构选择器
 * SIGN_EXPECTED_SDK_SELECTOR=.r-a3vrho  # 可选；校验当前 SDK 所用选择器
 * SIGN_EXPECTED_HTML_SHA256=...         # 可选；锁定 HTML 内容指纹
 * SIGN_EXPECTED_SDK_SHA256=...          # 可选；锁定 SDK 内容指纹
 * SIGN_SAVE_HTML=1                      # 可选；留存 fetch 的 HTML 快照
 * SIGN_MODE=sign                      # 默认使用 jf / PATCH 特殊分支
 * SIGN_INPUT=... SIGN_METHOD=...      # 可选；覆盖默认签名参数
 * SIGN_STRICT_DOM=0                   # 仅调试缺少 SVG 的响应时使用
 * SIGN_MONITOR_ANIMATION=0            # 若怀疑监控干扰，可关闭动画与样式钩子
 * SIGN_SHOW_RESULT=1                  # 明确允许才输出完整签名值
 *
 * 注意：
 * 1. 本脚本只载入服务器响应的 HTML，不执行 HTML 内包含的脚本。
 * 2. SIGN_MODE=probe 无需网络/SDK，可与 Chrome 对照动画采样。
 * 3. auto: HTML -> entry-client-logged-out -> startup-dynamic -> sign.o-*。
 * 4. 只解析字符串引用，不执行 entry / startup；下载源码与执行 SDK 分开授权。
 * 5. 同一资源引用链比独立猜测 URL 可靠，但跨 CDN 的请求不具备原子性。
 */

import {initializeBrowserEnvironment} from "../env/env-happydom.mjs";
import {
  monitorMethod,
  monitorLifecycle,
  printMonitorSummary
} from "../env/env-monitor.mjs";
import {inspectBrowserEnvironment} from "../env/env-overrides.mjs";
import {createTrace} from "../env/env-trace.mjs";

import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {URL as NodeURL, fileURLToPath, pathToFileURL} from "node:url";
import {setTimeout as delay} from "node:timers/promises";

const projectRoot = fileURLToPath(new NodeURL("../", import.meta.url));
// Happy DOM 注册后会替换部分全局 Web API。
// 原生 fetch 必须使用与 Node/Undici 兼容的 AbortSignal 和 URL 实现。
const nodeFetch = globalThis.fetch.bind(globalThis);
const nodeAbortSignal = globalThis.AbortSignal;

function readPositiveInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数`);
  }
  return value;
}

const options = {
  mode: process.env.SIGN_MODE ?? "initialize",
  sdkPath: process.env.SIGN_SDK_PATH ?? "deobfus/sign-webcrack.js",
  sdkFetchUrl: process.env.SIGN_SDK_FETCH_URL || null,
  sdkSource: process.env.SIGN_SDK_SOURCE || (process.env.SIGN_SDK_FETCH_URL ? "url" : "auto"),
  sdkReferer: process.env.SIGN_SDK_REFERER || null,
  allowRemoteSdkExecution: process.env.SIGN_ALLOW_REMOTE_SDK_EXECUTION === "1",
  saveDiscoveryAssets: process.env.SIGN_SAVE_DISCOVERY_ASSETS === "1",
  svgSelector: process.env.SIGN_SVG_SELECTOR || 'svg[id^="loading-x-anim-"]',
  fetchUrl: process.env.SIGN_FETCH_URL ?? "https://x.com/",
  htmlPath: process.env.SIGN_HTML_PATH || null,
  expectedSdkSelector: process.env.SIGN_EXPECTED_SDK_SELECTOR || null,
  expectedHtmlSha256: process.env.SIGN_EXPECTED_HTML_SHA256 || null,
  expectedSdkSha256: process.env.SIGN_EXPECTED_SDK_SHA256 || null,
  saveHtml: process.env.SIGN_SAVE_HTML === "1",
  fetchTimeoutMs: readPositiveInt("SIGN_FETCH_TIMEOUT_MS", 15000),
  sdkFetchTimeoutMs: readPositiveInt("SIGN_SDK_FETCH_TIMEOUT_MS", 15000),
  signTimeoutMs: readPositiveInt("SIGN_TIMEOUT_MS", 15000),
  settleMs: readPositiveInt("SIGN_SETTLE_MS", 0),
  strictDom: process.env.SIGN_STRICT_DOM !== "0",
  monitorAnimation: process.env.SIGN_MONITOR_ANIMATION !== "0",
  showResult: process.env.SIGN_SHOW_RESULT === "1",
  // Pm() 在 jf.x.com 分支中固定调用 signer('jf', 'PATCH')。
  signInput: process.env.SIGN_INPUT ?? "jf",
  signMethod: process.env.SIGN_METHOD ?? "PATCH",
  logFile: `logs/sign-${Date.now()}.jsonl`
};

if (!["probe", "fetch", "import", "initialize", "sign"].includes(options.mode)) {
  throw new Error(`不支持的 SIGN_MODE：${options.mode}`);
}
if (!["auto", "url", "local"].includes(options.sdkSource)) {
  throw new Error(`不支持的 SIGN_SDK_SOURCE：${options.sdkSource}`);
}

const trace = createTrace(resolve(projectRoot, options.logFile));

function logStageInfo(stage, details) {
  trace.emit(stage, details);
  console.log(`[Sign] ${stage}:`, details);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertExpectedHash(label, actual, expected) {
  if (!expected) return;
  if (!/^[0-9a-f]{64}$/i.test(expected)) {
    throw new Error(`${label} 期望 SHA-256 必须是 64 位十六进制字符串`);
  }
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${label} 指纹不匹配：实际 ${actual}，期望 ${expected}`);
  }
}

async function persistHtmlSnapshot(html, hash) {
  if (!options.saveHtml || options.htmlPath) return;
  const filePath = resolve(projectRoot, "data/sign-snapshots", `html-${hash}.html`);
  await mkdir(dirname(filePath), {recursive: true});
  try {
    await writeFile(filePath, html, {flag: "wx", mode: 0o600});
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // HTML 可能含与会话相关的数据。请勿将快照提交到公共仓库。
  logStageInfo("html.saved", {filePath});
}

/** 限定三种已知 X CDN 资源，避免递归抓取任意 URL。 */
function validateCdnAssetUrl(value, kind) {
  const url = new NodeURL(value);
  const paths = {
    entry: /^\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js$/,
    startup: /^\/x-web\/x-web\/assets\/startup-dynamic-[A-Za-z0-9_-]+\.js$/,
    sdk: /^\/x-web\/x-web\/assets\/sign\.o-[A-Za-z0-9_-]+\.js$/
  };
  if (!Object.hasOwn(paths, kind)) throw new Error(`不支持的资源类型：${kind}`);
  if (url.protocol !== "https:" || url.hostname !== "abs.twimg.com" ||
    url.username || url.password || !paths[kind].test(url.pathname) ||
    url.search || url.hash) {
    throw new Error(`非法 ${kind} 资源地址：必须是 abs.twimg.com 上对应类型的 HTTPS JS 资源`);
  }
  return url;
}

function sdkRequestHeaders(referer = null) {
  const headers = {
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    origin: "https://x.com",
    pragma: "no-cache",
    priority: "u=1",
    referer: referer ?? options.sdkReferer ?? options.fetchUrl,
    "sec-ch-ua": '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "script",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
  };
  if (process.env.SIGN_SDK_FETCH_HEADERS_JSON) {
    const overrides = JSON.parse(process.env.SIGN_SDK_FETCH_HEADERS_JSON);
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new TypeError("SIGN_SDK_FETCH_HEADERS_JSON 必须是 JSON 对象");
    }
    Object.assign(headers, overrides);
  }
  return headers;
}

/** 匹配失败或出现多个不同候选时直接停止，避免误把其他版本当作当前版本。 */
function extractUniqueReference(source, pattern, label) {
  const candidates = [...new Set(
    Array.from(source.matchAll(pattern), match => match[1] ?? match[0])
  )];
  if (candidates.length !== 1) {
    throw new Error(`${label} 引用数量不符合预期：${candidates.length}（需要恰好 1 个）。候选：${JSON.stringify(candidates.slice(0, 8))}`);
  }
  return candidates[0];
}

/** 只读取远端 JavaScript 文本，不执行；每次都验证重定向后的最终地址。 */
async function fetchCdnAsset(urlInput, kind, referer) {
  const requestedUrl = validateCdnAssetUrl(urlInput, kind);
  const response = await nodeFetch(requestedUrl, {
    headers: sdkRequestHeaders(referer),
    // 不允许 CDN 响应跳转到其他域名后再被 Node 自动下载。
    redirect: "manual",
    signal: nodeAbortSignal.timeout(options.sdkFetchTimeoutMs)
  });
  const finalUrl = validateCdnAssetUrl(response.url, kind);
  const contentType = response.headers.get("content-type") || "";
  logStageInfo("sdk.asset.response", {
    kind,
    requestedUrl: requestedUrl.href,
    finalUrl: finalUrl.href,
    status: response.status,
    redirected: response.redirected,
    contentType
  });
  if (!response.ok) throw new Error(`${kind} 下载失败：HTTP ${response.status}`);
  if (/text\/html|application\/json/i.test(contentType)) {
    throw new Error(`${kind} 返回了非 JavaScript 响应（${contentType}）`);
  }
  const sizeHeader = Number(response.headers.get("content-length"));
  if (sizeHeader > 10 * 1024 * 1024) {
    throw new Error(`${kind} 响应超过 10 MiB 限制`);
  }
  const content = await response.text();
  const size = Buffer.byteLength(content, "utf8");
  if (!content.trim() || size > 10 * 1024 * 1024) {
    throw new Error(`${kind} 内容为空或超过 10 MiB 限制`);
  }
  const hash = sha256(content);
  logStageInfo("sdk.asset.snapshot", {kind, url: finalUrl.href, size, sha256: hash});
  return {url: finalUrl, content, size, hash};
}

async function saveAssetSnapshot(kind, content, hash) {
  const extension = kind === "sdk" ? "mjs" : "js";
  const filePath = resolve(projectRoot, "data/sign-snapshots", `${kind}-${hash}.${extension}`);
  await mkdir(dirname(filePath), {recursive: true});
  try {
    await writeFile(filePath, content, {flag: "wx", mode: 0o600});
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return filePath;
}

/**
 * 自动发现资源链（用户已通过浏览器断点证实的引用结构）：
 * HTML 的 entry-client-logged-out URL -> entry 的 startup-dynamic specifier
 * -> startup 的 sign.o-* specifier。所有相对路径都以引用所在模块的 URL 为基准。
 */
async function discoverSdkFromHtml(html) {
  const entryHref = extractUniqueReference(
    html,
    /https:\/\/abs\.twimg\.com\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js/g,
    "HTML 中的 entry-client-logged-out"
  );
  const entry = await trace.stage("sdk.discovery.entry", () =>
    fetchCdnAsset(entryHref, "entry", options.fetchUrl)
  );
  const startupSpecifier = extractUniqueReference(
    entry.content,
    /["'`](\.\/assets\/startup-dynamic-[A-Za-z0-9_-]+\.js)["'`]/g,
    "entry 中的 startup-dynamic"
  );
  const startupHref = new NodeURL(startupSpecifier, entry.url).href;
  const startup = await trace.stage("sdk.discovery.startup", () =>
    fetchCdnAsset(startupHref, "startup", entry.url.href)
  );
  const sdkSpecifier = extractUniqueReference(
    startup.content,
    /["'`](\.\/sign\.o-[A-Za-z0-9_-]+\.js)["'`]/g,
    "startup 中的 sign.o"
  );
  const sdkHref = validateCdnAssetUrl(new NodeURL(sdkSpecifier, startup.url).href, "sdk").href;
  const appVersion = html.match(/\bdata-app-version\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
  logStageInfo("sdk.discovery.chain", {
    appVersion,
    entryUrl: entry.url.href,
    entrySha256: entry.hash,
    startupUrl: startup.url.href,
    startupSha256: startup.hash,
    sdkUrl: sdkHref
  });
  if (options.saveDiscoveryAssets) {
    const entryFile = await saveAssetSnapshot("entry", entry.content, entry.hash);
    const startupFile = await saveAssetSnapshot("startup", startup.content, startup.hash);
    logStageInfo("sdk.discovery.saved", {entryFile, startupFile});
  }
  return {sdkHref, referer: startup.url.href};
}

async function prepareSdkFile(html) {
  if (options.sdkSource === "local") {
    const filePath = resolve(projectRoot, options.sdkPath);
    const content = await readFile(filePath);
    const hash = sha256(content);
    logStageInfo("sdk.snapshot", {
      type: "file", filePath, size: content.byteLength, sha256: hash
    });
    assertExpectedHash("SDK", hash, options.expectedSdkSha256);
    return filePath;
  }

  let sdkHref, referer;
  if (options.sdkSource === "auto") {
    ({sdkHref, referer} = await discoverSdkFromHtml(html));
  } else {
    if (!options.sdkFetchUrl) {
      throw new Error("SIGN_SDK_SOURCE=url 时必须提供 SIGN_SDK_FETCH_URL");
    }
    sdkHref = validateCdnAssetUrl(options.sdkFetchUrl, "sdk").href;
    referer = options.sdkReferer ?? options.fetchUrl;
  }
  const sdk = await trace.stage("sdk.discovery.sign", () =>
    fetchCdnAsset(sdkHref, "sdk", referer)
  );
  assertExpectedHash("SDK", sdk.hash, options.expectedSdkSha256);
  const filePath = await saveAssetSnapshot("sdk", sdk.content, sdk.hash);
  logStageInfo("sdk.snapshot", {
    type: options.sdkSource, sourceUrl: sdk.url.href,
    filePath, size: sdk.size, sha256: sdk.hash
  });
  return filePath;
}

function requestHeaders() {
  const headers = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'priority': 'u=0, i',
    'sec-ch-ua': '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
  };

  if (process.env.SIGN_HEADERS_JSON) {
    const overrides = JSON.parse(process.env.SIGN_HEADERS_JSON);
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new TypeError("SIGN_HEADERS_JSON 必须是 JSON 对象");
    }
    Object.assign(headers, overrides);
  }
  return headers;
}

async function loadHtml() {
  if (options.htmlPath) {
    const filePath = resolve(projectRoot, options.htmlPath);
    const html = await readFile(filePath, "utf8");
    logStageInfo("html.source", {type: "file", filePath});
    return html;
  }

  const response = await nodeFetch(options.fetchUrl, {
    method: "GET",
    headers: requestHeaders(),
    redirect: "follow",
    signal: nodeAbortSignal.timeout(options.fetchTimeoutMs)
  });

  const metadata = {
    type: "fetch",
    requestedUrl: options.fetchUrl,
    finalUrl: response.url,
    status: response.status,
    redirected: response.redirected,
    contentType: response.headers.get("content-type")
  };
  logStageInfo("html.response", metadata);

  if (!response.ok) {
    throw new Error(`HTML 请求失败：HTTP ${response.status} (${response.url})`);
  }
  if (!metadata.contentType?.toLowerCase().includes("text/html")) {
    throw new Error(`期望 text/html，实际是 ${metadata.contentType ?? "未知"}`);
  }

  return response.text();
}

function disableAutomaticResourceLoading(browserWindow) {
  const settings = browserWindow.happyDOM?.settings;
  if (!settings) return;

  // Happy DOM 不同版本的设置项名称可能不同。
  for (const [key, value] of Object.entries({
    enableJavaScriptEvaluation: false,
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    enableCSSFileLoading: false,
    disableCSSFileLoading: true,
    enableImageFileLoading: false,
    enableIframePageLoading: false,
    // 仅抑制“CSS 已禁用”的错误事件，不代表 CSS 已实际加载。
    handleDisabledFileLoadingAsSuccess: true
  })) {
    if (key in settings) settings[key] = value;
  }
}

function diagnoseDocument(document, window) {
  const twitterNodes = Array.from(document.querySelectorAll("[name^=tw]"));
  // 用业务上较稳定的 SVG id 做预检；SDK 自身的混淆 class 可随部署变化。
  const svgNodes = Array.from(document.querySelectorAll(options.svgSelector));
  const sdkNodes = options.expectedSdkSelector
    ? Array.from(document.querySelectorAll(options.expectedSdkSelector))
    : null;
  const first = twitterNodes[0] ?? null;
  const content = first?.getAttribute("content") ?? null;

  let decoded = null;
  let decodeError = null;
  if (content !== null) {
    try {
      decoded = window.atob(content);
    } catch (error) {
      decodeError = String(error);
    }
  }

  const chosenIndex = decoded?.length >= 6
    ? decoded.charCodeAt(5) % 4
    : null;
  const chosenSvg = chosenIndex === null ? null : svgNodes[chosenIndex];
  const chosenPath = chosenSvg?.childNodes?.[0]?.childNodes?.[1];
  const chosenD = chosenPath?.getAttribute?.("d") ?? null;

  const classSets = svgNodes.map(node => new Set(
    String(node.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)
  ));
  const commonClasses = classSets.length === 4
    ? Array.from(classSets[0]).filter(value => classSets.every(set => set.has(value)))
    : [];
  const sdkSelectorMatchesSvg = sdkNodes === null ? null
    : sdkNodes.length === 4 && svgNodes.length === 4 &&
    sdkNodes.every((node, i) => node === svgNodes[i]);

  // 只记录结构及长度，默认不记录 HTML、meta content、SVG path 或签名值。
  return {
    firstTwitterName: first?.getAttribute("name") ?? null,
    twitterElements: twitterNodes.length,
    firstTwitterContentLength: content?.length ?? null,
    decodedBytes: decoded?.length ?? null,
    decodeError,
    svgSelector: options.svgSelector,
    svgElements: svgNodes.length,
    svgIds: svgNodes.map(node => node.id || null),
    svgClasses: svgNodes.map(node => String(node.getAttribute("class") ?? "")
      .split(/\s+/).filter(Boolean)),
    commonSvgClasses: commonClasses,
    expectedSdkSelector: options.expectedSdkSelector,
    sdkSelectorMatches: sdkNodes?.length ?? null,
    sdkSelectorMatchesSvg,
    chosenIndex,
    chosenTag: chosenPath?.tagName ?? null,
    chosenDLength: chosenD?.length ?? null,
    selectorPathValid: chosenPath?.localName === "path" && Boolean(chosenD)
  };
}

/**
 * 只采集动画与计算样式，不修改 SDK 的任何返回值。
 * 在 getComputedStyle() 时关联同一个元素上最近创建的 Animation。
 */
function monitorAnimationAndComputedStyle(window) {
  const animations = new WeakMap();
  const elementProto = window.Element?.prototype;
  const animate = elementProto?.animate;
  if (typeof animate === "function") {
    const descriptor = Object.getOwnPropertyDescriptor(elementProto, "animate");
    if (!descriptor || descriptor.configurable !== false) {
      Object.defineProperty(elementProto, "animate", {
        configurable: true,
        writable: true,
        enumerable: descriptor?.enumerable ?? false,
        value: function (...args) {
          // 不主动调用原本不存在的浏览器 API，也不替换 Animation 行为。
          const animation = Reflect.apply(animate, this, args);
          animations.set(this, animation);
          const frames = args[0];
          const keyframeKeys = Array.isArray(frames)
            ? [...new Set(frames.flatMap(frame => Object.keys(frame ?? {})))]
            : frames && typeof frames === "object" ? Object.keys(frames) : [];
          const options = args[1];
          const record = {
            element: this.tagName ?? null,
            frameFormat: Array.isArray(frames) ? "array" : typeof frames,
            frameKeys: keyframeKeys,
            options: typeof options === "number" ? {duration: options} : {
              duration: options?.duration ?? null,
              easing: options?.easing ?? null,
              fill: options?.fill ?? null
            },
            animationType: animation?.constructor?.name ?? null
          };
          trace.emit("animation.animate", record);
          console.log("[Sign] animation.animate:", record);
          return animation;
        }
      });
    }
  } else {
    logStageInfo("animation.availability", {elementAnimate: typeof animate});
  }

  const original = window.getComputedStyle;
  const descriptor = Object.getOwnPropertyDescriptor(window, "getComputedStyle");
  if (typeof original !== "function" || descriptor?.configurable === false) {
    logStageInfo("style.availability", {getComputedStyle: typeof original});
    return;
  }
  let count = 0;
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    writable: true,
    enumerable: descriptor?.enumerable ?? false,
    value: function (...args) {
      const style = Reflect.apply(original, this, args);
      if (++count <= 40) {
        const target = args[0];
        const animation = target && animations.get(target);
        const record = {
          call: count,
          element: target?.tagName ?? null,
          connected: target?.isConnected ?? null,
          animated: Boolean(animation),
          animationCurrentTime: animation?.currentTime ?? null,
          animationPlayState: animation?.playState ?? null,
          color: style?.color ?? null,
          transform: style?.transform ?? null
        };
        trace.emit("style.computed", record);
        console.log("[Sign] style.computed:", record);
      }
      return style;
    }
  });
}

/** 在空白 DOM 中做一致性探针，不依赖任何目标站点数据。 */
function runAnimationProbe(window, document) {
  // ===== 静态 CSS 计算样式探针 =====
  const element = document.createElement("div");

  document.body.appendChild(element);

  try {
    element.style.color = "rgb(11, 195, 125)";
    element.style.transform = "rotate(45deg)";

    const style = window.getComputedStyle(element);

    logStageInfo("style.static.probe", {
      inlineColor: element.style.color,
      inlineTransform: element.style.transform,
      computedColor: style.color,
      computedTransform: style.transform,
      disabled: window.happyDOM.settings.disableComputedStyleRendering
    });
  } finally {
    element.remove();
  }

  const tests = [
    {
      name: "array-keyframes-linear",
      frames: [
        {color: "#0bc37d", transform: "rotate(0deg)"},
        {color: "#d788fb", transform: "rotate(161deg)"}
      ]
    },
    {
      name: "property-indexed-custom-easing",
      frames: {
        color: ["#0bc37d", "#d788fb"],
        transform: ["rotate(0deg)", "rotate(161deg)"],
        easing: "cubic-bezier(0.14,0.37,0.62,-0.54)"
      }
    }
  ];
  const results = [];
  for (const test of tests) {
    const element = document.createElement("div");
    document.body.append(element);
    let animation;
    try {
      if (typeof element.animate !== "function") {
        throw new TypeError("Element.animate() 不存在");
      }
      animation = element.animate(test.frames, {duration: 1000, fill: "both"});
      // 某些 Happy DOM 版本的 cancel() 会拒绝 finished；先挂处理器。
      animation.finished?.catch?.(() => {
      });
      animation.pause();
      const samples = [200, 800].map(time => {
        animation.currentTime = time;
        const computed = window.getComputedStyle(element);
        return {
          time,
          currentTime: animation.currentTime ?? null,
          playState: animation.playState ?? null,
          color: computed.color,
          transform: computed.transform
        };
      });
      const changed = samples[0].color !== samples[1].color ||
        samples[0].transform !== samples[1].transform;
      results.push({name: test.name, changed, samples});
    } catch (error) {
      results.push({name: test.name, error: String(error), changed: false});
    } finally {
      try {
        animation?.cancel?.();
      } catch { /* 清理失败不覆盖探针结果 */
      }
      element.remove();
    }
  }
  const pass = results.every(result => result.changed);
  logStageInfo("animation.probe", {pass, results});
  if (!pass) console.warn(
    "[Sign] 动画探针未通过：Happy DOM 可能未将动画采样反映到 getComputedStyle。"
  );
  return pass;
}

function monitorSignDom(window, document) {
  const record = item => trace.emit("method.call", item);
  const config = {
    args: "all",
    result: true,
    traceFirst: 0,
    maxLogs: 120,
    onRecord: record
  };

  monitorLifecycle(window);
  if (options.monitorAnimation) monitorAnimationAndComputedStyle(window);
  monitorMethod(document, "querySelectorAll", "Document", config);
  monitorMethod(document, "createElement", "Document", config);

  if (window.Element?.prototype) {
    monitorMethod(window.Element.prototype, "getAttribute", "Element", config);
  }
  if (window.Node?.prototype) {
    monitorMethod(window.Node.prototype, "removeChild", "Node", config);
  }
  if (window.crypto?.subtle) {
    monitorMethod(window.crypto.subtle, "digest", "SubtleCrypto", {
      args: "first", // SHA-256 等算法名称；避免记录完整输入字节
      result: false,
      traceFirst: 0,
      maxLogs: 60,
      onRecord: record
    });
  }
}

async function withTimeout(action, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`签名超过 ${ms} ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let environmentInitialized = false;
try {
  // probe 不读取网站，也不导入 SDK，方便与 Chrome 控制台独立对照。
  const html = options.mode === "probe" ? null : await trace.stage("html.load", loadHtml);
  if (html !== null) {
    const htmlHash = sha256(html);
    logStageInfo("html.snapshot", {length: html.length, sha256: htmlHash});
    assertExpectedHash("HTML", htmlHash, options.expectedHtmlSha256);
    await persistHtmlSnapshot(html, htmlHash);
  }

  // 必须在 Happy DOM 注册 *之前* 完成所有 Node fetch。
  // Undici 的 RequestInit.signal 会按“当前全局 AbortSignal”做 WebIDL 校验；
  // 即使提前保存原生构造器，只要注册后全局被替换，依旧可能抛 TypeError。
  const needsSdk = html !== null &&
    (options.mode !== "fetch" || options.sdkSource !== "local");
  const sdkFile = needsSdk
    ? await trace.stage("sdk.load", () => prepareSdkFile(html))
    : null;

  const env = initializeBrowserEnvironment({
    url: options.fetchUrl,
    width: 1920,
    height: 1080
  });
  environmentInitialized = true;
  const {
    Window: browserWindow,
    Document: browserDocument
  } = env;

  disableAutomaticResourceLoading(browserWindow);

  if (options.mode === "probe") {
    const pass = await trace.stage("animation.probe.run", () =>
      runAnimationProbe(browserWindow, browserDocument)
    );
    if (!pass) process.exitCode = 2;
  } else {
    await trace.stage("html.inject", () => {
      browserDocument.open();
      browserDocument.write(html);
      browserDocument.close();
    });

    const before = diagnoseDocument(browserDocument, browserWindow);
    logStageInfo("dom.before", before);

    const needsSignatureDom = options.mode === "initialize" || options.mode === "sign";
    if (options.expectedSdkSelector && before.sdkSelectorMatchesSvg === false) {
      console.warn(
        `[Sign] SDK/HTML 选择器疑似不配套：${options.expectedSdkSelector} 没有按顺序匹配四个动画 SVG。`
      );
    }
    if (options.strictDom && needsSignatureDom &&
      (!before.selectorPathValid || before.svgElements !== 4 ||
        before.sdkSelectorMatchesSvg === false)) {
      throw new Error(
        "预检失败：HTML 缺少完整的 4 个动画 SVG，或 SIGN_EXPECTED_SDK_SELECTOR 与当前 HTML 不匹配。请更新并配对 SDK/HTML。"
      );
    }

    if (options.mode === "fetch") {
      console.log("[Sign] fetch/DOM/SDK 资源链验证结束，没有执行 SDK。");
    } else {
      // SDK 使用的是 Node 原生动态 import，必须确保它能看到 Happy DOM。
      if (globalThis.window !== browserWindow || globalThis.document !== browserDocument) {
        throw new Error(
          "全局 window/document 尚未绑定 Happy DOM，请检查 env-happydom.mjs 的全局对象注入逻辑。"
        );
      }

      inspectBrowserEnvironment(browserWindow);
      monitorSignDom(browserWindow, browserDocument);

      // 下载并保存与执行是两个独立授权动作，默认只允许前者。
      if (options.sdkSource !== "local" && !options.allowRemoteSdkExecution) {
        throw new Error(
          "SDK 已保存但未导入。若确认信任该远程源码，请显式设置 SIGN_ALLOW_REMOTE_SDK_EXECUTION=1。"
        );
      }

      const sdkModule = await trace.stage("import", async () => {
        return import(pathToFileURL(sdkFile).href);
      });
      logStageInfo("sdk.exports", {exports: Reflect.ownKeys(sdkModule).map(String)});

      if (typeof sdkModule.default !== "function") {
        throw new TypeError("SDK 默认导出不是工厂函数");
      }

      if (options.mode !== "import") {
        const signer = await trace.stage("initialize", async () => sdkModule.default());
        logStageInfo("sdk.initialized", {signerType: typeof signer});
        if (typeof signer !== "function") {
          throw new TypeError("default() 未返回签名函数");
        }

        if (options.settleMs > 0) {
          await trace.stage("settle", () => delay(options.settleMs));
        }

        if (options.mode === "sign") {
          if (!options.signInput || !options.signMethod) {
            throw new Error("SIGN_INPUT 和 SIGN_METHOD 不能是空字符串");
          }
          const signature = await trace.stage("sign", () => withTimeout(
            () => signer(options.signInput, options.signMethod),
            options.signTimeoutMs
          ));
          logStageInfo("sign.result", {
            type: typeof signature,
            length: typeof signature === "string" ? signature.length : null
          });
          if (options.showResult) console.log("[Sign] 签名值:", signature);
        }

        logStageInfo("dom.after", diagnoseDocument(browserDocument, browserWindow));
      }
    }
  }
} catch (error) {
  console.error("[Sign] 执行失败:", error?.stack ?? error);
  trace.emit("execution.error", {
    name: error?.name,
    message: error?.message,
    stack: error?.stack
  });
  process.exitCode = 1;
} finally {
  if (environmentInitialized) printMonitorSummary();
  await trace.close();
  console.log("[Sign] 结构化日志:", trace.outputPath);
}
