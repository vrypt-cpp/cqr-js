import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode,
  decodeGray8,
  decodePacked,
  getModule,
  InputEncoding,
  Mode,
  Ecc,
  type QrCode,
} from '../src/index.ts';

function makeImage(code: QrCode, scale: number, border: number, invert: boolean): { pixels: Uint8Array; w: number } {
  const w = (code.size + border * 2) * scale;
  const pixels = new Uint8Array(w * w).fill(invert ? 0 : 255);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!getModule(code, x, y)) continue;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          pixels[((y + border) * scale + sy) * w + (x + border) * scale + sx] = invert ? 255 : 0;
        }
      }
    }
  }
  return { pixels, w };
}

function rotate90(pixels: Uint8Array, w: number): Uint8Array {
  const out = new Uint8Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) out[y * w + x] = pixels[(w - 1 - x) * w + y];
  return out;
}

describe('grayscale image decode', () => {
  for (const version of [1, 2, 7]) {
    for (const scale of [1, 2, 4]) {
      it(`v${version} scale${scale}`, () => {
        const input = new TextEncoder().encode('ABCDEFGHIJ');
        const code = encode(input, {
          input: InputEncoding.Bytes,
          mode: Mode.Byte,
          ecc: Ecc.M,
          minVersion: version,
          maxVersion: version,
        });
        const { pixels, w } = makeImage(code, scale, 4, false);
        const { bytes, info } = decodeGray8({ pixels, width: w, height: w, stride: w });
        assert.equal(info.version, version);
        assert.deepEqual(Buffer.from(bytes), Buffer.from(input));
      });
    }
  }

  it('v10 and v40 images', () => {
    for (const version of [10, 40]) {
      const input = new TextEncoder().encode('ABCDEFGHIJ');
      const code = encode(input, {
        input: InputEncoding.Bytes,
        mode: Mode.Byte,
        ecc: Ecc.M,
        minVersion: version,
        maxVersion: version,
      });
      const scale = version === 40 ? 1 : 2;
      const { pixels, w } = makeImage(code, scale, 4, false);
      const { bytes, info } = decodeGray8({ pixels, width: w, height: w, stride: w });
      assert.equal(info.version, version);
      assert.deepEqual(Buffer.from(bytes), Buffer.from(input));
    }
  });

  it('rotation, mirror and inversion', () => {
    const input = new TextEncoder().encode('ABCDEFGHIJ');
    const code = encode(input, {
      input: InputEncoding.Bytes,
      mode: Mode.Byte,
      ecc: Ecc.M,
      minVersion: 3,
      maxVersion: 3,
    });
    const { pixels, w } = makeImage(code, 2, 4, false);
    let rotated = rotate90(pixels, w);
    let r = decodeGray8({ pixels: rotated, width: w, height: w, stride: w });
    assert.deepEqual(Buffer.from(r.bytes), Buffer.from(input));
    // Mirror horizontally.
    const mirrored = new Uint8Array(w * w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) mirrored[y * w + x] = pixels[y * w + (w - 1 - x)];
    r = decodeGray8({ pixels: mirrored, width: w, height: w, stride: w });
    assert.deepEqual(Buffer.from(r.bytes), Buffer.from(input));
    // Inverted.
    const { pixels: inv } = makeImage(code, 2, 4, true);
    r = decodeGray8({ pixels: inv, width: w, height: w, stride: w });
    assert.deepEqual(Buffer.from(r.bytes), Buffer.from(input));
  });

  it('packed bitmap', () => {
    const input = new TextEncoder().encode('ABCDEFGHIJ');
    const code = encode(input, {
      input: InputEncoding.Bytes,
      mode: Mode.Byte,
      ecc: Ecc.M,
      minVersion: 7,
      maxVersion: 7,
    });
    const { pixels, w } = makeImage(code, 2, 4, false);
    const stride = Math.ceil(w / 8);
    const packed = new Uint8Array(stride * w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        if (pixels[y * w + x] < 128) packed[y * stride + (x >> 3)] |= 1 << (7 - (x & 7));
      }
    }
    const { bytes, info } = decodePacked({ pixels: packed, width: w, height: w, stride });
    assert.equal(info.version, 7);
    assert.deepEqual(Buffer.from(bytes), Buffer.from(input));
  });

  it('otsu fallback under uneven lighting', () => {
    const input = new TextEncoder().encode('OTSU TEST');
    const code = encode(input, {
      input: InputEncoding.Bytes,
      mode: Mode.Byte,
      ecc: Ecc.M,
      minVersion: 2,
      maxVersion: 2,
    });
    const { pixels, w } = makeImage(code, 3, 4, false);
    for (let y = 0; y < w / 2; y++) {
      for (let x = 0; x < w; x++) {
        if (pixels[y * w + x] === 0) pixels[y * w + x] = 60;
      }
    }
    const { bytes } = decodeGray8(
      { pixels, width: w, height: w, stride: w },
      { threshold: 10 },
    );
    assert.deepEqual(Buffer.from(bytes), Buffer.from(input));
  });
});
