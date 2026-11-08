#!/usr/bin/env node
/**
 * castle-rs local integration probe.
 *
 * Unlike run-castle-happydom.mjs, this entry never downloads or executes
 * the site's SDK and never makes HTTP requests. It only exercises the
 * locally installed castle-rs Node N-API binding with an explicitly supplied
 * configuration from an authorized testing deployment.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

function help() {
  console.log(`castle-rs 离线验证入口

用法：node tools/run-castle-rs.mjs [--check|--help]

需要预先准备的测试配置：
  CASTLE_PUBLIC_KEY        测试站点的 Castle publishable key
  CASTLE_IG                Integration group ID（正整数）
  CASTLE_HOSTNAME          测试站点主机名，不包含协议或路径
  CASTLE_CUID              与测试会话对应的 32 位十六进制 CUID

可选配置：
  CASTLE_RS_MODULE_PATH    castle-rs/node 的绝对或相对路径（否则 require('castle-token')）
  CASTLE_RS_LOCALE         语言配置预设，如 en-US
  CASTLE_RS_JITTER         1 启用；默认 0
  CASTLE_RS_INIT_TIME_MS   测试用初始化时间（整数毫秒）
  CASTLE_RS_NOW_MS         测试用生成时间（整数毫秒）
  CASTLE_RS_OUTPUT_FILE    保存原始生成结果的路径；默认不保存或打印

  --check                 只检测 Node 原生绑定能否加载，不生成 Token

本脚本不调用第三方站点，不验证服务端是否接受生成结果。
`);
}

function loadBinding() {
  const custom = process.env.CASTLE_RS_MODULE_PATH?.trim();
  const moduleId = custom ? resolve(custom) : 'castle-token';
  let binding;
  try {
    binding = require(moduleId);
  } catch (error) {
    throw new Error(
      `无法加载 castle-rs Node 原生绑定（${moduleId}）。` +
      `请先在 castle-rs/node 执行 npm install 与 npm run build，` +
      `再设置 CASTLE_RS_MODULE_PATH 指向该目录。原始错误：${error.message}`,
      { cause: error }
    );
  }
  if (typeof binding?.mintToken !== 'function') {
    throw new TypeError(`castle-rs 绑定缺少 mintToken()：${moduleId}`);
  }
  return { binding, moduleId };
}

function requireValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function parseTimestamp(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} 必须是正整数毫秒时间戳`);
  }
  return parsed;
}

function parseConfig() {
  const pk = requireValue('CASTLE_PUBLIC_KEY');
  const igText = requireValue('CASTLE_IG');
  const hostname = requireValue('CASTLE_HOSTNAME');
  const cuid = requireValue('CASTLE_CUID').toLowerCase();
  const ig = Number(igText);

  if (!/^pk_\S+$/.test(pk)) throw new Error('CASTLE_PUBLIC_KEY 需要以 pk_ 开头');
  if (!Number.isSafeInteger(ig) || ig <= 0 || ig > 0xffff_ffff) {
    throw new Error('CASTLE_IG 必须是 uint32 范围内的正整数');
  }
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(hostname) || hostname.includes('..')) {
    throw new Error('CASTLE_HOSTNAME 只能填写主机名，不包含 URL 协议、路径或端口');
  }
  if (!/^[\da-f]{32}$/.test(cuid)) {
    throw new Error('CASTLE_CUID 必须是 32 位十六进制字符串');
  }
  const rawJitter = process.env.CASTLE_RS_JITTER?.trim() || '0';
  if (!['0', '1'].includes(rawJitter)) {
    throw new Error('CASTLE_RS_JITTER 只能为 0 或 1');
  }
  return {
    pk, ig, hostname: hostname.toLowerCase(), cuid,
    locale: process.env.CASTLE_RS_LOCALE?.trim() || undefined,
    jitter: rawJitter === '1',
    initTimeMs: parseTimestamp('CASTLE_RS_INIT_TIME_MS'),
    nowMs: parseTimestamp('CASTLE_RS_NOW_MS'),
    outputFile: process.env.CASTLE_RS_OUTPUT_FILE?.trim() || undefined
  };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) return help();
  const { binding, moduleId } = loadBinding();
  console.log('[Castle-RS] 原生绑定加载成功:', moduleId);
  if (process.argv.includes('--check')) return;

  const config = parseConfig();
  const localeProfile = config.locale
    ? binding.LocaleProfile.preset(config.locale)
    : undefined;

  const start = performance.now();
  // The Rust API defaults to its bundled fingerprint when this argument is omitted.
  // Only explicit test parameters are supplied here; no X.com values are built in.
  const token = binding.mintToken(
    config.cuid,
    config.pk,
    config.ig,
    config.hostname,
    undefined,
    localeProfile,
    config.jitter,
    config.initTimeMs,
    config.nowMs
  );
  if (typeof token !== 'string' || !token) {
    throw new TypeError('mintToken() 未返回非空字符串');
  }

  const summary = {
    kind: 'offline-mint',
    tokenLength: token.length,
    tokenSha256: createHash('sha256').update(token).digest('hex'),
    elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    fingerprint: 'castle-rs bundled default',
    locale: config.locale ?? 'fingerprint default',
    jitter: config.jitter,
    serverAccepted: 'not tested'
  };

  if (config.outputFile) {
    const outputFile = resolve(config.outputFile);
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, token + '\n', { flag: 'wx', mode: 0o600 });
    summary.outputFile = outputFile;
  }
  console.log('[Castle-RS] 离线生成结果:', summary);
}

main().catch(error => {
  console.error('[Castle-RS] 执行失败:', error.message);
  process.exitCode = 1;
});
