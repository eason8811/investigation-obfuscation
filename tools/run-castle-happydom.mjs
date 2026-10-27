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
import {pathToFileURL, fileURLToPath} from "node:url";
import {createTrace} from "../env/env-trace.mjs";
import {appendFileSync} from "node:fs";

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
  publicKey: process.env.CASTLE_PUBLIC_KEY ?? "pk_AvRa79bHyJSYSQHnRpcVtzyxetSvFerx",
  // import | configure | token
  mode: process.env.CASTLE_MODE ?? "import",
  settleMs: 1000,
  // configure 返回后继续观察 3 秒
  postConfigureObserveMs: 3000,
  // token 返回后继续观察 2 秒
  postTokenObserveMs: 2000,
  tokenTimeoutMs: 15000,
  logFile: `logs/castle-${Date.now()}.jsonl`
};

if (!["import", "configure", "token"].includes(options.mode)) {
  throw new Error(`不支持的 CASTLE_MODE: ${options.mode}`);
}

const trace = createTrace(
  resolve(projectRoot, options.logFile)
);

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
  url: "https://x.com/",
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

const enableIframe = process.env.CASTLE_ENABLE_IFRAME === "1";

iframeSettings.enableIframePageLoading = enableIframe;

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
let configured = false;

try {
  // ========================================
  // 5. 导入 SDK
  // ========================================

  sdkModule = await trace.stage("import", async () => {
    const sdkFile = resolve(
      projectRoot,
      options.sdkPath
    );

    return import(pathToFileURL(sdkFile).href);
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
    if (!options.publicKey) {
      throw new Error(
        "缺少 CASTLE_PUBLIC_KEY 环境变量"
      );
    }

    await trace.stage("configure", async () => {
      return sdk.configure({
        pk: options.publicKey
      });
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
    const token = await trace.stage(
      "createRequestToken",
      () => withTimeout(
        () => sdk.createRequestToken(),
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

    await trace.stage("observe.token", async () => {
      await delay(options.postTokenObserveMs);
    });

    console.log("[Castle] Token 生成诊断:", result);
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