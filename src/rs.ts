// Reed-Solomon encode remainder plus Euclidean/Chien/Forney decoder.
// Field: GF(256), poly 0x11d, primitive element 2, roots alpha^0..alpha^(d-1).
import {
  RS_GENERATOR,
  GF_EXP,
  GF_LOG,
  ECC_PER_BLOCK,
  NUM_BLOCKS,
} from './tables.core.generated.ts';
import { MAX_RS_DEGREE, Status, QRError } from './types.ts';
import { gfMul, gfInv } from './gf.ts';
import { rawDataModules, dataCodewords } from './capacity.ts';

function expOf(i: number): number {
  return GF_EXP[i % 255];
}

export function rsRemainder(data: Uint8Array, dataLength: number, degree: number, out: Uint8Array): void {
  const generator = RS_GENERATOR[degree];
  const rem = new Uint8Array(MAX_RS_DEGREE);
  for (let i = 0; i < dataLength; i++) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j + 1 < degree; j++) rem[j] = rem[j + 1] ^ gfMul(generator[j], factor);
    rem[degree - 1] = gfMul(generator[degree - 1], factor);
  }
  for (let i = 0; i < degree; i++) out[i] = rem[i];
}

// --- Decoder polynomials (coefficients highest power first) ---

interface Poly {
  c: number[];
}

function polyZero(): Poly {
  return { c: [0] };
}

function polyMonomial(degree: number, value: number): Poly {
  const c = new Array<number>(degree + 1).fill(0);
  c[0] = value;
  return { c };
}

function polyTrim(p: Poly): void {
  let first = 0;
  while (first + 1 < p.c.length && p.c[first] === 0) first++;
  if (first !== 0) p.c = p.c.slice(first);
}

function polyDegree(p: Poly): number {
  return p.c.length - 1;
}

function polyIsZero(p: Poly): boolean {
  return p.c.length === 1 && p.c[0] === 0;
}

function polyEval(p: Poly, x: number): number {
  let r = 0;
  for (let i = 0; i < p.c.length; i++) r = gfMul(r, x) ^ p.c[i];
  return r;
}

function polyAdd(a: Poly, b: Poly): Poly {
  const n = Math.max(a.c.length, b.c.length);
  const c = new Array<number>(n).fill(0);
  for (let i = 0; i < a.c.length; i++) c[n - a.c.length + i] ^= a.c[i];
  for (let i = 0; i < b.c.length; i++) c[n - b.c.length + i] ^= b.c[i];
  const out = { c };
  polyTrim(out);
  return out;
}

function polyMultiply(a: Poly, b: Poly): Poly | null {
  if (a.c.length + b.c.length - 1 > MAX_RS_DEGREE + 1) return null;
  const c = new Array<number>(a.c.length + b.c.length - 1).fill(0);
  for (let i = 0; i < a.c.length; i++)
    for (let j = 0; j < b.c.length; j++) c[i + j] ^= gfMul(a.c[i], b.c[j]);
  const out = { c };
  polyTrim(out);
  return out;
}

function polyMultiplyMonomial(p: Poly, degree: number, value: number): Poly | null {
  if (value === 0) return polyZero();
  if (p.c.length + degree > MAX_RS_DEGREE + 1) return null;
  const c = new Array<number>(p.c.length + degree).fill(0);
  for (let i = 0; i < p.c.length; i++) c[i] = gfMul(p.c[i], value);
  const out = { c };
  polyTrim(out);
  return out;
}

function polyDivide(left: Poly, right: Poly): { q: Poly; r: Poly } | null {
  if (polyIsZero(right)) return null;
  let q = polyZero();
  let r: Poly = { c: left.c.slice() };
  const invLeading = gfInv(right.c[0]);
  for (let guard = 0; guard < MAX_RS_DEGREE + 2; guard++) {
    if (polyDegree(r) < polyDegree(right) || polyIsZero(r)) return { q, r };
    const dd = polyDegree(r) - polyDegree(right);
    const scale = gfMul(r.c[0], invLeading);
    q = polyAdd(q, polyMonomial(dd, scale));
    const shifted = polyMultiplyMonomial(right, dd, scale);
    if (!shifted) return null;
    r = polyAdd(r, shifted);
  }
  return null;
}

