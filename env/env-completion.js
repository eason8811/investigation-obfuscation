/**
 * 根据属性快照创建可监控的环境对象。
 *
 * @param {string[]} keys 对象的可枚举属性名，例如 Object.keys(window) 的结果
 * @param {object} implementations 已实现属性及其对应值
 * @param {object} options 配置选项
 * @param {string} [options.label="Object"] 日志标识，例如 Window、Document、Navigator
 * @param {string[]} [options.selfReferences=[]] 自引用属性，例如 ["window", "self"]
 * @param {boolean} [options.logReads=true] 是否记录已实现属性读取
 * @param {boolean} [options.logWrites=true] 是否记录属性赋值
 * @param {boolean} [options.logMissing=true] 是否记录未实现属性读取
 * @param {boolean} [options.logEnumerations=false] 是否记录属性枚举
 * @returns {object}
 */
function createObject(keys = [], implementations = {}, options = {}) {
    const {
        label = "Object",
        selfReferences = [],
        logReads = true,
        logWrites = true,
        logMissing = true,
        logEnumerations = false
    } = options;

    const target = {};

    // 快照中声明的属性
    const declared = new Set(keys);

    // 已实现的属性
    const entries = Object.entries(implementations);
    const values = new Map(entries);
    const implemented = new Set(values.keys());

    // 1. 根据快照创建可枚举属性
    for (const key of declared) {
        Object.defineProperty(target, key, {
            value: values.get(key),
            enumerable: true,
            writable: true,
            configurable: true
        });
    }

    // 2. 已实现但不在快照中的属性，默认不可枚举
    for (const [key, value] of entries) {
        if (declared.has(key)) {
            continue;
        }

        Object.defineProperty(target, key, {
            value,
            enumerable: false,
            writable: true,
            configurable: true
        });
    }

    // 3. 使用 Proxy 监控对象操作
    const result = new Proxy(target, {
        get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);

            // 默认忽略 Symbol 属性的读取日志
            if (typeof key === "string") {
                const missing =
                    !Reflect.has(target, key) ||
                    (declared.has(key) && !implemented.has(key));

                if (missing) {
                    if (logMissing) {
                        console.warn(
                            `[${label}] 未实现属性读取: ${key}`
                        );
                    }
                } else if (logReads) {
                    console.log(
                        `[${label}] 读取了属性: ${key}, 取值为:`
                    );
                    console.dir(value);
                }
            }

            return value;
        },

        set(target, key, value, receiver) {
            const success = Reflect.set(
                target,
                key,
                value,
                receiver
            );

            if (success) {
                implemented.add(key);

                if (logWrites) {
                    console.log(
                        `[${label}] 设置了属性: ${String(key)}, 取值为:`
                    );
                    console.dir(value);
                }
            }

            return success;
        },

        ownKeys(target) {
            if (logEnumerations) {
                console.log(
                    `[${label}] 正在枚举对象属性`
                );
            }

            return Reflect.ownKeys(target);
        }
    });

    // 4. 处理自引用属性
    for (const key of selfReferences) {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
            target[key] = result;
        } else {
            Object.defineProperty(target, key, {
                value: result,
                enumerable: declared.has(key),
                writable: true,
                configurable: true
            });
        }

        implemented.add(key);
    }

    return result;
}

let SubtleCrypto = createObject(["supports"], {}, {label: "SubtleCrypto"});

let Crypto = createObject([], {subtle: SubtleCrypto}, {label: "Crypto"});

let localStorageKeys = ["__cuid", "volume", "rweb.recentUserIds"];
let LocalStorage = createObject(
    localStorageKeys,
    {
        "__cuid": "16c4f5b3-619c-4dad-b691-fb8712c1c250",
        "volume": "1",
        "rweb.recentUserIds": "AJDbOkpFjxo",
        getItem: (key) => {
            return LocalStorage[key];
        },

    },
    {label: "LocalStorage"}
)

