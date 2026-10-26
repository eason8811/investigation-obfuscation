// env/env-happydom.mjs

import {GlobalRegistrator} from "@happy-dom/global-registrator";
import {CanvasAdapter} from "@happy-dom/node-canvas-adapter";

/**
 * 初始化 Happy DOM 浏览器环境
 *
 * 注意：
 * 1. 会修改 Node 全局对象
 * 2. 应在独立 Node 进程中运行
 * 3. 必须在导入 SDK 之前调用
 */
export function initializeBrowserEnvironment(options = {}) {
    const {
        url = "https://x.com/",
        width = 1920,
        height = 1080
    } = options;

    GlobalRegistrator.register({
        url,
        width,
        height
    });

    // 启用 Canvas 2D 绘图适配器
    globalThis.window.happyDOM.settings.canvasAdapter = new CanvasAdapter();

    const Window = globalThis.window;
    const Document = globalThis.document;
    const Navigator = globalThis.navigator;

    console.log("[HappyDOM] 环境初始化完成");

    console.log({
        window: typeof Window,
        document: typeof Document,
        navigator: typeof Navigator,

        documentIdentity:
            Window.document === Document,

        createElement:
            typeof Document.createElement,

        body:
        Document.body?.tagName,

        readyState:
        Document.readyState
    });

    return {
        Window,
        Document,
        Navigator
    };
}

/**
 * 释放环境
 */
export async function destroyBrowserEnvironment() {
    await GlobalRegistrator.unregister();
}