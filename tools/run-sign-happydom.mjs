/**
 * Sign SDK / Happy DOM diagnostic runner.
 *
 * 放在原 Castle 工程的 scripts/ 目录，与 env/ 目录同级。
 * 沿用该工程的 env-happydom、env-monitor、env-overrides、env-trace。
 *
 * SIGN_MODE=fetch|import|initialize|sign (默认 initialize)
 * SIGN_HTML_PATH=data/x-document.html  # 可选；不传时每次重新 fetch
 * SIGN_FETCH_URL=https://x.com/
 * SIGN_SDK_PATH=deobfus/sign-webcrack.js
 * SIGN_MODE=sign                      # 默认使用 jf / PATCH 特殊分支
 * SIGN_INPUT=... SIGN_METHOD=...      # 可选；覆盖默认签名参数
 * SIGN_STRICT_DOM=0                   # 仅调试缺少 SVG 的响应时使用
 * SIGN_SHOW_RESULT=1                  # 明确允许才输出完整签名值
 *
 * 注意：本脚本只载入服务器响应的 HTML，不执行响应内包含的脚本。
 *      因此 fetch 的 HTML 不保证与 Chrome 执行脚本后的实时 DOM 一致。
 */

import { initializeBrowserEnvironment } from "../env/env-happydom.mjs";
import {
  monitorMethod,
  monitorLifecycle,
  printMonitorSummary
} from "../env/env-monitor.mjs";
import { inspectBrowserEnvironment } from "../env/env-overrides.mjs";
import { createTrace } from "../env/env-trace.mjs";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
// 保留原生 fetch 的引用：浏览器环境初始化可能覆盖 globalThis.fetch。
const nodeFetch = globalThis.fetch.bind(globalThis);

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
  fetchUrl: process.env.SIGN_FETCH_URL ?? "https://x.com/",
  htmlPath: process.env.SIGN_HTML_PATH || null,
  fetchTimeoutMs: readPositiveInt("SIGN_FETCH_TIMEOUT_MS", 15000),
  signTimeoutMs: readPositiveInt("SIGN_TIMEOUT_MS", 15000),
  settleMs: readPositiveInt("SIGN_SETTLE_MS", 0),
  strictDom: process.env.SIGN_STRICT_DOM !== "0",
  showResult: process.env.SIGN_SHOW_RESULT === "1",
  // Pm() 在 jf.x.com 分支中固定调用 signer('jf', 'PATCH')。
  signInput: process.env.SIGN_INPUT ?? "jf",
  signMethod: process.env.SIGN_METHOD ?? "PATCH",
  logFile: `logs/sign-${Date.now()}.jsonl`
};

if (!["fetch", "import", "initialize", "sign"].includes(options.mode)) {
  throw new Error(`不支持的 SIGN_MODE：${options.mode}`);
}

const trace = createTrace(resolve(projectRoot, options.logFile));

function logStageInfo(stage, details) {
  trace.emit(stage, details);
  console.log(`[Sign] ${stage}:`, details);
}

function requestHeaders() {
  // 不伪造 sec-fetch-* 等浏览器上下文专属字段。
  const headers = {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
  };

  if (process.env.SIGN_HEADERS_JSON) {
    const overrides = JSON.parse(process.env.SIGN_HEADERS_JSON);
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw new TypeError("SIGN_HEADERS_JSON 必须是 JSON 对象");
    }
    Object.assign(headers, overrides);
  }
  // 不将 headers 写入日志，避免意外记录 Cookie、Authorization 等信息。
  return headers;
}

async function loadHtml() {
  if (options.htmlPath) {
    const filePath = resolve(projectRoot, options.htmlPath);
    const html = await readFile(filePath, "utf8");
    logStageInfo("html.source", { type: "file", filePath });
    return html;
  }

  const response = await nodeFetch(options.fetchUrl, {
    method: "GET",
    headers: requestHeaders(),
    redirect: "follow",
    signal: AbortSignal.timeout(options.fetchTimeoutMs)
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
    enableIframePageLoading: false
  })) {
    if (key in settings) settings[key] = value;
  }
}

function diagnoseDocument(document, window) {
  const twitterNodes = Array.from(document.querySelectorAll("[name^=tw]"));
  const svgNodes = Array.from(document.querySelectorAll(".r-69fsg"));
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

  // 只记录结构及长度，默认不记录 HTML、meta content、SVG path 或签名值。
  return {
    firstTwitterName: first?.getAttribute("name") ?? null,
    twitterElements: twitterNodes.length,
    firstTwitterContentLength: content?.length ?? null,
    decodedBytes: decoded?.length ?? null,
    decodeError,
    svgElements: svgNodes.length,
    svgIds: svgNodes.map(node => node.id || null),
    chosenIndex,
    chosenTag: chosenPath?.tagName ?? null,
    chosenDLength: chosenD?.length ?? null,
    selectorPathValid: Boolean(chosenD)
  };
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
  const html = await trace.stage("html.load", loadHtml);
  logStageInfo("html.snapshot", {
    length: html.length,
    sha256: createHash("sha256").update(html).digest("hex")
  });

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

  await trace.stage("html.inject", () => {
    browserDocument.open();
    browserDocument.write(html);
    browserDocument.close();
  });

  const before = diagnoseDocument(browserDocument, browserWindow);
  logStageInfo("dom.before", before);

  const needsSignatureDom = options.mode === "initialize" || options.mode === "sign";
  if (options.strictDom && needsSignatureDom &&
      (!before.selectorPathValid || before.svgElements < 4)) {
    throw new Error(
      "获取到的 HTML 缺少目标 SVG 或其内部 path；可能是不同页面版本、登录页，或元素由浏览器脚本动态生成。"
    );
  }

  if (options.mode === "fetch") {
    console.log("[Sign] fetch/DOM 验证结束，没有加载 SDK。");
  } else {
    // SDK 使用的是 Node 原生动态 import，必须确保它能看到 Happy DOM。
    if (globalThis.window !== browserWindow || globalThis.document !== browserDocument) {
      throw new Error(
        "全局 window/document 尚未绑定 Happy DOM，请检查 env-happydom.mjs 的全局对象注入逻辑。"
      );
    }

    inspectBrowserEnvironment(browserWindow);
    monitorSignDom(browserWindow, browserDocument);

    const sdkModule = await trace.stage("import", async () => {
      const filePath = resolve(projectRoot, options.sdkPath);
      return import(pathToFileURL(filePath).href);
    });
    logStageInfo("sdk.exports", { exports: Reflect.ownKeys(sdkModule).map(String) });

    if (typeof sdkModule.default !== "function") {
      throw new TypeError("SDK 默认导出不是工厂函数");
    }

    if (options.mode !== "import") {
      const signer = await trace.stage("initialize", async () => sdkModule.default());
      logStageInfo("sdk.initialized", { signerType: typeof signer });
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
