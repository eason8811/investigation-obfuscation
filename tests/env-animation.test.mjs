import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateEasing,
  normalizeKeyframes,
  sampleAnimationAtTime,
  installAnimationComputedStyleBridge
} from "../env/env-animation.mjs";

// 用户在真实 Chromium 中独立运行 Element.animate + pause + currentTime
// 采集的 6 组基准（duration=4096，局部 easing 有负 Y 控制点）。
const browserKeyframes = [
  {
    color: "rgb(38, 20, 53)",
    transform: "rotate(0deg)",
    easing: "cubic-bezier(0.63, 0.9, 0.99, -0.85)"
  },
  {
    color: "rgb(200, 120, 70)",
    transform: "rotate(245deg)",
    easing: "cubic-bezier(0.63, 0.9, 0.99, -0.85)"
  }
];

const browserSamples = [
  [0, "rgb(38, 20, 53)", "matrix(1, 0, 0, 1, 0, 0)"],
  [200, "rgb(49, 27, 54)", "matrix(0.961351, 0.275327, -0.275327, 0.961351, 0, 0)"],
  [780, "rgb(71, 40, 56)", "matrix(0.643687, 0.765289, -0.765289, 0.643687, 0, 0)"],
  [1500, "rgb(83, 47, 58)", "matrix(0.384951, 0.922937, -0.922937, 0.384951, 0, 0)"],
  [2048, "rgb(80, 46, 57)", "matrix(0.439491, 0.898247, -0.898247, 0.439491, 0, 0)"],
  [3500, "rgb(56, 31, 55)", "matrix(0.892401, 0.451244, -0.451244, 0.892401, 0, 0)"
  ]
];

test("6 个真实 Chromium 样本逐项精确匹配", () => {
  for (const [time, color, transform] of browserSamples) {
    const sample = sampleAnimationAtTime({
      keyframes: browserKeyframes,
      timing: {duration: 4096, easing: "linear"},
      currentTime: time
    });
    assert.ok(sample, `time=${time} 必须可采样`);
    assert.equal(sample.color, color, `time=${time} color`);
    assert.equal(sample.transform, transform, `time=${time} transform`);
  }
});

test("property-indexed 关键帧、十六进制颜色和局部 easing", () => {
  const frames = {
    color: ["#0bc37d", "#d788fb"],
    transform: ["rotate(0deg)", "rotate(161deg)"],
    easing: "cubic-bezier(0.14,0.37,0.62,-0.54)"
  };
  const normalized = normalizeKeyframes(frames);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].offset, 0);
  assert.equal(normalized[1].offset, 1);
  assert.equal(normalized[0].easing, frames.easing);
  const first = sampleAnimationAtTime({keyframes: frames, timing: 1000, currentTime: 200});
  const second = sampleAnimationAtTime({keyframes: frames, timing: 1000, currentTime: 800});
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.color, second.color);
  assert.notEqual(first.transform, second.transform);
});

test("Y 控制点允许为负，不能强制将插值比例限制在 0~1", () => {
  const easing = "cubic-bezier(0.63, 0.9, 0.99, -0.85)";
  assert.ok(evaluateEasing(easing, 0.38) > evaluateEasing(easing, 0.9));
});

test("不支持的帧不会产生猜测的样式值", () => {
  assert.equal(sampleAnimationAtTime({
    keyframes: [{color: "red", transform: "scale(1)"}, {color: "blue", transform: "scale(2)"}],
    timing: {duration: 1000}, currentTime: 500
  }), null);
});

test("Happy DOM adapter 仅覆盖动画元素的两个计算样式属性，并能恢复原实现", () => {
  class Element {
    constructor() { this.tagName = "DIV"; }
    animate(frames, timing) {
      const animation = {
        currentTime: 0,
        playState: "running",
        effect: {getTiming: () => (typeof timing === "number" ? {duration: timing} : timing)},
        pause() { this.playState = "paused"; },
        cancel() { this.playState = "idle"; }
      };
      return animation;
    }
  }
  const baseStyles = new WeakMap();
  const window = {
    Element,
    getComputedStyle(element) {
      if (!baseStyles.has(element)) {
        baseStyles.set(element, {
          color: "rgb(1, 2, 3)",
          transform: "none",
          fontSize: "16px",
          getPropertyValue(name) { return this[name] || ""; }
        });
      }
      return baseStyles.get(element);
    }
  };
  const animateBefore = Element.prototype.animate;
  const computedBefore = window.getComputedStyle;
  const observed = [];
  const restore = installAnimationComputedStyleBridge(window, {
    onSample: record => observed.push(record)
  });
  try {
    const staticElement = new Element();
    assert.strictEqual(window.getComputedStyle(staticElement), baseStyles.get(staticElement));

    const animated = new Element();
    const animation = animated.animate(browserKeyframes, {duration: 4096});
    animation.pause();
    animation.currentTime = 780;
    const computed = window.getComputedStyle(animated);
    assert.equal(computed.color, "rgb(71, 40, 56)");
    assert.equal(computed.transform, "matrix(0.643687, 0.765289, -0.765289, 0.643687, 0, 0)");
    assert.equal(computed.getPropertyValue("color"), computed.color);
    assert.equal(computed.getPropertyValue("transform"), computed.transform);
    assert.equal(computed.fontSize, "16px");
    assert.equal(observed[0].currentTime, 780);
    animation.cancel();
    assert.equal(window.getComputedStyle(animated).color, "rgb(1, 2, 3)");
  } finally {
    restore();
  }
  assert.strictEqual(Element.prototype.animate, animateBefore);
  assert.strictEqual(window.getComputedStyle, computedBefore);
});
