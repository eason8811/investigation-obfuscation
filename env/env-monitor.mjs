/**
 * 监控一个对象的方法调用
 *
 * 注意：会修改对象的可观察方法属性，
 * 仅建议在调试模式中使用。
 */
export function monitorMethod(obj, methodName, label) {
    const original = obj[methodName];

    if (typeof original !== "function") {
        console.warn(
            `[Monitor] ${label}.${methodName} 不是函数`
        );

        return false;
    }

    Object.defineProperty(obj, methodName, {
        configurable: true,
        writable: true,
        enumerable: false,

        value: function (...args) {
            console.log(
                `[${label}] 调用方法: ${methodName}`
            );

            console.dir(args);

            console.trace(
                `[${label}.${methodName}] 调用栈`
            );

            try {
                const result = Reflect.apply(original, this, args);

                console.log(
                    `[${label}.${methodName}] 返回值类型:`,
                    {
                        type: typeof result,
                        constructor: result?.constructor?.name,
                        isNull: result === null,
                        isUndefined: result === undefined
                    }
                );

                return result;

            } catch (error) {
                console.error(
                    `[${label}.${methodName}] 调用异常:`,
                    error
                );

                throw error;
            }
        }
    });

    return true;
}

export function monitorLifecycle(window) {
    const document = window.document;

    console.log("[Lifecycle] 初始状态:", document.readyState);

    document.addEventListener("readystatechange", () => {
        console.log(
            "[Lifecycle] readystatechange:",
            document.readyState
        );
    });

    window.addEventListener("load", () => {
        console.log("[Lifecycle] window.load");
    });

    window.addEventListener("pageshow", () => {
        console.log("[Lifecycle] window.pageshow");
    });
}