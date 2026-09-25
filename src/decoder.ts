// QR decoder core: format info, deinterleave + RS correction, payload
// parsing, normalized-matrix decoding with orientation retries.
// Port of detail/decoder.inc.h.
import {
  Status,
  QRError,
  MAX_INPUT_BYTES,
  type DecodeInfo,
  type DecodeOptions,
  type EccLevel,
  type KanjiHooks,
  defaultDecodeOptions,
} from './types.ts';
import { FORMAT_BITS, NUM_BLOCKS, ECC_PER_BLOCK } from './tables.core.generated.ts';
import { rawDataModules, dataCodewords, versionGroup } from './capacity.ts';
import { maskInvert } from './matrix.ts';
import { createFunctionMap } from './matrix.ts';
import { rsDecodeBlock } from './rs.ts';
import { kanjiToShiftJis } from './kanjiCommon.ts';

const COUNT_WIDTHS = [
  [10, 12, 14],
  [9, 11, 13],
  [8, 16, 16],
  [8, 10, 12],
];

function bitAt(matrix: Uint8Array, size: number, x: number, y: number): number {
  return matrix[y * size + x] !== 0 ? 1 : 0;
}

function readFormatCopy(matrix: Uint8Array, size: number, second: boolean): number {
  let bits = 0;
  if (!second) {
    for (let i = 0; i <= 5; i++) bits |= bitAt(matrix, size, 8, i) << i;
    bits |= bitAt(matrix, size, 8, 7) << 6;
    bits |= bitAt(matrix, size, 8, 8) << 7;
    bits |= bitAt(matrix, size, 7, 8) << 8;
    for (let i = 9; i < 15; i++) bits |= bitAt(matrix, size, 14 - i, 8) << i;
  } else {
    for (let i = 0; i < 8; i++) bits |= bitAt(matrix, size, size - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) bits |= bitAt(matrix, size, 8, size - 15 + i) << i;
  }
  return bits;
}

function hamming16(a: number, b: number): number {
  let d = (a ^ b) & 0xffff;
  let c = 0;
  while (d !== 0) {
    d &= d - 1;
    c++;
  }
  return c;
}

function bestFormat(word: number): { ecc: number; mask: number; distance: number } {
  let best = 16;
  let be = 0;
  let bm = 0;
  for (let level = 0; level < 4; level++) {
    for (let m = 0; m < 8; m++) {
      const d = hamming16(word, FORMAT_BITS[level][m]);
      if (d < best) {
        best = d;
        be = level;
        bm = m;
      }
    }
  }
  return { ecc: be, mask: bm, distance: best };
}

function readFormat(matrix: Uint8Array, size: number): { ecc: EccLevel; mask: number } {
  const first = readFormatCopy(matrix, size, false);
  const second = readFormatCopy(matrix, size, true);
  const a = bestFormat(first);
  const b = bestFormat(second);
  if (a.distance <= 3 && b.distance <= 3) {
    if (a.ecc !== b.ecc || a.mask !== b.mask) throw new QRError(Status.DecodeFormat);
    return { ecc: a.ecc as EccLevel, mask: a.mask };
  }
  if (a.distance <= 3) return { ecc: a.ecc as EccLevel, mask: a.mask };
  if (b.distance <= 3) return { ecc: b.ecc as EccLevel, mask: b.mask };
  throw new QRError(Status.DecodeFormat);
}

function deinterleaveAndCorrect(
  received: Uint8Array,
  version: number,
  ecc: number,
): { data: Uint8Array; corrected: number } {
  const blockCount = NUM_BLOCKS[ecc][version];
  const eccLength = ECC_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const dataWords = dataCodewords(version, ecc);
  const shortBlockCount = blockCount - (rawCodewords % blockCount);
  const shortBlockTotal = Math.floor(rawCodewords / blockCount);
  const shortDataLength = shortBlockTotal - eccLength;
  const data = new Uint8Array(dataWords);
  const block = new Uint8Array(256);
  let dataPos = 0;
  let corrected = 0;
  for (let b = 0; b < blockCount; b++) {
    const dataLength = shortDataLength + (b < shortBlockCount ? 0 : 1);
    for (let j = 0; j < dataLength; j++) {
      let src = b + j * blockCount;
      if (j === shortDataLength) src -= shortBlockCount;
      block[j] = received[src];
    }
    for (let j = 0; j < eccLength; j++) block[dataLength + j] = received[dataWords + b + j * blockCount];
    corrected += rsDecodeBlock(block, dataLength + eccLength, eccLength);
    for (let j = 0; j < dataLength; j++) data[dataPos + j] = block[j];
    dataPos += dataLength;
  }
  if (dataPos !== dataWords) throw new QRError(Status.DecodeEcc);
  return { data, corrected };
}

