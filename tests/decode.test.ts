import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encode,
  decodeMatrix,
  decodeMatrixUtf8,
  Mode,
  InputEncoding,
  Ecc,
  QRError,
  Status,
} from '../src/index.ts';
import * as compact from '../src/compact.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
interface Fixture {
  name: string;
  inputHex: string;
  version?: number;
  size?: number;
  modulesB64?: string;
}
const fixtures: Fixture[] = JSON.parse(readFileSync(join(root, 'tests', 'fixtures.json'), 'utf8')).fixtures;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Raw (Shift-JIS) expectations for the kanji fixtures.
const RAW_EXPECT: Record<string, string> = {
  'kanji-sjis': '93fa967b8cea',
  'kanji-utf8': '93fa967b8cea',
};
const UTF8_EXPECT: Record<string, string> = {
  'kanji-utf8': 'e697a5e69cace8aa9e',
};

describe('decode C-generated matrices', () => {
  for (const f of fixtures) {
    it(`raw: ${f.name}`, () => {
      const matrix = new Uint8Array(Buffer.from(f.modulesB64 as string, 'base64'));
      const { bytes, info } = decodeMatrix(matrix, f.size as number);
      assert.equal(info.version, f.version);
      const want = RAW_EXPECT[f.name] ?? f.inputHex;
      assert.equal(Buffer.from(bytes).toString('hex'), want);
    });
  }
  it('utf8 variant restores kanji-utf8 payload', () => {
    const f = fixtures.find((x) => x.name === 'kanji-utf8') as Fixture;
    const matrix = new Uint8Array(Buffer.from(f.modulesB64 as string, 'base64'));
    const { bytes } = decodeMatrixUtf8(matrix, f.size as number);
    assert.equal(Buffer.from(bytes).toString('hex'), UTF8_EXPECT['kanji-utf8']);
  });
});

describe('round-trip all versions x ECC', () => {
  const input = new TextEncoder().encode('ABCDE');
  for (let version = 1; version <= 40; version++) {
    for (let ecc = 0; ecc <= 3; ecc++) {
      it(`v${version} ecc${ecc}`, () => {
        const code = encode(input, {
          input: InputEncoding.Bytes,
          mode: Mode.Byte,
          ecc: ecc as 0 | 1 | 2 | 3,
          minVersion: version,
          maxVersion: version,
          mask: 0,
        });
        assert.equal(code.version, version);
        const { bytes, info } = decodeMatrix(code.modules, code.size);
        assert.equal(info.version, version);
        assert.equal(info.ecc, ecc);
        assert.deepEqual(Buffer.from(bytes), Buffer.from(input));
      });
    }
  }
});

describe('decoder error correction and failures', () => {
  it('corrects flipped data modules (ECC-H)', () => {
    const input = new TextEncoder().encode('RS TEST PAYLOAD');
    const code = encode(input, {
      input: InputEncoding.Bytes,
      mode: Mode.Byte,
      ecc: Ecc.H,
      minVersion: 5,
      maxVersion: 5,
    });
    const damaged = code.modules.slice();
    for (let i = 0; i < 5; i++) {
      damaged[(10 + i) * code.size + 12] ^= 1;
      damaged[(12 + i) * code.size + 14] ^= 1;
    }
    const { bytes, info } = decodeMatrix(damaged, code.size);
    assert.deepEqual(Buffer.from(bytes), Buffer.from(input));
    assert.ok(info.correctedCodewords > 0);
  });

  it('rejects heavily damaged format info', () => {
    const code = encode('FORMAT');
    const damaged = code.modules.slice();
    for (let i = 0; i < 4; i++) damaged[8 * code.size + i] ^= 1;
    for (let i = 1; i <= 4; i++) damaged[8 * code.size + (code.size - i)] ^= 1;
    assert.throws(() => decodeMatrix(damaged, code.size), (e: unknown) => {
      return e instanceof QRError && (e.code === Status.DecodeFormat || e.code === Status.NotFound);
    });
  });

  it('rejects a tiny output case via garbage matrix', () => {
    const garbage = new Uint8Array(21 * 21);
    assert.throws(() => decodeMatrix(garbage, 21), QRError);
  });

  it('rejects invalid dimensions', () => {
    assert.throws(() => decodeMatrix(new Uint8Array(22 * 22), 22), (e: unknown) => {
      return e instanceof QRError && e.code === Status.InvalidArgument;
    });
  });
});

describe('compact build parity', () => {
  it('encodes bytes identically without kanji tables', () => {
    const input = new TextEncoder().encode('HELLO WORLD 123');
    const a = encode(input, { input: InputEncoding.Bytes, mode: Mode.Byte });
    const b = compact.encode(input, { input: InputEncoding.Bytes, mode: Mode.Byte });
    assert.deepEqual(Buffer.from(a.modules), Buffer.from(b.modules));
    assert.equal(a.penalty, b.penalty);
  });
  it('falls back to byte mode for kanji unicode', () => {
    const code = compact.encode('日本語');
    assert.equal(code.modeMask & 8, 0);
    const { bytes } = compact.decodeMatrix(code.modules, code.size);
    assert.equal(Buffer.from(bytes).toString('utf-8'), '日本語');
  });
});
