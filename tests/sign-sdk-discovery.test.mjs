// 无网络、无 Happy DOM 的资源链解析回归测试。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { URL as NodeURL, fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = ["tools/run-sign-happydom.mjs", "scripts/run-sign-happydom.mjs"]
  .map(part => resolve(projectRoot, part))
  .find(existsSync);
assert(scriptPath, "找不到 run-sign-happydom.mjs 入口");
const runner = readFileSync(scriptPath, "utf8");
const start = runner.indexOf("function validateCdnAssetUrl(");
const end = runner.indexOf("function requestHeaders()", start);
assert(start >= 0 && end > start, "入口中的资源链函数位置发生变化");

const entryUrl = "https://abs.twimg.com/x-web/x-web/entry-client-logged-out-D1vnaZeG.js";
const startupUrl = "https://abs.twimg.com/x-web/x-web/assets/startup-dynamic-DncYL_2o.js";
const sdkUrl = "https://abs.twimg.com/x-web/x-web/assets/sign.o-JPvk--OA.js";
const html = `<html data-app-version="test-build"><script>var entryHref = "${entryUrl}";</script></html>`;
const assets = new Map([
  [entryUrl, 'import {Ai as bt} from "./assets/startup-dynamic-DncYL_2o.js";'],
  [startupUrl, "function Gm(){return j(() => import(`./sign.o-JPvk--OA.js`).then(e => e.default()), []);}"],
  [sdkUrl, "export default function () { return () => 'test'; }"]
]);
const responses = [];
const records = [];
const saved = [];
const nodeAbortSignal = globalThis.AbortSignal;
const options = {
  sdkSource: "auto",
  sdkFetchUrl: null,
  sdkReferer: null,
  fetchUrl: "https://x.com/",
  sdkFetchTimeoutMs: 1000,
  saveDiscoveryAssets: true,
  expectedSdkSha256: null
};

const make = new Function(
  "options", "nodeFetch", "trace", "logStageInfo", "sha256", "assertExpectedHash",
  "mkdir", "writeFile", "readFile", "resolve", "dirname", "projectRoot", "Buffer", "process",
  "NodeURL", "nodeAbortSignal",
  `${runner.slice(start, end)}\nreturn { validateCdnAssetUrl, extractUniqueReference, discoverSdkFromHtml, prepareSdkFile };`
);
const api = make(
  options,
  async (urlInput, request) => {
    const url = String(urlInput);
    assert(assets.has(url), `非预期的资源请求：${url}`);
    assert(request.signal instanceof nodeAbortSignal, "必须使用 Node 原生 AbortSignal");
    responses.push({ url, referer: request.headers.referer });
    return {
      url, ok: true, status: 200, redirected: false,
      headers: { get(key) { return key === "content-type" ? "application/javascript" : null; } },
      text: async () => assets.get(url)
    };
  },
  { stage: async (_, action) => action() },
  (name, data) => records.push({ name, data }),
  content => createHash("sha256").update(content).digest("hex"),
  (label, actual, expected) => { if (expected && actual !== expected) throw Error(`${label} sha256 mismatch`); },
  async () => {},
  async (path, content) => saved.push({ path, content }),
  async () => { throw Error("不应读取本地 SDK"); },
  resolve, dirname, projectRoot, Buffer, process, NodeURL, nodeAbortSignal
);

assert.throws(
  () => api.validateCdnAssetUrl("https://other.example/x-web/x-web/assets/sign.o-X.js", "sdk"),
  /非法/
);
assert.throws(() => api.extractUniqueReference("", /sign\.o-[^"']+/g, "test"), /数量/);

// 模拟 Happy DOM 注册后覆盖 globalThis.URL 与 AbortSignal。
const previousURL = globalThis.URL;
const previousAbortSignal = globalThis.AbortSignal;
let result;
try {
  globalThis.URL = class WindowURL {
    constructor() { throw Error("不应使用 Happy DOM URL"); }
  };
  globalThis.AbortSignal = class WindowAbortSignal {
    static timeout() { throw Error("不应使用 Happy DOM AbortSignal"); }
  };
  result = await api.prepareSdkFile(html);
} finally {
  globalThis.URL = previousURL;
  globalThis.AbortSignal = previousAbortSignal;
}
assert.match(result, /sdk-[a-f0-9]{64}\.mjs$/);
assert.deepEqual(responses.map(x => x.url), [entryUrl, startupUrl, sdkUrl]);
assert.deepEqual(responses.map(x => x.referer), ["https://x.com/", entryUrl, startupUrl]);
assert.equal(saved.length, 3);
assert.equal(saved[2].content, assets.get(sdkUrl));
assert.equal(records.find(x => x.name === "sdk.discovery.chain")?.data.sdkUrl, sdkUrl);
console.log("PASS: HTML -> entry -> startup -> sign URL 自动发现 / 下载 / 哈希快照");
console.log("PASS: URL/AbortSignal 全局替换模拟下，纯解析及 mock-fetch 不受影响");

// 真正的 Node fetch/Undici 会在运行时按当前全局类型校验 signal。
// 所以网络调用必须全部发生在 initializeBrowserEnvironment 之前。
const sdkLoadPos = runner.indexOf("const sdkFile = needsSdk");
const registerPos = runner.indexOf("const env = initializeBrowserEnvironment(", sdkLoadPos);
assert(sdkLoadPos > 0 && registerPos > sdkLoadPos, "SDK 下载必须先于 Happy DOM 注册");
const nativeResponse = await globalThis.fetch("data:text/plain,ok", {
  signal: nodeAbortSignal.timeout(1000)
});
assert.equal(await nativeResponse.text(), "ok");
console.log("PASS: SDK 加载在 Happy DOM 注册前，原生 fetch + AbortSignal 烟雾测试通过");

const actualHtmlPath = process.env.SIGN_TEST_HTML_PATH;
if (actualHtmlPath) {
  const actualHtml = readFileSync(actualHtmlPath, "utf8");
  const actualEntry = api.extractUniqueReference(
    actualHtml,
    /https:\/\/abs\.twimg\.com\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js/g,
    "uploaded HTML entry"
  );
  assert.equal(actualEntry, entryUrl);
  console.log("PASS: 用户提供的完整 HTML 中找到预期 entry URL");
}
