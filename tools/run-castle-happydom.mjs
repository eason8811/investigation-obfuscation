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


// ========================================
// 1. 初始化浏览器环境
// ========================================

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

// 创建 testCanvas
const testCanvas = browserDocument.createElement("canvas");
const testContext = testCanvas.getContext("2d");

monitorMethod(
    browserWindow,
    "addEventListener",
    "Window"
);

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
        maxLogs: 20
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
            maxLogs: 20
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
            maxLogs: 10
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
            maxLogs: 10
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
                maxLogs: 20
            }
        );
    }
}

// ========================================
// 5. 导入 Castle SDK
// ========================================

console.log("[Castle:HappyDOM] Import SDK...");

let sdkModule;

try {
    sdkModule = await import(
        "../deobfus/castle-readable.js"
        );

    console.log("[Castle:HappyDOM] SDK imported");

    console.log(
        "[Castle:HappyDOM] Module exports:",
        Reflect.ownKeys(sdkModule)
    );

} catch (error) {
    console.error(
        "[Castle:HappyDOM] SDK import FAILED"
    );

    console.error(error);

    // SDK 导入失败，直接结束
    process.exitCode = 1;
}


// ========================================
// 6. 观察 SDK 后续行为
// ========================================

if (sdkModule !== undefined) {
    console.log(
        "[Castle:HappyDOM] Waiting for async tasks..."
    );

    await delay(1000);

    console.log(
        "[Castle:HappyDOM] After 1000ms",
        {
            readyState:
            browserDocument.readyState,

            currentScript:
            browserDocument.currentScript,

            pluginsLength:
            browserNavigator.plugins?.length,

            performanceNow:
                browserWindow.performance.now()
        }
    );

    console.log(
        "[Castle:HappyDOM] Observation finished"
    );

    printMonitorSummary();
}


// ========================================
// 7. 环境销毁
// ========================================

// 暂时不立即调用：
//
// await destroyBrowserEnvironment();
//
// 当前测试在独立 Node 进程中运行。
// 如需继续观察 SDK 的长期任务，
// 可以延长观察时间。