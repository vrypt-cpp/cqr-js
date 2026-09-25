// Reports dist sizes (raw + gzip). Run: npm run size
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = new URL('../dist/', import.meta.url).pathname;
for (const f of readdirSync(dir).sort()) {
  if (!f.endsWith('.js')) continue;
  const buf = readFileSync(join(dir, f));
  console.log(`${f}: ${(buf.length / 1024).toFixed(1)} KB raw, ${(gzipSync(buf).length / 1024).toFixed(1)} KB gzip`);
}
void statSync;
