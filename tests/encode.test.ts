import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  encode,
  decodeMatrix,
  Ecc,
  Mode,
  InputEncoding,
  QRError,
  Status,
  packRows,
  renderAscii,
  renderSvg,
} from '../src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
interface Fixture {
  name: string;
  inputHex: string;
  input: number;
  mode: number;
  ecc: number;
  minV: number;
  maxV: number;
  mask: number;
  error?: number;
  version?: number;
  size?: number;
  maskOut?: number;
  modeMask?: number;
  penalty?: number;
  modulesB64?: string;
}
const fixtures: Fixture[] = JSON.parse(readFileSync(join(root, 'tests', 'fixtures.json'), 'utf8')).fixtures;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

describe('encode matches the C reference', () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const input = hexToBytes(f.inputHex);
      const code = encode(input, {
        input: f.input as 0 | 1 | 2,
        mode: f.mode as 0 | 1 | 2 | 3 | 4,
        ecc: f.ecc as 0 | 1 | 2 | 3,
        minVersion: f.minV,
        maxVersion: f.maxV,
        mask: f.mask,
      });
      assert.equal(code.version, f.version);
      assert.equal(code.size, f.size);
      assert.equal(code.mask, f.maskOut);
      assert.equal(code.modeMask, f.modeMask);
      assert.equal(code.penalty, f.penalty);
      const expected = Buffer.from(f.modulesB64 as string, 'base64');
      assert.equal(code.modules.length, expected.length);
      assert.deepEqual(Buffer.from(code.modules), expected);
    });
  }

  it('golden matrix rows for HELLO WORLD', () => {
    const code = encode('HELLO WORLD', {
      ecc: Ecc.Q,
      input: InputEncoding.Bytes,
      mode: Mode.Alphanumeric,
      mask: 0,
    });
    const expected = [
      '111111101100001111111',
      '100000101001001000001',
      '101110101001101011101',
      '101110101000001011101',
      '101110101010001011101',
      '100000100010001000001',
      '111111101010101111111',
      '000000001000000000000',
      '011010110000101011111',
      '010000001111000010001',
      '001101110110001011000',
      '011011010011010101110',
      '100010101011101110101',
      '000000001101001000101',
      '111111101010000101100',
      '100000100101101101000',
      '101110101010001111111',
      '101110100101010100010',
      '101110101001011101001',
      '100000101011110001011',
      '111111100001011100001',
    ];
    for (let y = 0; y < 21; y++) {
      let row = '';
      for (let x = 0; x < 21; x++) row += code.modules[y * 21 + x] ? '1' : '0';
      assert.equal(row, expected[y], `row ${y}`);
    }
  });
});

describe('encode errors', () => {
  it('rejects data too long', () => {
    assert.throws(() => encode(new Uint8Array(7090), { mode: Mode.Byte }), (e: unknown) => {
      return e instanceof QRError && e.code === Status.DataTooLong;
    });
  });
  it('rejects invalid mode data', () => {
    assert.throws(() => encode('12A4', { mode: Mode.Numeric, input: InputEncoding.Bytes }), (e: unknown) => {
      return e instanceof QRError && e.code === Status.InvalidModeData;
    });
  });
  it('rejects invalid UTF-8', () => {
    assert.throws(
      () => encode(new Uint8Array([0xc0, 0x80]), { input: InputEncoding.Utf8 }),
      (e: unknown) => e instanceof QRError && e.code === Status.InvalidUtf8,
    );
  });
  it('rejects bad version range', () => {
    assert.throws(() => encode('x', { minVersion: 5, maxVersion: 2 }), (e: unknown) => {
      return e instanceof QRError && e.code === Status.VersionRange;
    });
  });
  it('rejects invalid shift-jis kanji in forced mode', () => {
    assert.throws(
      () =>
        encode(new Uint8Array([0x81, 0x7f]), {
          input: InputEncoding.ShiftJis,
          mode: Mode.Kanji,
        }),
      (e: unknown) => e instanceof QRError && e.code === Status.InvalidModeData,
    );
  });
});

describe('renderers', () => {
  it('ascii / svg / packed rows', () => {
    const code = encode('HELLO WORLD');
    const ascii = renderAscii(code);
    assert.ok(ascii.includes('##'));
    assert.ok(ascii.endsWith('\n'));
    const svg = renderSvg(code);
    assert.ok(svg.startsWith('<svg '));
    assert.ok(svg.includes('<path'));
    const packed = packRows(code);
    assert.equal(packed.length, code.size * Math.ceil(code.size / 8));
    // Top-left finder corner module is dark -> first bit set.
    assert.equal(packed[0] & 0x80, 0x80);
  });
});

describe('self decode sanity', () => {
  it('round-trips a mixed-mode string', () => {
    const code = encode('ABC12345678901234567890');
    const { bytes } = decodeMatrix(code.modules, code.size);
    assert.equal(Buffer.from(bytes).toString(), 'ABC12345678901234567890');
  });
});
