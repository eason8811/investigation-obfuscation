// env/env-monitor.mjs

const monitorRecords = [];

/**
 * 将值转换为适合日志输出的简短表示
 */
function summarizeValue(value) {
  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return "[undefined]";
  }

  const type = typeof value;

  if (type === "string") {
    // 不输出完整的 Base64 图像数据
    if (value.startsWith("data:")) {
      return `[DataURL length=${value.length}]`;
    }

    if (value.length > 120) {
      return `${value.slice(0, 120)}... [length=${value.length}]`;
    }

    return value;
  }

  if (type === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (type === "symbol") {
    return value.toString();
  }

  if (type === "bigint") {
    return `${value}n`;
  }

  if (type !== "object") {
    return value;
  }

  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name} bytes=${value.byteLength}]`;
  }

  if (Array.isArray(value)) {
    return `[Array length=${value.length}]`;
  }

  try {
    return `[${value.constructor?.name ?? "Object"}]`;
  } catch {
    return "[Object]";
  }
}

/**
 * 监控一个对象的方法
 *
 * @param {object} obj
 * @param {string} methodName
 * @param {string} label
 * @param {object} options
 * @returns {Function|null} 恢复原方法的函数
 */
export function monitorMethod(
  obj,
  methodName,
  label,
  options = {}
) {
  const {
    args = "all",
    result = true,
    traceFirst = 0,
    maxLogs = Infinity,
    every = 1,
    onRecord
  } = options;

  const original = obj[methodName];

  if (typeof original !== "function") {
    console.warn(
      `[Monitor] ${label}.${methodName} 不是函数`
    );
    return null;
  }

  const originalDescriptor =
    Object.getOwnPropertyDescriptor(obj, methodName);

  if (originalDescriptor?.configurable === false) {
    console.warn(
      `[Monitor] ${label}.${methodName} 不可重新定义`
    );
    return null;
  }

  const stats = {
    method: `${label}.${methodName}`,
    calls: 0,
    errors: 0,
    logged: 0
  };

  monitorRecords.push(stats);

  const wrapper = function (...methodArgs) {
    stats.calls++;

    const shouldLog =
      stats.logged < maxLogs &&
      (stats.calls - 1) % Math.max(1, every) === 0;

    if (shouldLog) {
      stats.logged++;

      let formattedArgs;

      if (args === "first") {
        formattedArgs = summarizeValue(methodArgs[0]);
      } else if (args === "all") {
        formattedArgs = methodArgs.map(summarizeValue);
      }

      if (args === "none") {
        console.log(
          `[${stats.method}] #${stats.calls}`
        );
      } else {
        console.log(
          `[${stats.method}] #${stats.calls} args:`,
          formattedArgs
        );
      }

      if (stats.calls <= traceFirst) {
        console.trace(
          `[${stats.method}] 调用栈`
        );
      }
    }

    try {
      const returnValue = Reflect.apply(
        original,
        this,
        methodArgs
      );

      if (shouldLog && result) {
        console.log(
          `  返回:`,
          summarizeValue(returnValue)
        );
      }

      try {
        options.onRecord?.({
          method: stats.method,
          call: stats.calls,
          args: methodArgs.map(summarizeValue),
          result: summarizeValue(returnValue)
        });
      } catch (monitorError) {
        console.error(
          "[Monitor] 结构化日志记录失败:",
          monitorError
        );
      }

      return returnValue;

    } catch (error) {
      stats.errors++;

      // 异常始终记录，不受 maxLogs 限制
      console.error(
        `[${stats.method}] 调用异常:`,
        error
      );

      throw error;
    }
  };

  Object.defineProperty(obj, methodName, {
    configurable: true,
    writable: true,
    enumerable: originalDescriptor?.enumerable ?? false,
    value: wrapper
  });

  // 恢复函数
  return function restore() {
    if (originalDescriptor) {
      Object.defineProperty(
        obj,
        methodName,
        originalDescriptor
      );
    } else {
      delete obj[methodName];
    }
  };
}

/**
 * 输出监控汇总
 */
export function printMonitorSummary() {
  console.log("\n[Monitor] 调用统计:");

  console.table(
    monitorRecords.map(record => ({
      method: record.method,
      calls: record.calls,
      errors: record.errors,
      logged: record.logged
    }))
  );
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