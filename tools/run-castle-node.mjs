#!/usr/bin/env node
/**
 * Execute Castle in plain Node.js. No DOM, window, navigator or fingerprint
 * polyfills are installed: any missing browser dependencies remain visible.
 *
 * node tools/run-castle-node.mjs --sdk deobfus/12-babel-readable.js
 * node tools/run-castle-node.mjs --sdk deobfus/14-babel-experimental.js
 *
 * The supplied SDK may perform I/O. Use only with authorized inputs.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const opts = {
    sdk: 'deobfus/12-babel-readable.js',
    pk: process.env.CASTLE_PUBLIC_KEY ?? 'pk_AvRa79bHyJSYSQHnRpcVtzyxetSvFerx',
    printToken: false,
    continueAfterConfigureError: false
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--sdk': opts.sdk = argv[++i]; break;
      case '--pk': opts.pk = argv[++i]; break;
      case '--print-token': opts.printToken = true; break;
      case '--continue-after-configure-error': opts.continueAfterConfigureError = true; break;
      case '--help':
        console.log(`Usage: node tools/run-castle-node.mjs [options]
  --sdk PATH                         SDK ESM file (default: deobfus/12-babel-readable.js)
  --pk KEY                           Public key (default: supplied Castle key)
  --print-token                      Print full returned token
  --continue-after-configure-error   Continue ONLY for diagnosis; initialization is incomplete
  --help                             Show help`);
        process.exit(0);
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!opts.sdk || !opts.pk) throw new Error('Missing --sdk or --pk value');
  return opts;
}

const opts = parseArgs(process.argv);
const sdkFile = path.resolve(opts.sdk);

async function stage(label, action) {
  const start = performance.now();
  console.log(`[Castle:Node] ${label} ...`);
  try {
    const value = await action();
    console.log(`[Castle:Node] ${label} completed in ${((performance.now() - start) / 1000).toFixed(3)}s`);
    return value;
  } catch (error) {
    console.error(`[Castle:Node] ${label} FAILED`);
    // Preserve the original exception and stack, no browser shims/fallbacks.
    throw error;
  }
}

try {
  const sdkModule = await stage('import SDK', () => import(pathToFileURL(sdkFile).href));
  const sdk = sdkModule.default;
  if (!sdk || typeof sdk.configure !== 'function' || typeof sdk.createRequestToken !== 'function') {
    throw new TypeError(`Invalid SDK export; default keys: ${Object.keys(sdk ?? {}).join(', ')}`);
  }
  console.log('[Castle:Node] API:', Object.keys(sdk).filter(k => ['configure', 'createRequestToken'].includes(k)));

  let configured = false;
  try {
    await stage('configure({ pk })', () => sdk.configure({ pk: opts.pk }));
    configured = true;
  } catch (error) {
    if (!opts.continueAfterConfigureError) throw error;
    console.error('[Castle:Node] Continuing after failed configure for diagnosis only.');
    console.error(error);
  }

  const token = await stage('createRequestToken()', () => sdk.createRequestToken());
  console.log('[Castle:Node] Result:', {
    configureCompleted: configured,
    type: typeof token,
    length: typeof token === 'string' ? token.length : undefined,
    preview: typeof token === 'string' ? `${token.slice(0, 24)}...` : undefined
  });
  if (opts.printToken) console.log('[Castle:Node] Token:', token);
} catch (error) {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
}
