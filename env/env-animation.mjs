/**
 * 针对 Sign SDK 的 Web Animations -> getComputedStyle 补环境。
 *
 * Happy DOM 的 Animation.currentTime 可以变化，但部分版本未把动画采样结果
 * 合并进 getComputedStyle。这里不模拟整个 CSS/WAAPI：只计算 rgb/hex 颜色与
 * rotate(deg) 的两端插值，保留原始 CSSStyleDeclaration 的其余能力。
 *
 * 不读取业务 DOM、不会改变 Animation.currentTime、也不会修改 SDK 源码。
 */

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function interpolate(start, end, progress) {
  return start + (end - start) * progress;
}

function cubicBezierCoordinate(t, p1, p2) {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * p1 + 3 * inverse * t * t * p2 + t * t * t;
}

/** CSS cubic-bezier(x1,y1,x2,y2)：反解 X，再在 Y 轴取值。Y 不裁剪。 */
export function evaluateEasing(easing, progress) {
  if (!Number.isFinite(progress)) return null;
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const name = String(easing || "linear").trim().toLowerCase();
  if (name === "linear") return progress;
  const match = /^cubic-bezier\(\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*,\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*\)$/i.exec(name);
  if (!match) return null;
  const [, x1, y1, x2, y2] = match.map(Number);
  if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 60; index++) {
    const mid = (low + high) / 2;
    if (cubicBezierCoordinate(mid, x1, x2) < progress) low = mid;
    else high = mid;
  }
  return cubicBezierCoordinate((low + high) / 2, y1, y2);
}

function expandIndexedKeyframes(input) {
  if (Array.isArray(input)) return input.map(frame => ({...frame}));
  if (!input || typeof input !== "object") return [];
  const colors = Array.isArray(input.color) ? input.color : [input.color];
  const transforms = Array.isArray(input.transform) ? input.transform : [input.transform];
  const length = Math.max(colors.length, transforms.length);
  if (length < 2) return [];
  const result = [];
  for (let index = 0; index < length; index++) {
    result.push({
      color: colors[index] ?? colors[colors.length - 1],
      transform: transforms[index] ?? transforms[transforms.length - 1],
      easing: Array.isArray(input.easing)
        ? input.easing[index] ?? "linear"
        : input.easing ?? "linear",
      offset: Array.isArray(input.offset) ? input.offset[index] : undefined
    });
  }
  return result;
}

/** 同时接受数组形式与 property-indexed 形式。 */
export function normalizeKeyframes(input) {
  const frames = expandIndexedKeyframes(input);
  if (frames.length < 2) return null;

  const offsets = frames.map((frame, index) => {
    const given = frame.computedOffset ?? frame.offset;
    if (given === null || given === undefined) {
      if (index === 0) return 0;
      if (index === frames.length - 1) return 1;
      return null;
    }
    const number = finiteNumber(given);
    return number !== null && number >= 0 && number <= 1 ? number : NaN;
  });
  if (offsets.some(Number.isNaN)) return null;
  for (let start = 0; start < offsets.length - 1;) {
    let end = start + 1;
    while (end < offsets.length && offsets[end] === null) end++;
    if (end >= offsets.length || offsets[end] < offsets[start]) return null;
    for (let cursor = start + 1; cursor < end; cursor++) {
      offsets[cursor] = interpolate(offsets[start], offsets[end], (cursor - start) / (end - start));
    }
    start = end;
  }
  return frames.map((frame, index) => ({
    color: frame.color,
    transform: frame.transform,
    easing: frame.easing ?? "linear",
    offset: offsets[index]
  }));
}

function parseColor(input) {
  const string = String(input ?? "").trim();
  let digits = /^#([0-9a-f]{6})$/i.exec(string)?.[1];
  if (digits) return [0, 2, 4].map(index => Number.parseInt(digits.slice(index, index + 2), 16));
  digits = /^#([0-9a-f]{3})$/i.exec(string)?.[1];
  if (digits) return [...digits].map(char => Number.parseInt(char + char, 16));
  const rgb = /^rgb\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)$/i.exec(string);
  if (!rgb) return null;
  const values = rgb.slice(1).map(Number);
  return values.every(value => value >= 0 && value <= 255) ? values : null;
}

function parseRotate(input) {
  const match = /^rotate\(\s*([+-]?(?:\d+\.?\d*|\.\d+))deg\s*\)$/i.exec(String(input ?? "").trim());
  return match ? finiteNumber(match[1]) : null;
}

function formatMatrix(angle) {
  const radians = angle * Math.PI / 180;
  const clean = value => Number(value.toFixed(6)) || 0;
  const cosine = clean(Math.cos(radians));
  const sine = clean(Math.sin(radians));
  return `matrix(${cosine}, ${sine}, ${clean(-Math.sin(radians))}, ${cosine}, 0, 0)`;
}

/**
 * 纯函数采样器；不依赖 Happy DOM，可单独使用浏览器采样数据验证。
 * 不支持的 CSS 值或 easing 返回 null，防止静默构造错误结果。
 */
