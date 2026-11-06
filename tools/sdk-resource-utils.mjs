/**
 * 诊断入口共享的 X CDN 资源发现与 ESM 依赖准备工具。
 * 仅解析源码文本；不会执行 Entry/Startup。无第三方依赖。
 */
import {basename, dirname, resolve} from "node:path";
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {URL} from "node:url";

const ENTRY_PATH = /^\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js$/;
const ASSET_PATH = /^\/x-web\/x-web\/assets\/[A-Za-z0-9_-]+\.js$/;
const RELATIVE_JS = /^\.\/[A-Za-z0-9_-]+\.js$/;
const MAX_GRAPH_MODULES = 64;
const MAX_GRAPH_BYTES = 50 * 1024 * 1024;

// 若项目已安装 es-module-lexer，则优先使用正式词法解析器；否则使用下方无依赖解析。
let parseWithLexer = null;
try {
  const lexer = await import("es-module-lexer");
  await lexer.init;
  parseWithLexer = lexer.parse;
} catch {
  // 诊断脚本在没有安装 es-module-lexer 的原始工程中仍可运行。
}

export function validateAssetUrl(value, kind = "asset") {
  const url = new URL(value);
  const path = kind === "entry" ? ENTRY_PATH : ASSET_PATH;
  if (url.protocol !== "https:" || url.hostname !== "abs.twimg.com" ||
    url.port || url.username || url.password || url.search || url.hash ||
    !path.test(url.pathname)) {
    throw new Error(`非法 ${kind} CDN 资源地址：${url.href}`);
  }
  return url;
}

export function uniqueReference(source, pattern, label) {
  const values = [...new Set(Array.from(source.matchAll(pattern), match => match[1] ?? match[0]))];
  if (values.length !== 1 || !values[0]) {
    throw new Error(`${label} 需要恰好一个候选，实际 ${values.length}：${JSON.stringify(values.slice(0, 8))}`);
  }
  return values[0];
}

/**
 * 轻量词法切分：跳过字符串外的注释，保留模块导入需要的标识符和字符串。
 * 字符串被当作原子 token，避免把 preload 数组中的路径当成静态 import。
 * 仅识别字面量 import/export；非字面量 import() 无法离线预下载。
 */
export function moduleImports(source) {
  if (parseWithLexer) {
    const [imports] = parseWithLexer(source);
    return imports.map(item => ({
      type: item.type === "dynamic" || item.d >= 0 ? "dynamic" : "static",
      specifier: typeof item.specifier === "string" ? item.specifier :
        typeof item.n === "string" ? item.n : null
    }));
  }
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const start = i;
    const char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i + 2);
      if (i < 0) break;
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i++;
      let escaped = false;
      while (i < source.length) {
        const ch = source[i++];
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === quote) break;
      }
      const value = source.slice(start + 1, i - 1);
      tokens.push({type: quote === "`" ? "template" : "string", value});
      continue;
    }
    if (/[a-zA-Z_$]/.test(char)) {
      i++;
      while (i < source.length && /[a-zA-Z0-9_$]/.test(source[i])) i++;
      tokens.push({type: "identifier", value: source.slice(start, i)});
      continue;
    }
    tokens.push({type: "punctuation", value: char});
    i++;
  }

  const found = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== "identifier" || !["import", "export"].includes(token.value)) continue;
    const next = tokens[index + 1];
    if (!next || next.value === ".") continue; // import.meta
    if (token.value === "import" && next.value === "(") {
      const specifier = tokens[index + 2];
      const close = tokens[index + 3];
      found.push({type: "dynamic", specifier: specifier?.type === "string" && close?.value === ")"
        ? specifier.value : null});
      continue;
    }
    if (token.value === "import" && next.type === "string") {
      found.push({type: "static", specifier: next.value});
      continue;
    }
    // ESM 的 from 位于同一 import/export 声明中。
    const stop = Math.min(index + 3000, tokens.length);
    for (let cursor = index + 1; cursor < stop; cursor++) {
      const item = tokens[cursor];
      if (item.value === ";" ||
        (cursor !== index + 1 && item.type === "identifier" && ["import", "export"].includes(item.value))) break;
      if (item.type === "identifier" && item.value === "from" && tokens[cursor + 1]?.type === "string") {
        found.push({type: "static", specifier: tokens[cursor + 1].value});
        break;
      }
    }
  }
  return found;
}

export function staticChunkUrls(source, baseUrl, isEntry, maxCandidates = 64) {
  const urls = new Map();
  const specifierPattern = isEntry
    ? /^\.\/assets\/[A-Za-z0-9_-]+\.js$/
    : /^\.\/(?:assets\/)?[A-Za-z0-9_-]+\.js$/;
  for (const item of moduleImports(source)) {
    if (item.type !== "static" || !specifierPattern.test(item.specifier)) continue;
    const url = validateAssetUrl(new URL(item.specifier, baseUrl));
    urls.set(url.href, url);
  }
  if (urls.size < 1 || urls.size > maxCandidates) {
    throw new Error(`静态导入候选数量异常：${urls.size}，上限 ${maxCandidates}`);
  }
  return [...urls.values()];
}

