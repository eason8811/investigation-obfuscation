import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile, mkdtemp, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import {
  discoverSdk,
  moduleImports,
  persistSdkGraph,
  staticChunkUrls,
  validateAssetUrl,
} from '../tools/sdk-resource-utils.mjs';

const BASE = 'https://abs.twimg.com/x-web/x-web/';
const ENTRY = `${BASE}entry-client-logged-out-A1b2c3.js`;
const ASSET = `${BASE}assets/`;

function asset(path, content) {
  return {
    url: new URL(path.startsWith('https:') ? path : `${ASSET}${path}`),
    content,
    hash: createHash('sha256').update(content).digest('hex'),
  };
}

function mockFetcher(records) {
  const calls = [];
  const fetchAsset = async (url, kind, referer) => {
    const href = url.href ?? String(url);
    calls.push({href, kind, referer});
    if (!records.has(href)) throw new Error(`Unexpected fetch ${href}`);
    return records.get(href);
  };
  return {calls, fetchAsset};
}

test('ESM import scanner ignores ordinary strings and preload tables', () => {
  const code = `
    // import './ignored.js'
    const preload = ['./assets/pretend.js'];
    import { n as e } from './B644W4is.js';
    import './side.js';
    export { e } from './reexport.js';
    const x = import('./dynamic.js').then(e => e.default());
    const y = import(target);
  `;
  assert.deepEqual(moduleImports(code), [
    {type: 'static', specifier: './B644W4is.js'},
    {type: 'static', specifier: './side.js'},
    {type: 'static', specifier: './reexport.js'},
    {type: 'dynamic', specifier: './dynamic.js'},
    {type: 'dynamic', specifier: null},
  ]);
});

test('Sign SDK discovery follows opaque hashes using branch markers', async () => {
  const html = `<script src="${ENTRY}"></script>`;
  const records = new Map([
    [ENTRY, asset(ENTRY, `import {a} from './assets/startA1.js'; import './assets/notSign.js'; const p=['./assets/preloadFake.js'];`)],
    [`${ASSET}startA1.js`, asset('startA1.js', `const host='jf.x.com', sub='.jf.x.com', method='PATCH'; const x=import('./signHashB2.js').then(e=>e.default());`)],
    [`${ASSET}notSign.js`, asset('notSign.js', `export const foo = 1;`)],
  ]);
  const {fetchAsset, calls} = mockFetcher(records);
  const found = await discoverSdk(html, {target: 'sign', fetchAsset});
  assert.equal(found.sdkUrl.href, `${ASSET}signHashB2.js`);
  assert.equal(found.referer, `${ASSET}startA1.js`);
  assert.equal(calls.length, 3);
});

test('Castle discovery extracts version-matched SDK and public key', async () => {
  const html = `<script src="${ENTRY}"></script>`;
  const records = new Map([
    [ENTRY, asset(ENTRY, `import {foo} from './assets/castleStart.js'; import './assets/randomA.js';`)],
    [`${ASSET}castleStart.js`, asset('castleStart.js', `
      import {cfg} from './cfgHash1.js';
      const enabled='responsive_web_castle_sdk_enabled';
      const pk=getStringValue('responsive_web_castle_public_key');
      const sdk=import('./castleHash2.js').then(e=>e.default.configure({pk:pk}));
    `)],
    [`${ASSET}randomA.js`, asset('randomA.js', 'export const random=1;')],
    [`${ASSET}cfgHash1.js`, asset('cfgHash1.js', `const c={responsive_web_castle_public_key:'pk_TEST123'};`)],
  ]);
  const {fetchAsset} = mockFetcher(records);
  const found = await discoverSdk(html, {target: 'castle', fetchAsset});
  assert.equal(found.sdkUrl.href, `${ASSET}castleHash2.js`);
  assert.equal(found.publicKey, 'pk_TEST123');
});

test('SDK graph preserves all ESM basenames and dependencies', async () => {
  const root = asset('sdkHashX.js', `import {n as e} from './B644W4is.js'; const z=import('./cnfsMYm8.js');`);
  const records = new Map([
    [`${ASSET}B644W4is.js`, asset('B644W4is.js', `export {x} from './commonZ.js';`)],
    [`${ASSET}cnfsMYm8.js`, asset('cnfsMYm8.js', `export const y=2;`)],
    [`${ASSET}commonZ.js`, asset('commonZ.js', `export const x=1;`)],
  ]);
  const {fetchAsset, calls} = mockFetcher(records);
  const dir = await mkdtemp(join(tmpdir(), 'sdk-discovery-test-'));
  const rootFile = await persistSdkGraph(root, {directory: dir, fetchAsset});
  assert.equal((await readFile(rootFile, 'utf8')), root.content);
  assert.match(await readFile(join(dirname(rootFile), 'package.json'), 'utf8'), /"type":"module"/);
  // resolve parent directory from actual returned root path.
  const base = dirname(rootFile);
  for (const filename of ['B644W4is.js', 'cnfsMYm8.js', 'commonZ.js']) {
    assert.ok((await stat(join(base, filename))).isFile());
  }
  assert.equal(calls.length, 3);
});

test('malicious module URL and parent directory import are rejected', async () => {
  assert.throws(() => validateAssetUrl('https://evil.invalid/x-web/x-web/assets/a.js'));
  const dir = await mkdtemp(join(tmpdir(), 'sdk-discovery-reject-'));
  await assert.rejects(() => persistSdkGraph(
    asset('rootHash.js', `import '../outside.js';`),
    {directory: dir, fetchAsset: async () => {throw new Error('should not fetch');}},
  ), /不支持的模块引用/);
});

test('Entry import extraction excludes preload map literals', () => {
  const entry = `import{a as b}from'./assets/chunkABC.js';let map=['./assets/mapOnly.js'];`;
  assert.deepEqual(staticChunkUrls(entry, new URL(ENTRY), true).map(url => url.href),
    [`${ASSET}chunkABC.js`]);
});