let documentKeys = ["location", "__reactContainer$ja09zrggtkr", "_reactListeningnwd5d2ndxqe", "__sentry_instrumentation_handlers__", "__reactResources$ja09zrggtkr"]
let Document = createObject(
    documentKeys,
    {
        addEventListener: (eventName, func) => {
            console.log(`事件监听器添加, 事件名: ${eventName}, 回调函数:`);
            console.dir(func);

        },
        removeEventListener: (eventName, func) => {
            console.log(`事件监听器移除, 事件名: ${eventName}, 回调函数:`);
            console.dir(func);
        }
    },
    {label: "Document"}
)

let locationKeys = ["ancestorOrigins", "href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash", "assign", "reload", "replace", "toString"]
let Location = createObject(
    locationKeys,
    {
        hash: "",
        host: "x.com",
        hostname: "x.com",
        href: "https://x.com/",
        origin: "https://x.com",
        pathname: "/",
        port: "",
        protocol: "https:",
        search: ""
    },
    {label: "Location"}
);


let Navigator = createObject([], {}, {label: "Navigator"});

const windowKeys = ["0", "1", "window", "self", "document", "name", "location", "customElements", "history", "navigation", "locationbar", "menubar", "personalbar", "scrollbars", "statusbar", "toolbar", "status", "closed", "frames", "length", "top", "opener", "parent", "frameElement", "navigator", "origin", "external", "screen", "innerWidth", "innerHeight", "scrollX", "pageXOffset", "scrollY", "pageYOffset", "visualViewport", "screenX", "screenY", "outerWidth", "outerHeight", "devicePixelRatio", "onpagereveal", "event", "clientInformation", "screenLeft", "screenTop", "styleMedia", "onsearch", "onappinstalled", "onbeforeinstallprompt", "onabort", "onbeforeinput", "onbeforematch", "onbeforetoggle", "onblur", "oncancel", "oncanplay", "oncanplaythrough", "onchange", "onclick", "onclose", "oncommand", "oncontentvisibilityautostatechange", "oncontextlost", "oncontextmenu", "oncontextrestored", "oncuechange", "ondblclick", "ondrag", "ondragend", "ondragenter", "ondragleave", "ondragover", "ondragstart", "ondrop", "ondurationchange", "onemptied", "onended", "onerror", "onfocus", "onformdata", "oninput", "oninvalid", "onkeydown", "onkeypress", "onkeyup", "onload", "onloadeddata", "onloadedmetadata", "onloadstart", "onmousedown", "onmouseenter", "onmouseleave", "onmousemove", "onmouseout", "onmouseover", "onmouseup", "onmousewheel", "onpause", "onplay", "onplaying", "onprogress", "onratechange", "onreset", "onresize", "onscroll", "onscrollend", "onsecuritypolicyviolation", "onseeked", "onseeking", "onselect", "onslotchange", "onstalled", "onsubmit", "onsuspend", "ontimeupdate", "ontoggle", "onvolumechange", "onwaiting", "onwebkitanimationend", "onwebkitanimationiteration", "onwebkitanimationstart", "onwebkittransitionend", "onwheel", "onauxclick", "ongotpointercapture", "onlostpointercapture", "onpointerdown", "onpointermove", "onpointerup", "onpointercancel", "onpointerover", "onpointerout", "onpointerenter", "onpointerleave", "onselectstart", "onselectionchange", "onanimationcancel", "onanimationend", "onanimationiteration", "onanimationstart", "ontransitionrun", "ontransitionstart", "ontransitionend", "ontransitioncancel", "onbeforexrselect", "onafterprint", "onbeforeprint", "onbeforeunload", "onhashchange", "onlanguagechange", "onmessage", "onmessageerror", "onoffline", "ononline", "onpagehide", "onpageshow", "onpopstate", "onrejectionhandled", "onstorage", "onunhandledrejection", "onunload", "isSecureContext", "crossOriginIsolated", "scheduler", "performance", "trustedTypes", "crypto", "indexedDB", "localStorage", "sessionStorage", "alert", "atob", "blur", "btoa", "cancelAnimationFrame", "cancelIdleCallback", "captureEvents", "clearInterval", "clearTimeout", "close", "confirm", "createImageBitmap", "fetch", "find", "focus", "getComputedStyle", "getSelection", "matchMedia", "moveBy", "moveTo", "open", "postMessage", "print", "prompt", "queueMicrotask", "releaseEvents", "reportError", "requestAnimationFrame", "requestIdleCallback", "resizeBy", "resizeTo", "scroll", "scrollBy", "scrollTo", "setInterval", "setTimeout", "stop", "structuredClone", "webkitCancelAnimationFrame", "webkitRequestAnimationFrame", "chrome", "crashReport", "cookieStore", "ondevicemotion", "ondeviceorientation", "ondeviceorientationabsolute", "onpointerrawupdate", "caches", "documentPictureInPicture", "fetchLater", "getScreenDetails", "queryLocalFonts", "showDirectoryPicker", "showOpenFilePicker", "showSaveFilePicker", "originAgentCluster", "viewport", "onpageswap", "credentialless", "fence", "launchQueue", "speechSynthesis", "onscrollsnapchange", "onscrollsnapchanging", "ongamepadconnected", "ongamepaddisconnected", "requestResize", "webkitRequestFileSystem", "webkitResolveLocalFileSystemURL", "__VUE_DEVTOOLS_COMPONENT_INSPECTOR_ENABLED__", "__VUE_DEVTOOLS_KIT_TIMELINE_LAYERS", "__VUE_DEVTOOLS_KIT_INSPECTOR__", "__VUE_DEVTOOLS_KIT_APP_RECORDS__", "__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD__", "__VUE_DEVTOOLS_KIT_ACTIVE_APP_RECORD_ID__", "__VUE_DEVTOOLS_KIT_CUSTOM_TABS__", "__VUE_DEVTOOLS_KIT_CUSTOM_COMMANDS__", "__VUE_DEVTOOLS_KIT_GLOBAL_STATE__", "__VUE_DEVTOOLS_KIT_PLUGIN_BUFFER__", "__VUE_DEVTOOLS_HOOK", "__VUE_DEVTOOLS_KIT__REGISTERED_PLUGIN_APPS__", "__VUE_DEVTOOLS_ROUTER_INFO__", "__VUE_DEVTOOLS_ROUTER__", "__VUE_DEVTOOLS_ENV__", "__VUE_DEVTOOLS_KIT_CONTEXT__", "__VUE_DEVTOOLS_NEXT_APP_RECORD_INFO__", "__VUE_DEVTOOLS_UPDATE_CLIENT_DETECTED__", "__VUE_DEVTOOLS_KIT_MESSAGE_CHANNELS__", "__VUE_DEVTOOLS_KIT_RPC_CLIENT__", "__VUE_DEVTOOLS_KIT_RPC_SERVER__", "__VUE_DEVTOOLS_KIT_VITE_RPC_CLIENT__", "__VUE_DEVTOOLS_KIT_VITE_RPC_SERVER__", "__VUE_DEVTOOLS_KIT_BROADCAST_RPC_SERVER__", "__VUE_DEVTOOLS_BROWSER_EXTENSION_DETECTED__", "__xClientTextFormatters", "__INITIAL_DATA__", "$R", "_sentryDebugIds", "_sentryDebugIdIdentifier", "__SENTRY__", "__sentry_instrumentation_handlers__", "_sentryWrappedDepth", "__REACT_DEVTOOLS_BACKEND_MANAGER_INJECTED__", "AppleID", "default_gsi", "_F_toggles_default_gsi", "google", "__G_ID_CLIENT__", "closure_lm_734508"];
const Window = createObject(
    windowKeys,
    {
        document: Document,
        location: Location,
        navigator: Navigator,
        crypto: Crypto,
        localStorage: LocalStorage,
        Error: Error
    },
    {
        label: "Window",
        selfReferences: ["self", "window"]
    }
);

export {Window}