class BitReader {
  pos = 0;
  bytes: Uint8Array;
  bitLength: number;
  constructor(bytes: Uint8Array, bitLength: number) {
    this.bytes = bytes;
    this.bitLength = bitLength;
  }
  read(count: number): number {
    if (count > 24 || this.pos + count > this.bitLength) throw new QRError(Status.DecodeMode);
    let r = 0;
    for (let i = 0; i < count; i++) {
      const p = this.pos++;
      r = (r << 1) | ((this.bytes[p >> 3] >> (7 - (p & 7))) & 1);
    }
    return r >>> 0;
  }
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function parsePayload(
  data: Uint8Array,
  dataWords: number,
  version: number,
  utf8: boolean,
  hooks: KanjiHooks,
): { bytes: Uint8Array; modeMask: number } {
  const reader = new BitReader(data, dataWords * 8);
  const out: number[] = [];
  let modeMask = 0;
  for (;;) {
    if (reader.pos === reader.bitLength) break; // Exact fit: no terminator present.
    if (reader.pos + 4 > reader.bitLength) {
      // Short terminator fragment: all remaining bits must be zero.
      while (reader.pos < reader.bitLength) {
        if (reader.read(1) !== 0) throw new QRError(Status.DecodeMode);
      }
      break;
    }
    const mode = reader.read(4);
    if (mode === 0) {
      while ((reader.pos & 7) !== 0) {
        if (reader.read(1) !== 0) throw new QRError(Status.DecodeMode);
      }
      while (reader.pos + 8 <= reader.bitLength) {
        const pad = reader.read(8);
        if (pad !== 0xec && pad !== 0x11) throw new QRError(Status.DecodeMode);
      }
      while (reader.pos < reader.bitLength) {
        if (reader.read(1) !== 0) throw new QRError(Status.DecodeMode);
      }
      break;
    }
    if (mode === 0x7) {
      const first = reader.read(8);
      if ((first & 0x80) === 0) {
        // 8-bit ECI designator consumed.
      } else if ((first & 0xc0) === 0x80) {
        reader.read(8);
      } else if ((first & 0xe0) === 0xc0) {
        reader.read(16);
      } else {
        throw new QRError(Status.DecodeMode);
      }
      continue;
    }
    if (mode !== 0x1 && mode !== 0x2 && mode !== 0x4 && mode !== 0x8) {
      throw new QRError(Status.DecodeMode);
    }
    const internal = mode === 0x1 ? 0 : mode === 0x2 ? 1 : mode === 0x4 ? 2 : 3;
    const group = versionGroup(version);
    const cw = COUNT_WIDTHS[internal][group < 3 ? group : 2];
    const count = reader.read(cw);
    if (count > MAX_INPUT_BYTES * 2) throw new QRError(Status.DecodeBuffer);
    modeMask |= 1 << internal;
    if (mode === 0x1) {
      const full = Math.floor(count / 3);
      for (let i = 0; i < full; i++) {
        const v = reader.read(10);
        if (v >= 1000) throw new QRError(Status.DecodeMode);
        out.push(0x30 + Math.floor(v / 100), 0x30 + (Math.floor(v / 10) % 10), 0x30 + (v % 10));
      }
      if (count % 3 === 2) {
        const v = reader.read(7);
        if (v >= 100) throw new QRError(Status.DecodeMode);
        out.push(0x30 + Math.floor(v / 10), 0x30 + (v % 10));
      } else if (count % 3 === 1) {
        const v = reader.read(4);
        if (v >= 10) throw new QRError(Status.DecodeMode);
        out.push(0x30 + v);
      }
    } else if (mode === 0x2) {
      const pairs = Math.floor(count / 2);
      for (let i = 0; i < pairs; i++) {
        const v = reader.read(11);
        if (v >= 45 * 45) throw new QRError(Status.DecodeMode);
        out.push(ALNUM.charCodeAt(Math.floor(v / 45)), ALNUM.charCodeAt(v % 45));
      }
      if ((count & 1) !== 0) {
        const v = reader.read(6);
        if (v >= 45) throw new QRError(Status.DecodeMode);
        out.push(ALNUM.charCodeAt(v));
      }
    } else if (mode === 0x4) {
      for (let i = 0; i < count; i++) out.push(reader.read(8));
    } else {
      for (let i = 0; i < count; i++) {
        const v = reader.read(13);
        if (utf8) {
          const cp = hooks.kanjiValueToCodePoint(v);
          if (cp < 0) throw new QRError(Status.DecodeMode);
          if (cp <= 0x7f) out.push(cp);
          else if (cp <= 0x7ff) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
          else {
            out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          }
        } else {
          const sjis = { high: 0, low: 0 };
          if (!kanjiToShiftJis(v, sjis)) throw new QRError(Status.DecodeBuffer);
          out.push(sjis.high, sjis.low);
        }
      }
    }
  }
  return { bytes: Uint8Array.from(out), modeMask };
}

export interface NormalizedResult {
  bytes: Uint8Array;
  version: number;
  size: number;
  ecc: EccLevel;
  mask: number;
  modeMask: number;
  dataCodewords: number;
  totalCodewords: number;
  corrected: number;
}

export function decodeNormalized(
  matrix: Uint8Array,
  size: number,
  utf8: boolean,
  hooks: KanjiHooks,
): NormalizedResult {
  if (size < 21 || size > 177 || (size - 17) % 4 !== 0) throw new QRError(Status.DecodeVersion);
  const version = Math.floor((size - 17) / 4);
  const { ecc, mask } = readFormat(matrix, size);
  if (bitAt(matrix, size, 8, size - 8) === 0) throw new QRError(Status.DecodeFormat);
  const { func } = createFunctionMap(version);
  const work = matrix.slice();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (func[y * size + x] === 0 && maskInvert(mask, x, y)) work[y * size + x] ^= 1;
    }
  }
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const rawBits = rawDataModules(version);
  const received = new Uint8Array(rawCodewords);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (func[y * size + x] === 0) {
          if (bit < rawBits) {
            if (work[y * size + x] !== 0) received[bit >> 3] |= 1 << (7 - (bit & 7));
            bit++;
          } else if (work[y * size + x] !== 0) {
            throw new QRError(Status.DecodeFormat);
          }
        }
      }
    }
  }
  if (bit !== rawBits) throw new QRError(Status.DecodeFormat);
  const { data, corrected } = deinterleaveAndCorrect(received, version, ecc);
  const dataWords = dataCodewords(version, ecc);
  const { bytes, modeMask } = parsePayload(data, dataWords, version, utf8, hooks);
  return {
    bytes,
    version,
    size,
    ecc,
    mask,
    modeMask,
    dataCodewords: dataWords,
    totalCodewords: rawCodewords,
    corrected,
  };
}