export async function discoverSdk(html, {fetchAsset, target, onEvent = () => {}}) {
  const entryHref = uniqueReference(html,
    /https:\/\/abs\.twimg\.com\/x-web\/x-web\/entry-client-logged-out-[A-Za-z0-9_-]+\.js/g,
    "HTML Entry");
  const entry = await fetchAsset(validateAssetUrl(entryHref, "entry"), "entry", "https://x.com/");
  const entryCandidates = staticChunkUrls(entry.content, entry.url, true,
    target === "sign" ? 32 : 64);
  onEvent("sdk.discovery.entry", {url: entry.url.href, sha256: entry.hash, candidates: entryCandidates.length});
  const matches = [];
  for (const candidate of entryCandidates) {
    const asset = await fetchAsset(candidate, "chunk", entry.url.href);
    const matched = target === "sign"
      ? /["'`]jf\.x\.com["'`]/.test(asset.content) &&
        /["'`]\.jf\.x\.com["'`]/.test(asset.content) &&
        /["'`]PATCH["'`]/.test(asset.content)
      : /responsive_web_castle_sdk_enabled/.test(asset.content) &&
        /getStringValue\s*\(\s*["'`]responsive_web_castle_public_key["'`]\s*\)/.test(asset.content) &&
        /\.configure\s*\(\s*\{\s*pk\s*:/.test(asset.content);
    onEvent("sdk.discovery.candidate", {url: asset.url.href, matched});
    if (matched) matches.push(asset);
  }
  if (matches.length !== 1) {
    throw new Error(`无法唯一匹配 ${target} 调用模块，匹配数 ${matches.length}`);
  }
  const startup = matches[0];
  let sdkSpecifier;
  let publicKey = null;
  if (target === "sign") {
    sdkSpecifier = uniqueReference(startup.content,
      /\bimport\s*\(\s*["'`](\.\/[A-Za-z0-9_-]+\.js)["'`]\s*\)\s*\.then\s*\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\2\.default\s*\(\s*\)\s*\)/g,
      "Sign SDK 动态导入");
  } else if (target === "castle") {
    const candidates = new Set();
    for (const anchor of startup.content.matchAll(
      /getStringValue\s*\(\s*["'`]responsive_web_castle_public_key["'`]\s*\)/g)) {
      const following = startup.content.slice(anchor.index, anchor.index + 2048);
      const configureIndex = following.search(/\.configure\s*\(\s*\{\s*pk\s*:/);
      if (configureIndex < 0) continue;
      for (const match of following.slice(0, configureIndex).matchAll(
        /\bimport\s*\(\s*["'`](\.\/[A-Za-z0-9_-]+\.js)["'`]\s*\)/g)) {
        candidates.add(match[1]);
      }
    }
    if (candidates.size !== 1) throw new Error(`Castle SDK 动态导入匹配数异常：${candidates.size}`);
    sdkSpecifier = [...candidates][0];
    const keys = new Set();
    for (const url of staticChunkUrls(startup.content, startup.url, false)) {
      const asset = await fetchAsset(url, "chunk", startup.url.href);
      for (const match of asset.content.matchAll(
        /(?:^|[,{])\s*(?:responsive_web_castle_public_key|["'`]responsive_web_castle_public_key["'`])\s*:\s*(["'`])(pk_[A-Za-z0-9_-]+)\1/g)) {
        keys.add(match[2]);
      }
    }
    if (keys.size !== 1) throw new Error(`Castle 公钥匹配数异常：${keys.size}`);
    publicKey = [...keys][0];
  } else {
    throw new Error(`不支持的目标 SDK：${target}`);
  }
  const sdkUrl = validateAssetUrl(new URL(sdkSpecifier, startup.url));
  onEvent("sdk.discovery.chain", {
    target, entryUrl: entry.url.href, startupUrl: startup.url.href,
    startupSha256: startup.hash, sdkUrl: sdkUrl.href, publicKeyFound: Boolean(publicKey)
  });
  return {sdkUrl, referer: startup.url.href, publicKey, entry, startup};
}

/** 下载 SDK 字面量 ESM 依赖，保留 CDN 文件名与相对 import 关系。 */
export async function persistSdkGraph(rootAsset, {directory, fetchAsset, onEvent = () => {}}) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const folder = await mkdtemp(resolve(directory, `sdk-${rootAsset.hash.slice(0, 12)}-`));
  await writeFile(resolve(folder, "package.json"), '{"type":"module"}\n', {flag: "wx", mode: 0o600});
  const queue = [rootAsset];
  const seen = new Set([rootAsset.url.href]);
  let totalBytes = 0;
  for (let index = 0; index < queue.length; index++) {
    const asset = queue[index];
    const filename = basename(asset.url.pathname);
    if (!/^[A-Za-z0-9_-]+\.js$/.test(filename)) throw new Error(`非法 SDK 文件名：${filename}`);
    const size = Buffer.byteLength(asset.content);
    totalBytes += size;
    if (totalBytes > MAX_GRAPH_BYTES) throw new Error("SDK 依赖图超过 50 MiB 上限");
    await writeFile(resolve(folder, filename), asset.content, {flag: "wx", mode: 0o600});
    for (const item of moduleImports(asset.content)) {
      if (item.specifier === null) {
        onEvent("sdk.graph.dynamic", {module: filename, reason: "non-literal"});
        continue;
      }
      if (!RELATIVE_JS.test(item.specifier)) {
        // 网页 SDK 导入语句只能指向同目录 JS 文件；禁止逃出沙箱目录。
        throw new Error(`SDK 中存在不支持的模块引用：${filename}: ${item.specifier}`);
      }
      const url = validateAssetUrl(new URL(item.specifier, asset.url));
      if (seen.has(url.href)) continue;
      if (seen.size >= MAX_GRAPH_MODULES) throw new Error("SDK 依赖数量超过 64 个");
      seen.add(url.href);
      queue.push(await fetchAsset(url, "chunk", asset.url.href));
    }
  }
  onEvent("sdk.graph.ready", {directory: folder, modules: queue.length, bytes: totalBytes});
  return resolve(folder, basename(rootAsset.url.pathname));
}
