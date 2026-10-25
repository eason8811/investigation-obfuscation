import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { webcrack } from 'webcrack';

const input = resolve(
    process.argv[2] ?? 'source/castle.umd-DpX19jpb.js'
);

const output = resolve(
    process.argv[3] ?? 'deobfus/castle-webcrack.js'
);

if (input === output) {
    throw new Error('输入文件和输出文件不能相同');
}

console.log('[Webcrack] Input:', input);

const source = await readFile(input, 'utf8');
const start = performance.now();

const result = await webcrack(source, {
    deobfuscate: true,
    unminify: true,

    // 暂时保持单文件，方便交给 REstringer
    unpack: false,

    // Castle UMD 不需要 JSX 转换
    jsx: false,

    // 第一阶段暂时不自动重命名变量
    mangle: false,
});

await mkdir(dirname(output), { recursive: true });
await writeFile(output, result.code, 'utf8');

console.log('[Webcrack] Completed', {
    inputBytes: Buffer.byteLength(source),
    outputBytes: Buffer.byteLength(result.code),
    seconds: Number(((performance.now() - start) / 1000).toFixed(2)),
    output,
});