export interface MatrixDecodeResult {
  bytes: Uint8Array;
  info: DecodeInfo;
}

export function decodeMatrixInternal(
  matrix: Uint8Array,
  width: number,
  height: number,
  stride: number,
  options: Partial<DecodeOptions> | undefined,
  utf8: boolean,
  hooks: KanjiHooks,
): MatrixDecodeResult {
  if (!matrix || width !== height || width < 21 || width > 177 || width % 4 !== 1 || stride < width) {
    throw new QRError(Status.InvalidArgument);
  }
  const o: DecodeOptions = { ...defaultDecodeOptions(), ...options };
  const size = width;
  const rotations = o.tryRotations ? 4 : 1;
  const mirrors = o.tryMirror ? 2 : 1;
  let lastError: QRError = new QRError(Status.NotFound);
  for (let mirror = 0; mirror < mirrors; mirror++) {
    for (let rotation = 0; rotation < rotations; rotation++) {
      const work = new Uint8Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const mx = mirror !== 0 ? size - 1 - x : x;
          let sx = mx;
          let sy = y;
          if (rotation === 1) {
            sx = y;
            sy = size - 1 - mx;
          } else if (rotation === 2) {
            sx = size - 1 - mx;
            sy = size - 1 - y;
          } else if (rotation === 3) {
            sx = size - 1 - y;
            sy = mx;
          }
          work[y * size + x] = matrix[sy * stride + sx] !== 0 ? 1 : 0;
        }
      }
      try {
        const r = decodeNormalized(work, size, utf8, hooks);
        const info: DecodeInfo = {
          version: r.version,
          size: r.size,
          ecc: r.ecc,
          mask: r.mask,
          modeMask: r.modeMask,
          orientation: rotation | (mirror << 2),
          dataLength: r.bytes.length,
          dataCodewords: r.dataCodewords,
          totalCodewords: r.totalCodewords,
          correctedCodewords: r.corrected,
        };
        return { bytes: r.bytes, info };
      } catch (e) {
        if (e instanceof QRError) {
          if (e.code === Status.DecodeBuffer) throw e;
          if (lastError.code === Status.NotFound) lastError = e;
        } else {
          throw e;
        }
      }
    }
  }
  throw lastError;
}
