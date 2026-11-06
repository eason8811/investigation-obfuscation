import {
  initializeBrowserEnvironment,
  destroyBrowserEnvironment
} from "../env/env-happydom.mjs";

import {
  monitorMethod,
  monitorLifecycle,
  printMonitorSummary
} from "../env/env-monitor.mjs";

import {
  inspectBrowserEnvironment
} from "../env/env-overrides.mjs";

import {
  setTimeout as delay
} from "node:timers/promises";

import {resolve} from "node:path";
import {pathToFileURL, fileURLToPath, URL as NodeURL} from "node:url";
import {createTrace} from "../env/env-trace.mjs";
import {appendFileSync} from "node:fs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {createHash} from "node:crypto";
import {discoverSdk, persistSdkGraph, validateAssetUrl} from "./sdk-resource-utils.mjs";

// 在 Happy DOM 覆盖全局 Web API 之前保存 Node 原生网络对象。
const nodeFetch = globalThis.fetch.bind(globalThis);
const nodeAbortSignal = globalThis.AbortSignal;

const projectRoot = fileURLToPath(
  new URL("../", import.meta.url)
);

// ========================================
// 0. 工具函数
// ========================================
async function withTimeout(action, timeoutMs) {
  let timer;

  try {
    return await Promise.race([
      Promise.resolve().then(action),

      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`SDK 调用超过 ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ========================================
// 1. 初始化浏览器环境
// ========================================

const options = {
  sdkPath: process.env.CASTLE_SDK_PATH ?? "deobfus/castle-readable.js",
  sdkSource: process.env.CASTLE_SDK_SOURCE ?? (process.env.CASTLE_SDK_FETCH_URL ? "url" : "auto"),
  sdkFetchUrl: process.env.CASTLE_SDK_FETCH_URL || null,
  sdkReferer: process.env.CASTLE_SDK_REFERER || null,
  fetchUrl: process.env.CASTLE_FETCH_URL ?? "https://x.com/",
  htmlPath: process.env.CASTLE_HTML_PATH || null,
  // 自动模式优先使用当前 HTML 中配套的公钥；手动覆盖仅用于比较实验。
  publicKey: process.env.CASTLE_PUBLIC_KEY || null,
  allowRemoteSdkExecution: process.env.CASTLE_ALLOW_REMOTE_SDK_EXECUTION === "1",
  saveHtml: process.env.CASTLE_SAVE_HTML === "1",
  saveDiscoveryAssets: process.env.CASTLE_SAVE_DISCOVERY_ASSETS === "1",
  expectedHtmlSha256: process.env.CASTLE_EXPECTED_HTML_SHA256 || null,
  expectedSdkSha256: process.env.CASTLE_EXPECTED_SDK_SHA256 || null,
  fetchTimeoutMs: Number(process.env.CASTLE_FETCH_TIMEOUT_MS ?? 15000),
  sdkFetchTimeoutMs: Number(process.env.CASTLE_SDK_FETCH_TIMEOUT_MS ?? 15000),
  // fetch | import | configure | token
  mode: process.env.CASTLE_MODE ?? "import",
  settleMs: 1000,
  // configure 返回后继续观察 3 秒
  postConfigureObserveMs: 3000,
  // token 返回后继续观察 2 秒
  postTokenObserveMs: 2000,
  tokenTimeoutMs: Number(process.env.CASTLE_TOKEN_TIMEOUT_MS ?? 15000),
  logFile: `logs/castle-${Date.now()}.jsonl`
};

if (!["fetch", "import", "configure", "token"].includes(options.mode)) {
  throw new Error(`不支持的 CASTLE_MODE: ${options.mode}`);
}
if (!["auto", "url", "local"].includes(options.sdkSource)) {
  throw new Error(`不支持的 CASTLE_SDK_SOURCE: ${options.sdkSource}`);
}
for (const name of ["fetchTimeoutMs", "sdkFetchTimeoutMs", "tokenTimeoutMs"]) {
  if (!Number.isSafeInteger(options[name]) || options[name] <= 0) {
    throw new Error(`CASTLE ${name} 必须是正整数`);
  }
}

const trace = createTrace(
  resolve(projectRoot, options.logFile)
);

function logStageInfo(stage, details) {
  trace.emit(stage, details);
  console.log(`[Castle] ${stage}:`, details);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function checkHash(label, actual, expected) {
  if (!expected) return;
  if (!/^[0-9a-f]{64}$/i.test(expected) || actual !== expected.toLowerCase()) {
    throw new Error(`${label} SHA-256 指纹与 CASTLE_EXPECTED_* 不一致：${actual}`);
  }
}

function withHeaderOverrides(headers, variable) {
  if (!process.env[variable]) return headers;
  const value = JSON.parse(process.env[variable]);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${variable} 必须是 JSON 对象`);
  }
  return {...headers, ...value};
}

function sdkHeaders(referer) {
  return withHeaderOverrides({
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    origin: "https://x.com",
    referer,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
  }, "CASTLE_SDK_FETCH_HEADERS_JSON");
}

async function limitedText(response, maxBytes) {
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > maxBytes) throw new Error("HTTP 内容超过大小限制");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("HTTP 内容超过大小限制");
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function fetchCdnAsset(input, kind, referer) {
  const url = validateAssetUrl(input, kind === "entry" ? "entry" : "asset");
  const response = await nodeFetch(url.href, {
    headers: sdkHeaders(referer),
    redirect: "manual",
    signal: nodeAbortSignal.timeout(options.sdkFetchTimeoutMs)
  });
  const finalUrl = validateAssetUrl(response.url, kind === "entry" ? "entry" : "asset");
  if (!response.ok || response.redirected || finalUrl.href !== url.href) {
    throw new Error(`${kind} 下载失败或跳转：HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (/text\/html|application\/json/i.test(contentType)) {
    throw new Error(`${kind} 响应并非 JavaScript：${contentType}`);
  }
  const content = await limitedText(response, 10 * 1024 * 1024);
  if (!content.trim()) throw new Error(`${kind} 内容为空`);
  const hash = sha256(content);
  logStageInfo("sdk.asset", {kind, url: url.href, sha256: hash, bytes: Buffer.byteLength(content)});
  return {url, content, hash};
}

async function loadHtml() {
  if (options.htmlPath) {
    const filePath = resolve(projectRoot, options.htmlPath);
    const html = await readFile(filePath, "utf8");
    logStageInfo("html.source", {type: "file", filePath});
    return html;
  }
  const fetchUrl = new NodeURL(options.fetchUrl);
  if (fetchUrl.protocol !== "https:" || !["x.com", "www.x.com"].includes(fetchUrl.hostname) || fetchUrl.port) {
    throw new Error("CASTLE_FETCH_URL 必须指向 HTTPS x.com");
  }
  const response = await nodeFetch(fetchUrl.href, {
    headers: withHeaderOverrides({
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
    }, "CASTLE_HEADERS_JSON"),
    redirect: "follow",
    signal: nodeAbortSignal.timeout(options.fetchTimeoutMs)
  });
  const finalUrl = new NodeURL(response.url);
  if (finalUrl.protocol !== "https:" || !["x.com", "www.x.com"].includes(finalUrl.hostname) || finalUrl.port || !response.ok) {
    throw new Error(`HTML 响应来源或状态异常：${response.status} ${response.url}`);
  }
  if (!/text\/html/i.test(response.headers.get("content-type") || "")) {
    throw new Error("HTML Content-Type 不符合预期");
  }
  return limitedText(response, 5 * 1024 * 1024);
}

async function saveSnapshot(kind, source, hash, extension = "js") {
  const pathname = resolve(projectRoot, "data/castle-snapshots", `${kind}-${hash}.${extension}`);
  await mkdir(dirname(pathname), {recursive: true});
  try {
    await writeFile(pathname, source, {flag: "wx", mode: 0o600});
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return pathname;
}

async function prepareCastle() {
  if (options.sdkSource === "local") {
    const sdkFile = resolve(projectRoot, options.sdkPath);
    const bytes = await readFile(sdkFile);
    checkHash("SDK", sha256(bytes), options.expectedSdkSha256);
    const html = options.htmlPath ? await loadHtml() : null;
    return {sdkFile, html, publicKey: options.publicKey ?? "pk_AvRa79bHyJSYSQHnRpcVtzyxetSvFerx"};
  }

  const html = await trace.stage("html.load", loadHtml);
  if (!html.trim()) throw new Error("HTML 为空");
  const htmlHash = sha256(html);
  logStageInfo("html.snapshot", {sha256: htmlHash, length: html.length});
  checkHash("HTML", htmlHash, options.expectedHtmlSha256);
  if (options.saveHtml && !options.htmlPath) {
    logStageInfo("html.saved", {filePath: await saveSnapshot("html", html, htmlHash, "html")});
  }

  let sdkHref;
  let referer;
  let publicKey;
  if (options.sdkSource === "auto") {
    const discovered = await trace.stage("sdk.discovery", () => discoverSdk(html, {
      target: "castle",
      fetchAsset: fetchCdnAsset,
      onEvent: logStageInfo
    }));
    sdkHref = discovered.sdkUrl;
    referer = discovered.referer;
    publicKey = options.publicKey ?? discovered.publicKey;
    if (options.saveDiscoveryAssets) {
      const entryFile = await saveSnapshot("entry", discovered.entry.content, discovered.entry.hash);
      const startupFile = await saveSnapshot("startup", discovered.startup.content, discovered.startup.hash);
      logStageInfo("sdk.discovery.saved", {entryFile, startupFile});
    }
  } else {
    if (!options.sdkFetchUrl) throw new Error("CASTLE_SDK_SOURCE=url 需要 CASTLE_SDK_FETCH_URL");
    sdkHref = validateAssetUrl(options.sdkFetchUrl);
    referer = options.sdkReferer ?? options.fetchUrl;
    publicKey = options.publicKey;
  }
  if (!publicKey) throw new Error("未找到 Castle 公钥，请指定 CASTLE_PUBLIC_KEY");

  const sdkAsset = await trace.stage("sdk.download", () => fetchCdnAsset(sdkHref, "sdk", referer));
  checkHash("SDK", sdkAsset.hash, options.expectedSdkSha256);
  const sdkFile = await trace.stage("sdk.graph", () => persistSdkGraph(sdkAsset, {
    directory: resolve(projectRoot, "data/castle-snapshots/sdk-bundles"),
    fetchAsset: fetchCdnAsset,
    onEvent: logStageInfo
  }));
  logStageInfo("sdk.snapshot", {sdkFile, sha256: sdkAsset.hash, url: sdkAsset.url.href, publicKeyFound: true});
  return {sdkFile, html, publicKey};
}

let prepared;
try {
  // 网络下载全部在安装 Happy DOM 前完成，以免 Node fetch 的 AbortSignal 不兼容。
  prepared = await trace.stage("sdk.prepare", prepareCastle);
} catch (error) {
  trace.emit("execution.error", {name: error?.name, message: error?.message, stack: error?.stack});
  await trace.close();
  throw error;
}

if (options.mode === "fetch") {
  console.log("[Castle] fetch 模式：资源链与依赖已准备，没有执行 SDK。");
  await trace.close();
} else {
  if (options.sdkSource !== "local" && !options.allowRemoteSdkExecution) {
    await trace.close();
    throw new Error("下载远程 Castle SDK 后执行需要显式设置 CASTLE_ALLOW_REMOTE_SDK_EXECUTION=1");
  }

// 致命异常监控
const fatalLogPath = `${trace.outputPath}.fatal.jsonl`;
process.on("uncaughtExceptionMonitor", (error, origin) => {
  const record = {
    timestamp: new Date().toISOString(),
    type: "process.uncaughtException",
    origin,
    error: {
      name: error?.name,
      message: error?.message,
      stack: error?.stack ?? String(error)
    }
  };

  try {
    appendFileSync(
      fatalLogPath,
      JSON.stringify(record) + "\n",
      "utf8"
    );
  } catch (writeError) {
    console.error(
      "[FatalMonitor] 无法写入异常日志:",
      writeError
    );
  }
});

console.log("[Castle:HappyDOM] Initializing...");

const env = initializeBrowserEnvironment({
  url: options.fetchUrl,
  width: 1920,
  height: 1080
});

const {
  Window: browserWindow,
  Document: browserDocument,
  Navigator: browserNavigator
} = env;

// ========================================
// 1.1 Happy DOM iframe 配置
// ========================================

const iframeSettings = browserWindow.happyDOM?.settings;

if (!iframeSettings) {
  throw new Error(
    "Happy DOM settings 不可用，无法配置 iframe"
  );
}

const enableIframe = process.env.CASTLE_ENABLE_IFRAME !== "0";

iframeSettings.enableIframePageLoading = enableIframe;

// 载入当前 HTML 的 DOM，不执行外部页面脚本，也不自动拉取 CSS/图片。
for (const [key, value] of Object.entries({
  enableJavaScriptEvaluation: false,
  disableJavaScriptEvaluation: true,
  disableJavaScriptFileLoading: true,
  enableCSSFileLoading: false,
  disableCSSFileLoading: true,
  enableImageFileLoading: true,
  handleDisabledFileLoadingAsSuccess: true
})) {
  if (key in iframeSettings) iframeSettings[key] = value;
}

if (prepared.html !== null) {
  browserDocument.open();
  browserDocument.write(prepared.html);
  browserDocument.close();
  trace.emit("html.injected", {length: prepared.html.length});
}

console.log("[HappyDOM] iframe 设置:", {
  enableIframePageLoading:
  iframeSettings.enableIframePageLoading
});

trace.emit("environment.settings", {
  enableIframePageLoading:
  iframeSettings.enableIframePageLoading
});

// ========================================
// 2. 检查环境
// ========================================

inspectBrowserEnvironment(browserWindow);


// ========================================
// 3. 安装生命周期监控
// ========================================

// 先注册我们自己的生命周期监听器，
// 避免后面的 monitorMethod 记录这些测试代码。

monitorLifecycle(browserWindow);


// ========================================
// 4. 安装方法调用监控
// ========================================

const recordMethod = record => {
  trace.emit("method.call", record);
};

// 创建 testCanvas
const testCanvas = browserDocument.createElement("canvas");
const testContext = testCanvas.getContext("2d");

monitorMethod(
  browserWindow,
  "addEventListener",
  "Window",
  {
    args: "first",
    result: false,
    traceFirst: 0
  }
);

monitorMethod(
  browserDocument,
  "addEventListener",
  "Document",
  {
    args: "first",
    result: false,
    traceFirst: 0
  }
);

monitorMethod(
  browserDocument,
  "removeEventListener",
  "Document",
  {
    args: "first",
    result: false,
    traceFirst: 0
  }
);

monitorMethod(
  browserDocument,
  "createElement",
  "Document",
  {
    args: "first",
    result: true,
    traceFirst: 2,
    maxLogs: 20,
    onRecord: recordMethod
  }
);

const CanvasPrototype =
  browserWindow.HTMLCanvasElement?.prototype;

if (CanvasPrototype) {
  monitorMethod(
    CanvasPrototype,
    "getContext",
    "HTMLCanvasElement",
    {
      args: "all",
      result: true,
      traceFirst: 4,
      maxLogs: 20,
      onRecord: recordMethod
    }
  );

  monitorMethod(
    CanvasPrototype,
    "toDataURL",
    "HTMLCanvasElement",
    {
      args: "all",
      result: true,
      traceFirst: 2,
      maxLogs: 10,
      onRecord: recordMethod
    }
  );

  monitorMethod(
    CanvasPrototype,
    "toBlob",
    "HTMLCanvasElement",
    {
      args: "all",
      result: false,
      traceFirst: 1,
      maxLogs: 10,
      onRecord: recordMethod
    }
  );
}

if (testContext) {
  const contextPrototype =
    Object.getPrototypeOf(testContext);

  const methods = [
    "fillText",
    "strokeText",
    "measureText",
    "fillRect",
    "strokeRect",
    "clearRect",
    "getImageData",
    "putImageData",
    "drawImage"
  ];

  for (const methodName of methods) {
    monitorMethod(
      contextPrototype,
      methodName,
      "CanvasRenderingContext2D",
      {
        args: "all",
        result: methodName === "measureText" ||
          methodName === "getImageData",

        traceFirst: 0,
        maxLogs: 20,
        onRecord: recordMethod
      }
    );
  }
}

let sdkModule;
let sdk;
let tokenSdk;
let configured = false;

try {
  // ========================================
  // 5. 导入 SDK
  // ========================================

  sdkModule = await trace.stage("import", async () => {
    return import(pathToFileURL(prepared.sdkFile).href);
  });

  sdk = sdkModule.default;

  trace.emit("sdk.exports", {
    exports: Reflect.ownKeys(sdkModule).map(String)
  });

  if (
    !sdk ||
    typeof sdk.configure !== "function" ||
    typeof sdk.createRequestToken !== "function"
  ) {
    throw new TypeError(
      "SDK 缺少 configure 或 createRequestToken 方法"
    );
  }

  // ========================================
  // 6. 等待导入后的异步初始化
  // ========================================

  await trace.stage("settle", async () => {
    await delay(options.settleMs);
  });

  trace.emit("environment.snapshot", {
    readyState: browserDocument.readyState,
    pluginsLength: browserNavigator.plugins?.length,
    performanceNow: browserWindow.performance.now()
  });

  // ========================================
  // 7. SDK 配置
  // ========================================

  if (options.mode !== "import") {
    if (!prepared.publicKey) {
      throw new Error(
        "缺少 CASTLE_PUBLIC_KEY 环境变量"
      );
    }

    const configuredSdk = await trace.stage(
      "configure",
      () => sdk.configure({
        pk: prepared.publicKey
      })
    );

    const hasConfiguredTokenAPI = typeof configuredSdk?.createRequestToken === "function";

    // 记录 configure() 的实际返回类型
    trace.emit("sdk.configure.return", {
      returnedType: typeof configuredSdk,
      isNull: configuredSdk === null,
      isUndefined: configuredSdk === undefined,
      isSameInstance: configuredSdk === sdk,
      hasCreateRequestToken: hasConfiguredTokenAPI
    });

    // 优先使用 configure 返回的实例
    tokenSdk = hasConfiguredTokenAPI ? configuredSdk : sdk;

    trace.emit("sdk.tokenApi.selected", {
      source: hasConfiguredTokenAPI
        ? "configure-return"
        : "module-default"
    });

    configured = true;

    trace.emit("sdk.configured", {
      completed: true
    });

    // ========================================
    // Configure 后的异步观察阶段
    // ========================================

    await trace.stage("observe.configure", async () => {
      await delay(options.postConfigureObserveMs);
    });

    trace.emit("observation.snapshot", {
      readyState: browserDocument.readyState,
      pluginsLength: browserNavigator.plugins?.length,
      performanceNow: browserWindow.performance.now(),
      configureCompleted: configured
    });
  }

  // ========================================
  // 8. 令牌生成诊断
  // ========================================

  if (options.mode === "token") {
    try {
      const token = await trace.stage(
        "createRequestToken",
        () => withTimeout(
          () => tokenSdk.createRequestToken(),
          options.tokenTimeoutMs
        )
      );

      const result = {
        configureCompleted: configured,
        returnedType: typeof token,
        returnedNull: token === null,
        length: typeof token === "string"
          ? token.length
          : undefined
      };

      trace.emit("token.result", result);

      console.log("[Castle] Token 生成诊断:", result);

    } finally {
      // 无论 Token 成功还是失败，都继续观察
      await trace.stage("observe.token", async () => {
        await delay(options.postTokenObserveMs);
      });
    }
  }

} catch (error) {
  console.error(
    "[Castle] 执行失败:",
    error?.stack ?? error
  );

  process.exitCode = 1;

} finally {
  // ========================================
  // 9. 统计与日志写入
  // ========================================

  printMonitorSummary();

  await trace.close();

  console.log(
    "[Castle] 结构化日志:",
    trace.outputPath
  );
}


// ========================================
// 10. 环境销毁
// ========================================

// 暂时不立即调用：
//
// await destroyBrowserEnvironment();
//
// 当前测试在独立 Node 进程中运行。
// 如需继续观察 SDK 的长期任务，
// 可以延长观察时间。
}
