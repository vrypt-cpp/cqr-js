// Micro-benchmarks: encode p50/p95 plus matrix decode. Run: npm run bench
// (build first so dist/ exists; falls back to src/ for direct runs).
import { createRequire } from 'node:module';

let lib;
try {
  lib = await import('../dist/index.js');
} catch {
  lib = await import('../src/index.ts');
}

const { encode, decodeMatrix, Ecc, Mode, InputEncoding } = lib;

function bytes(n, seed) {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function benchEncode(name, data, options, iters) {
  for (let i = 0; i < 10; i++) encode(data, options);
  const times = [];
  let code;
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    code = encode(data, options);
    times.push(Number(process.hrtime.bigint() - t0));
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  let hash = 2166136261;
  for (const b of code.modules) {
    hash ^= b;
    hash = Math.imul(hash, 16777619);
  }
  console.log(
    `${name.padEnd(16)} v${code.version} ${(avg / 1e6).toFixed(3)} ms/op` +
      ` p50 ${(quantile(times, 0.5) / 1e6).toFixed(3)} p95 ${(quantile(times, 0.95) / 1e6).toFixed(3)}` +
      ` hash ${(hash >>> 0).toString(16)}`,
  );
  return code;
}

function benchDecode(name, code, iters) {
  for (let i = 0; i < 5; i++) decodeMatrix(code.modules, code.size);
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    decodeMatrix(code.modules, code.size);
    times.push(Number(process.hrtime.bigint() - t0));
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`${name.padEnd(16)} v${code.version} ${(avg / 1e6).toFixed(3)} ms/op`);
}

const hello = new TextEncoder().encode('Hello, world!(Category: test)');
const v10 = bytes(100, 7);
const v40 = bytes(1000, 13);

const c1 = benchEncode('encode-small', hello, { input: InputEncoding.Bytes, mode: Mode.Byte }, 2000);
const c2 = benchEncode('encode-v10', v10, { input: InputEncoding.Bytes, mode: Mode.Byte, minVersion: 10, maxVersion: 10 }, 300);
const c3 = benchEncode('encode-v40', v40, { input: InputEncoding.Bytes, mode: Mode.Byte, minVersion: 40, maxVersion: 40 }, 30);
benchDecode('decode-small', c1, 2000);
benchDecode('decode-v40', c3, 30);
void Ecc;