export function sampleAnimationAtTime({keyframes, timing, currentTime}) {
  const frames = normalizeKeyframes(keyframes);
  const duration = finiteNumber(typeof timing === "number" ? timing : timing?.duration);
  const time = finiteNumber(currentTime);
  if (!frames || duration === null || duration <= 0 || time === null) return null;

  const settings = typeof timing === "number" ? {} : (timing ?? {});
  const delay = finiteNumber(settings.delay ?? 0);
  const iterations = finiteNumber(settings.iterations ?? 1);
  if (delay === null || iterations !== 1 || settings.direction && settings.direction !== "normal") return null;
  const active = (time - delay) / duration;
  const fill = settings.fill ?? "auto";
  if ((active < 0 && fill !== "backwards" && fill !== "both") ||
      (active > 1 && fill !== "forwards" && fill !== "both")) return null;
  const progress = Math.max(0, Math.min(1, active));
  const globalProgress = evaluateEasing(settings.easing ?? "linear", progress);
  if (globalProgress === null) return null;

  let index = frames.length - 2;
  for (let cursor = 0; cursor < frames.length - 1; cursor++) {
    if (globalProgress <= frames[cursor + 1].offset) {
      index = cursor;
      break;
    }
  }
  const start = frames[index];
  const end = frames[index + 1];
  const span = end.offset - start.offset;
  const localProgress = span === 0 ? 1 : (globalProgress - start.offset) / span;
  const easedProgress = evaluateEasing(start.easing, Math.max(0, Math.min(1, localProgress)));
  if (easedProgress === null) return null;

  const fromColor = parseColor(start.color);
  const toColor = parseColor(end.color);
  const fromAngle = parseRotate(start.transform);
  const toAngle = parseRotate(end.transform);
  if (!fromColor || !toColor || fromAngle === null || toAngle === null) return null;

  const color = `rgb(${fromColor.map((channel, position) =>
    Math.max(0, Math.min(255, Math.round(interpolate(channel, toColor[position], easedProgress))))
  ).join(", ")})`;
  const transform = formatMatrix(interpolate(fromAngle, toAngle, easedProgress));

  return {
    currentTime: time,
    duration,
    progress,
    easedProgress,
    color,
    transform
  };
}

function overlayComputedStyle(style, sample) {
  return new Proxy(style, {
    get(target, property) {
      if (property === "color") return sample.color;
      if (property === "transform") return sample.transform;
      if (property === "getPropertyValue") {
        return function (name) {
          if (name === "color") return sample.color;
          if (name === "transform") return sample.transform;
          return target.getPropertyValue(name);
        };
      }
      // CSSStyleDeclaration 的 getter 可能要求正确的 this。使用真实目标接收者。
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/**
 * 安装指定窗口的适配器。返回 restore()，供单元测试或复用同进程时撤销。
 * onCreate/onSample 只做诊断；异常不会改变 SDK 的执行结果。
 */
export function installAnimationComputedStyleBridge(window, {onCreate, onSample, onUnsupported} = {}) {
  const prototype = window.Element?.prototype;
  const originalAnimate = prototype?.animate;
  const originalStyle = window.getComputedStyle;
  if (typeof originalAnimate !== "function" || typeof originalStyle !== "function") {
    throw new TypeError("动画适配器要求 Element.animate 和 window.getComputedStyle 都存在");
  }
  const animateDescriptor = Object.getOwnPropertyDescriptor(prototype, "animate");
  const styleDescriptor = Object.getOwnPropertyDescriptor(window, "getComputedStyle");
  if (animateDescriptor?.configurable === false || styleDescriptor?.configurable === false) {
    throw new TypeError("动画适配器无法覆盖不可配置的方法");
  }

  const byElement = new WeakMap();
  const safeReport = (listener, payload) => {
    try { listener?.(payload); } catch { /* 诊断不干扰 SDK */ }
  };

  Object.defineProperty(prototype, "animate", {
    configurable: true,
    writable: true,
    enumerable: animateDescriptor?.enumerable ?? false,
    value: function (...args) {
      const animation = Reflect.apply(originalAnimate, this, args);
      const record = {animation, keyframes: args[0], timing: args[1]};
      const list = byElement.get(this) ?? [];
      list.push(record);
      byElement.set(this, list);
      safeReport(onCreate, {
        element: this.tagName ?? null,
        keyframes: normalizeKeyframes(args[0]),
        timing: args[1],
        animationType: animation?.constructor?.name ?? null
      });
      return animation;
    }
  });

  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    writable: true,
    enumerable: styleDescriptor?.enumerable ?? false,
    value: function (...args) {
      const style = Reflect.apply(originalStyle, this, args);
      if (args[1]) return style; // 伪元素保留原状
      const records = byElement.get(args[0]);
      if (!records?.length) return style;
      for (let index = records.length - 1; index >= 0; index--) {
        const {animation, keyframes, timing} = records[index];
        if (animation?.playState === "idle" || animation?.effect === null) continue;
        const effectiveTiming = animation?.effect?.getTiming?.() ?? timing;
        const sample = sampleAnimationAtTime({
          keyframes,
          timing: effectiveTiming,
          currentTime: animation?.currentTime
        });
        if (!sample) {
          safeReport(onUnsupported, {
            element: args[0]?.tagName ?? null,
            currentTime: animation?.currentTime ?? null,
            reason: "不支持的关键帧/时间参数，或动画当前不生效"
          });
          continue;
        }
        safeReport(onSample, {element: args[0]?.tagName ?? null, ...sample});
        return overlayComputedStyle(style, sample);
      }
      return style;
    }
  });

  return function restore() {
    if (animateDescriptor) Object.defineProperty(prototype, "animate", animateDescriptor);
    else delete prototype.animate;
    if (styleDescriptor) Object.defineProperty(window, "getComputedStyle", styleDescriptor);
    else delete window.getComputedStyle;
  };
}