/** Interleave data blocks, append ECC, return the full codeword stream. */
export function addEccAndInterleave(data: Uint8Array, version: number, ecc: number): Uint8Array {
  const blockCount = NUM_BLOCKS[ecc][version];
  const eccLength = ECC_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlockCount = blockCount - (rawCodewords % blockCount);
  const shortBlockTotal = Math.floor(rawCodewords / blockCount);
  const shortDataLength = shortBlockTotal - eccLength;
  const dataWords = dataCodewords(version, ecc);
  const stream = new Uint8Array(rawCodewords);
  const parity = new Uint8Array(MAX_RS_DEGREE);
  let dataPos = 0;
  for (let block = 0; block < blockCount; block++) {
    const dataLength = shortDataLength + (block < shortBlockCount ? 0 : 1);
    rsRemainder(data.subarray(dataPos, dataPos + dataLength), dataLength, eccLength, parity);
    for (let j = 0; j < dataLength; j++) {
      let index = block + j * blockCount;
      if (j === shortDataLength) index -= shortBlockCount;
      stream[index] = data[dataPos + j];
    }
    for (let j = 0; j < eccLength; j++) {
      stream[dataWords + block + j * blockCount] = parity[j];
    }
    dataPos += dataLength;
  }
  return stream;
}

/** Correct one block in place. Returns the number of corrected codewords. */
export function rsDecodeBlock(received: Uint8Array, length: number, degree: number): number {
  if (degree === 0 || degree > MAX_RS_DEGREE || length === 0) {
    throw new QRError(Status.InvalidArgument, 'bad RS block');
  }
  const syndrome: Poly = { c: new Array<number>(degree).fill(0) };
  let noError = true;
  for (let i = 0; i < degree; i++) {
    const root = expOf(i);
    let v = 0;
    for (let j = 0; j < length; j++) v = gfMul(v, root) ^ received[j];
    syndrome.c[degree - 1 - i] = v;
    if (v !== 0) noError = false;
  }
  if (noError) return 0;
  polyTrim(syndrome);

  let rLast: Poly = polyMonomial(degree, 1);
  let r: Poly = { c: syndrome.c.slice() };
  let tLast: Poly = polyZero();
  let t: Poly = polyMonomial(0, 1);
  let guard = 0;
  while (polyDegree(r) * 2 >= degree) {
    if (++guard > MAX_RS_DEGREE + 2) throw new QRError(Status.DecodeEcc);
    const rll = rLast;
    const tll = tLast;
    rLast = r;
    tLast = t;
    const div = polyDivide(rll, rLast);
    if (!div) throw new QRError(Status.DecodeEcc);
    const prod = polyMultiply(div.q, tLast);
    if (!prod) throw new QRError(Status.DecodeEcc);
    t = polyAdd(prod, tll);
    r = div.r;
    if (polyDegree(r) >= polyDegree(rLast)) throw new QRError(Status.DecodeEcc);
  }
  if (polyIsZero(t)) throw new QRError(Status.DecodeEcc);
  const scale = gfInv(t.c[t.c.length - 1]);
  for (let i = 0; i < t.c.length; i++) t.c[i] = gfMul(t.c[i], scale);
  for (let i = 0; i < r.c.length; i++) r.c[i] = gfMul(r.c[i], scale);

  const errors = polyDegree(t);
  if (errors === 0 || errors > Math.floor(degree / 2)) throw new QRError(Status.DecodeEcc);
  const locations: number[] = [];
  for (let f = 1; f < 256 && locations.length < errors; f++) {
    if (polyEval(t, f) === 0) {
      const loc = gfInv(f);
      if (!locations.includes(loc)) locations.push(loc);
    }
  }
  if (locations.length !== errors) throw new QRError(Status.DecodeEcc);

  for (let i = 0; i < errors; i++) {
    const xi = gfInv(locations[i]);
    let denom = 1;
    for (let j = 0; j < errors; j++) {
      if (i === j) continue;
      let term = gfMul(locations[j], xi);
      term = (term & 1) !== 0 ? term ^ 1 : term | 1;
      denom = gfMul(denom, term);
    }
    const magnitude = gfMul(polyEval(r, xi), gfInv(denom));
    const pos = length - 1 - GF_LOG[locations[i]];
    if (pos < 0 || pos >= length) throw new QRError(Status.DecodeEcc);
    received[pos] ^= magnitude;
  }
  for (let i = 0; i < degree; i++) {
    const root = expOf(i);
    let v = 0;
    for (let j = 0; j < length; j++) v = gfMul(v, root) ^ received[j];
    if (v !== 0) throw new QRError(Status.DecodeEcc);
  }
  return errors;
}
