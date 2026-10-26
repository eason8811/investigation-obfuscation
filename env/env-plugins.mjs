/**
 * 根据 Chrome/HTML 标准的 PDF 插件兼容接口构造 Node.js 环境对象
 *
 * 已对齐用户的浏览器快照：四类对象的直接原型属性顺序、枚举标志、
 * 描述符类型、可写/可配置标志、Symbol.iterator 和 Symbol.toStringTag
 *
 * 局限：这是 JavaScript 模拟实现，不具备浏览器 Web IDL 的原生内部插槽、
 * 原生函数源码表现，也不完全模拟所有 Web IDL 参数转换与异常消息
 */
export function createPdfPluginEnvironment({
                                               log = false,
                                               pdfViewerEnabled = true
                                           } = {}) {
    const states = new WeakMap();

    function state(receiver, Ctor) {
        const value = states.get(receiver);
        if (!value || !(receiver instanceof Ctor)) {
            throw new TypeError("Illegal invocation");
        }
        return value;
    }

    // Chrome 将这些接口暴露为构造函数，但它们无法通过 new 直接实例化。
    function PluginArray() {
        throw new TypeError("Illegal constructor");
    }

    function Plugin() {
        throw new TypeError("Illegal constructor");
    }

    function MimeTypeArray() {
        throw new TypeError("Illegal constructor");
    }

    function MimeType() {
        throw new TypeError("Illegal constructor");
    }

    const accessor = getter => {
        Object.defineProperty(getter, "name", {
            value: `get ${getter.name}`,
            configurable: true
        });
        return {
            get: getter,
            set: undefined,
            enumerable: true,
            configurable: true
        };
    };
    const method = value => ({
        value,
        writable: true,
        enumerable: true,
        configurable: true
    });

    function selectItem(items, index, argc) {
        if (!argc) throw new TypeError("1 argument required");
        // 模拟 Web IDL unsigned long 的常见转换场景。
        return items[Number(index) >>> 0] ?? null;
    }

    function selectNamedItem(items, name, argc, nameGetter) {
        if (!argc) throw new TypeError("1 argument required");
        return items.find(value => nameGetter(value) === String(name)) ?? null;
    }

    function installPrototype(Ctor, props, iterable = false) {
        // 重新创建原型，使 Reflect.ownKeys() 顺序与浏览器快照一致。
        const proto = Object.create(Object.prototype);
        Object.defineProperties(proto, props);

        Object.defineProperty(proto, "constructor", {
            value: Ctor,
            writable: true,
            configurable: true,
            enumerable: false
        });

        Object.defineProperty(proto, Symbol.toStringTag, {
            value: Ctor.name,
            writable: false,
            configurable: true,
            enumerable: false
        });

        if (iterable) {
            Object.defineProperty(proto, Symbol.iterator, {
                value: function values() {
                    return state(this, Ctor).items[Symbol.iterator]();
                },
                writable: true,
                configurable: true,
                enumerable: false
            });
        }

        Ctor.prototype = proto;
    }

    installPrototype(PluginArray, {
        length: accessor(function length() {
            return state(this, PluginArray).items.length;
        }),
        item: method(function item(index) {
            return selectItem(state(this, PluginArray).items, index, arguments.length);
        }),
        namedItem: method(function namedItem(name) {
            return selectNamedItem(state(this, PluginArray).items, name, arguments.length, p => p.name);
        }),
        refresh: method(function refresh() {
        })
    }, true);

    installPrototype(Plugin, {
        name: accessor(function name() {
            return state(this, Plugin).name;
        }),
        filename: accessor(function filename() {
            state(this, Plugin);
            return "internal-pdf-viewer";
        }),
        description: accessor(function description() {
            state(this, Plugin);
            return "Portable Document Format";
        }),
        length: accessor(function length() {
            return state(this, Plugin).items.length;
        }),
        item: method(function item(index) {
            return selectItem(state(this, Plugin).items, index, arguments.length);
        }),
        namedItem: method(function namedItem(name) {
            return selectNamedItem(state(this, Plugin).items, name, arguments.length, m => m.type);
        })
    }, true);

    installPrototype(MimeTypeArray, {
        length: accessor(function length() {
            return state(this, MimeTypeArray).items.length;
        }),
        item: method(function item(index) {
            return selectItem(state(this, MimeTypeArray).items, index, arguments.length);
        }),
        namedItem: method(function namedItem(name) {
            return selectNamedItem(state(this, MimeTypeArray).items, name, arguments.length, m => m.type);
        })
    }, true);

    installPrototype(MimeType, {
        type: accessor(function type() {
            return state(this, MimeType).type;
        }),
        suffixes: accessor(function suffixes() {
            state(this, MimeType);
            return "pdf";
        }),
        description: accessor(function description() {
            state(this, MimeType);
            return "Portable Document Format";
        }),
        enabledPlugin: accessor(function enabledPlugin() {
            return state(this, MimeType).enabledPlugin;
        })
    });

    function create(Ctor, label, data) {
        const target = Object.create(Ctor.prototype);
        states.set(target, data);

        if (!log) return target;

        const proxy = new Proxy(target, {
            get(t, key, receiver) {
                let value = Reflect.get(t, key, receiver);
                console.log(`[${label}] 读取: ${String(key)}`);
                console.dir(value);
                return value;
            },
            set(t, key, value, receiver) {
                console.log(`[${label}] 设置: ${String(key)} 值为:`);
                console.dir(value)
                return Reflect.set(t, key, value, receiver);
            },
            ownKeys(t) {
                console.log(`[${label}] 枚举属性`);
                return Reflect.ownKeys(t);
            }
        });
        // getter 和原型方法以 Proxy 为 this 时也应通过接口校验。
        states.set(proxy, data);
        return proxy;
    }

    function installAliases(target, items, nameOf) {
        items.forEach((value, index) => {
            Object.defineProperty(target, String(index), {
                value,
                enumerable: true,
                configurable: true,
                writable: false
            });
            Object.defineProperty(target, nameOf(value), {
                value,
                enumerable: false,
                configurable: true,
                writable: false
            });
        });
    }

    const mimeTypesList = (pdfViewerEnabled ? ["application/pdf", "text/pdf"] : [])
        .map(type => create(MimeType, `MimeType:${type}`, {
            type,
            enabledPlugin: null
        }));

    const pluginNames = pdfViewerEnabled ? [
        "PDF Viewer",
        "Chrome PDF Viewer",
        "Chromium PDF Viewer",
        "Microsoft Edge PDF Viewer",
        "WebKit built-in PDF"
    ] : [];

    const pluginsList = pluginNames.map(name => {
        const plugin = create(Plugin, `Plugin:${name}`, {
            name,
            items: mimeTypesList
        });
        installAliases(plugin, mimeTypesList, m => m.type);
        return plugin;
    });

    // 标准规定所有 MIME 对象的 enabledPlugin 为通用 PDF Viewer。
    for (const mime of mimeTypesList) {
        state(mime, MimeType).enabledPlugin = pluginsList[0];
    }

    const plugins = create(PluginArray, "PluginArray", {items: pluginsList});
    const mimeTypes = create(MimeTypeArray, "MimeTypeArray", {items: mimeTypesList});
    installAliases(plugins, pluginsList, p => p.name);
    installAliases(mimeTypes, mimeTypesList, m => m.type);

    return {
        plugins,
        mimeTypes,
        pdfViewerEnabled: Boolean(pdfViewerEnabled),
        constructors: {PluginArray, Plugin, MimeTypeArray, MimeType}
    };
}
