import {performance as nodePerformance} from "node:perf_hooks";
import v8 from "node:v8";

/**
 * 创建面向调试的 Browser Performance 环境
 *
 * 真实运行：now() 使用 Node 的单调高精度计时器；mark/measure 使用本地时间线
 * 可配置快照：memory、旧版 timing/navigation、interactionCount/eventCounts
 *
 * 本模块模拟可观察的常见 API 行为，不等同于 Chromium 原生 Performance
 */
export function createBrowserPerformance(
    {
        timeOrigin = Date.now() - 500,
        memorySnapshot = {
            jsHeapSizeLimit: 4395630592,
            totalJSHeapSize: 70664970,
            usedJSHeapSize: 69011066
        },
        memoryMode = "snapshot", // "snapshot" 或 "node"
        timingSnapshot = null,
        navigationSnapshot = {type: 0, redirectCount: 0},
        interactionCount = 0,
        eventCounts = new Map(),
        navigationEntries = [],
        log = false
    } = {}
) {
    if (memoryMode !== "snapshot" && memoryMode !== "node") {
        throw new TypeError("memoryMode must be 'snapshot' or 'node'");
    }

    const clockStart = nodePerformance.now();
    const elapsedAtCreation = Math.max(0, Date.now() - timeOrigin);
    const currentNow = () => elapsedAtCreation + nodePerformance.now() - clockStart;
    const entries = navigationEntries.map(entry => ({...entry}));

    function readMemory() {
        if (memoryMode === "snapshot") return memorySnapshot;
        const heap = v8.getHeapStatistics();
        return {
            jsHeapSizeLimit: heap.heap_size_limit,
            totalJSHeapSize: heap.total_heap_size,
            usedJSHeapSize: heap.used_heap_size
        };
    }

    function typePrototype(tag, properties) {
        const proto = Object.create(Object.prototype);
        Object.defineProperties(proto, properties);
        Object.defineProperty(proto, Symbol.toStringTag, {
            value: tag, configurable: true
        });
        return proto;
    }

    function getter(get) {
        return {get, enumerable: true, configurable: true};
    }

    function method(value) {
        return {value, writable: true, enumerable: true, configurable: true};
    }

    const memoryProto = typePrototype("MemoryInfo", {
        jsHeapSizeLimit: getter(() => readMemory().jsHeapSizeLimit),
        totalJSHeapSize: getter(() => readMemory().totalJSHeapSize),
        usedJSHeapSize: getter(() => readMemory().usedJSHeapSize)
    });
    const memory = Object.create(memoryProto);

    // performance.timing 的值为 Unix 毫秒，而 performance.now() 是相对毫秒。
    const legacyTimingKeys = [
        "navigationStart", "unloadEventStart", "unloadEventEnd", "redirectStart", "redirectEnd",
        "fetchStart", "domainLookupStart", "domainLookupEnd", "connectStart", "connectEnd",
        "secureConnectionStart", "requestStart", "responseStart", "responseEnd",
        "domLoading", "domInteractive", "domContentLoadedEventStart", "domContentLoadedEventEnd",
        "domComplete", "loadEventStart", "loadEventEnd"
    ];
    const oldOrigin = Number(timingSnapshot?.navigationStart);
    const hasOldOrigin = Number.isFinite(oldOrigin) && oldOrigin > 0;
    const timingValues = {};
    for (const name of legacyTimingKeys) {
        if (name === "navigationStart") {
            timingValues[name] = Math.round(timeOrigin);
            continue;
        }
        const oldValue = Number(timingSnapshot?.[name]);
        timingValues[name] = hasOldOrigin && Number.isFinite(oldValue) && oldValue > 0
            ? Math.round(timeOrigin + oldValue - oldOrigin)
            : 0;
    }
    const timingDescriptors = Object.fromEntries(
        legacyTimingKeys.map(name => [name, getter(() => timingValues[name])])
    );
    timingDescriptors.toJSON = method(function toJSON() {
        return {...timingValues};
    });
    const timing = Object.create(typePrototype("PerformanceTiming", timingDescriptors));

    const navigation = Object.create(typePrototype("PerformanceNavigation", {
        type: getter(() => Number(navigationSnapshot.type ?? 0)),
        redirectCount: getter(() => Number(navigationSnapshot.redirectCount ?? 0)),
        toJSON: method(function toJSON() {
            return {
                type: Number(navigationSnapshot.type ?? 0),
                redirectCount: Number(navigationSnapshot.redirectCount ?? 0)
            };
        })
    }));

    function makeEntry(name, entryType, startTime, duration) {
        const values = {name, entryType, startTime, duration};
        return Object.freeze({
            ...values,
            toJSON() {
                return {...values};
            }
        });
    }

    function sortedEntries() {
        return [...entries].sort((a, b) => a.startTime - b.startTime);
    }

    function latestMark(name) {
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].entryType === "mark" && entries[i].name === name) {
                return entries[i].startTime;
            }
        }
        throw new DOMException(`Mark '${name}' does not exist`, "SyntaxError");
    }

    function Performance() {
        throw new TypeError("Illegal constructor");
    }

    let onResourceTimingBufferFull = null;
    const proto = typePrototype("Performance", {
        clearMarks: method(function clearMarks(name) {
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].entryType === "mark" && (name === undefined || entries[i].name === String(name))) {
                    entries.splice(i, 1);
                }
            }
        }),
        clearMeasures: method(function clearMeasures(name) {
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].entryType === "measure" && (name === undefined || entries[i].name === String(name))) {
                    entries.splice(i, 1);
                }
            }
        }),
        clearResourceTimings: method(function clearResourceTimings() {
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].entryType === "resource") entries.splice(i, 1);
            }
        }),
        eventCounts: getter(() => eventCounts),
        getEntries: method(function getEntries() {
            return sortedEntries();
        }),
        getEntriesByName: method(function getEntriesByName(name, type) {
            return sortedEntries().filter(e =>
                e.name === String(name) && (type === undefined || e.entryType === String(type))
            );
        }),
        getEntriesByType: method(function getEntriesByType(type) {
            return sortedEntries().filter(e => e.entryType === String(type));
        }),
        interactionCount: getter(() => interactionCount),
        mark: method(function mark(name, options = {}) {
            if (arguments.length === 0) throw new TypeError("1 argument required");
            const startTime = options?.startTime ?? currentNow();
            const entry = makeEntry(String(name), "mark", startTime, 0);
            entries.push(entry);
            return entry;
        }),
        measure: method(function measure(name, startOrOptions, endMark) {
            if (arguments.length === 0) throw new TypeError("1 argument required");
            let startTime = 0;
            let endTime = currentNow();
            if (typeof startOrOptions === "string") {
                startTime = latestMark(startOrOptions);
                if (endMark !== undefined) endTime = latestMark(String(endMark));
            } else if (startOrOptions && typeof startOrOptions === "object") {
                const resolve = value => typeof value === "string" ? latestMark(value) : Number(value);
                if (startOrOptions.start !== undefined) startTime = resolve(startOrOptions.start);
                if (startOrOptions.end !== undefined) endTime = resolve(startOrOptions.end);
                if (startOrOptions.duration !== undefined) {
                    if (startOrOptions.end !== undefined && startOrOptions.start === undefined) {
                        startTime = endTime - Number(startOrOptions.duration);
                    } else {
                        endTime = startTime + Number(startOrOptions.duration);
                    }
                }
            }
            const entry = makeEntry(String(name), "measure", startTime, endTime - startTime);
            entries.push(entry);
            return entry;
        }),
        memory: getter(() => memory),
        navigation: getter(() => navigation),
        now: method(function now() {
            return currentNow();
        }),
        onresourcetimingbufferfull: {
            get() {
                return onResourceTimingBufferFull;
            },
            set(value) {
                onResourceTimingBufferFull = value;
            },
            enumerable: true,
            configurable: true
        },
        setResourceTimingBufferSize: method(function setResourceTimingBufferSize(size) {
            if (!Number.isFinite(Number(size)) || Number(size) < 0) {
                throw new TypeError("Invalid resource timing buffer size");
            }
        }),
        timeOrigin: getter(() => timeOrigin),
        timing: getter(() => timing),
        toJSON: method(function toJSON() {
            return {timeOrigin, timing: timing.toJSON(), navigation: navigation.toJSON()};
        })
    });
    Object.defineProperty(proto, "constructor", {
        value: Performance,
        configurable: true,
        writable: true
    });
    Performance.prototype = proto;

    const target = Object.create(Performance.prototype);
    const performance = log ? new Proxy(target, {
        get(t, key, receiver) {
            console.log(`[Performance] 读取: ${String(key)}`);
            return Reflect.get(t, key, receiver);
        },
        set(t, key, value, receiver) {
            console.log(`[Performance] 设置: ${String(key)}`);
            return Reflect.set(t, key, value, receiver);
        },
        ownKeys(t) {
            console.log("[Performance] 枚举自身属性");
            return Reflect.ownKeys(t);
        }
    }) : target;

    return {performance, constructors: {Performance}, memory, timing, navigation};
}
