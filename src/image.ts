// Image decoder: finder detection, affine sampling, Otsu fallback.
// Port of detail/decoder_image.inc.h.
import {
  Status,
  QRError,
  type DecodeInfo,
  type DecodeOptions,
  type ImageView,
  type KanjiHooks,
  defaultDecodeOptions,
} from './types.ts';
import { decodeNormalized } from './decoder.ts';

const MAX_FINDERS = 48;
const MAX_RUNS = 2048;
const MAX_IMAGE_DIMENSION = 65535;

interface Source {
  pixels: Uint8Array;
  width: number;
  height: number;
  stride: number;
  packed: boolean;
  threshold: number;
  darkWhenLow: boolean;
  invert: boolean;
}

interface Finder {
  x: number;
  y: number;
  module: number;
  score: number;
}

function sample(src: Source, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= src.width || y >= src.height) return false;
  let v: boolean;
  if (src.packed) {
    const index = y * src.stride + (x >> 3);
    v = ((src.pixels[index] >> (7 - (x & 7))) & 1) !== 0;
  } else {
    const pixel = src.pixels[y * src.stride + x];
    v = src.darkWhenLow ? pixel <= src.threshold : pixel >= src.threshold;
  }
  return src.invert ? !v : v;
}

class RunScratch {
  lengths = new Uint32Array(MAX_RUNS);
  starts = new Uint32Array(MAX_RUNS);
  colors = new Uint8Array(MAX_RUNS);
}

function collectRuns(src: Source, horizontal: boolean, fixed: number, scratch: RunScratch): number {
  const { lengths, starts, colors } = scratch;
  let count = 0;
  let pos = 0;
  const limit = horizontal ? src.width : src.height;
  while (pos < limit && count < MAX_RUNS) {
    const color = horizontal ? sample(src, pos, fixed) : sample(src, fixed, pos);
    const start = pos++;
    while (pos < limit && count < MAX_RUNS) {
      const next = horizontal ? sample(src, pos, fixed) : sample(src, fixed, pos);
      if (next !== color) break;
      pos++;
    }
    starts[count] = start;
    lengths[count] = pos - start;
    colors[count] = color ? 1 : 0;
    count++;
    if (count === MAX_RUNS && pos < limit) return 0;
  }
  return count;
}

const RATIO_FACTORS = [1, 1, 3, 1, 1];

function ratioMatch(
  lengths: Uint32Array,
  colors: Uint8Array,
  start: number,
): { module: number; offset: number } | null {
  let total = 0;
  for (let i = 0; i < 5; i++) {
    if ((colors[start + i] !== 0) !== ((i & 1) === 0)) return null;
    total += lengths[start + i];
  }
  if (total < 7) return null;
  const unit = Math.floor(total / 7);
  const tolerance = Math.floor(unit / 2) + 1;
  for (let i = 0; i < 5; i++) {
    const expected = unit * RATIO_FACTORS[i];
    const diff = Math.abs(lengths[start + i] - expected);
    if (diff > tolerance) return null;
  }
  return { module: unit === 0 ? 1 : unit, offset: Math.floor(total / 2) };
}

function patternOnLine(
  src: Source,
  horizontal: boolean,
  fixed: number,
  expectedCenter: number,
  scratch: RunScratch,
): { module: number; center: number } | null {
  const count = horizontal
    ? collectRuns(src, true, fixed, scratch)
    : collectRuns(src, false, fixed, scratch);
  if (count < 5) return null;
  let found: { module: number; center: number } | null = null;
  let bestDist = 0xffffffff;
  for (let i = 0; i + 5 <= count; i++) {
    const m = ratioMatch(scratch.lengths, scratch.colors, i);
    if (!m) continue;
    const absolute = scratch.starts[i] + m.offset;
    const dist = Math.abs(absolute - expectedCenter);
    const tolerance = m.module * 2 + 2;
    if (dist <= tolerance && dist < bestDist) {
      bestDist = dist;
      found = { module: m.module, center: absolute };
    }
  }
  return found;
}

function verifyFinder(src: Source, cx: number, cy: number, modulePixels: number): boolean {
  const module = modulePixels === 0 ? 1 : modulePixels;
  let mismatches = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const expected = dist !== 2;
      const x = cx + dx * module;
      const y = cy + dy * module;
      if (x < 0 || y < 0 || x >= src.width || y >= src.height) return false;
      const px = x | 0;
      const py = y | 0;
      if (px < 0 || py < 0 || px >= src.width || py >= src.height) return false;
      if (sample(src, px, py) !== expected && ++mismatches > 4) return false;
    }
  }
  return mismatches <= 4;
}

function addFinder(finders: Finder[], f: Finder): void {
  for (const e of finders) {
    const dx = f.x - e.x;
    const dy = f.y - e.y;
    const r = Math.max(f.module, e.module);
    if (dx * dx + dy * dy <= r * r * 4) {
      e.x = Math.floor((e.x + f.x) / 2);
      e.y = Math.floor((e.y + f.y) / 2);
      e.module = Math.floor((e.module + f.module) / 2);
      if (f.score < e.score) e.score = f.score;
      return;
    }
  }
  if (finders.length < MAX_FINDERS) finders.push({ ...f });
}

function findFinders(src: Source, outer: RunScratch, inner: RunScratch): Finder[] {
  const finders: Finder[] = [];
  for (let y = 0; y < src.height; y++) {
    const count = collectRuns(src, true, y, outer);
    if (count < 5) continue;
    // NOTE: outer and inner must be distinct buffers: patternOnLine
    // collects its own runs and would otherwise clobber this row scan
    // (in C each function owns its stack arrays).
    for (let i = 0; i + 5 <= count; i++) {
      const m = ratioMatch(outer.lengths, outer.colors, i);
      if (!m) continue;
      const cx = outer.starts[i] + m.offset;
      const v = patternOnLine(src, false, cx, y, inner);
      if (!v) continue;
      const diff = Math.abs(m.module - v.module);
      if (diff * 4 > m.module + v.module) continue;
      const avg = Math.floor((m.module + v.module) / 2);
      if (!verifyFinder(src, cx, v.center, avg)) continue;
      addFinder(finders, { x: cx, y: v.center, module: avg, score: diff });
    }
  }
  finders.sort((a, b) => a.score - b.score);
  return finders;
}

function sampleGeometry(
  src: Source,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  version: number,
  mirror: boolean,
  out: Uint8Array,
): boolean {
  const size = version * 4 + 17;
  const span = 10 + 4 * version;
  const ux = (bx - ax) / span;
  const uy = (by - ay) / span;
  const vx = (cx - ax) / span;
  const vy = (cy - ay) / span;
  const det = ux * vy - uy * vx;
  if (det > -0.05 && det < 0.05) return false;
  const ox = ax - 3.5 * (ux + vx);
  const oy = ay - 3.5 * (uy + vy);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ox2 = mirror ? size - 1 - x : x;
      const sx = Math.trunc(ox + (ox2 + 0.5) * ux + (y + 0.5) * vx);
      const sy = Math.trunc(oy + (ox2 + 0.5) * uy + (y + 0.5) * vy);
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) return false;
      out[y * size + x] = sample(src, sx, sy) ? 1 : 0;
    }
  }
  return true;
}

function vecLength(x: number, y: number): number {
  const v = x * x + y * y;
  if (v <= 0) return 0;
  let e = v > 1 ? (v + 1) * 0.5 : 1;
  for (let i = 0; i < 8; i++) e = (e + v / e) * 0.5;
  return e;
}

function estimateVersion(distance: number, modulePixels: number): number {
  if (modulePixels <= 0) return 1;
  const v = Math.floor((distance / modulePixels - 10) / 4 + 0.5);
  return Math.min(40, Math.max(1, v));
}

function geometryPlausible(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  modulePixels: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;
  const d2x = dx * dx + dy * dy;
  const d2y = ex * ex + ey * ey;
  if (d2x < 4 || d2y < 4) return false;
  const cross = dx * ey - dy * ex;
  if (cross > -1 && cross < 1) return false;
  const dot = dx * ex + dy * ey;
  if (dot * dot * 4 > d2x * d2y) return false;
  const ex1 = estimateVersion(vecLength(dx, dy), modulePixels);
  const ey1 = estimateVersion(vecLength(ex, ey), modulePixels);
  return ex1 <= ey1 + 1 && ey1 <= ex1 + 1;
}

function otsuThreshold(src: Source): number {
  const hist = new Array<number>(256).fill(0);
  let total = 0;
  for (let y = 0; y < src.height; y++) {
    const row = y * src.stride;
    for (let x = 0; x < src.width; x++) {
      hist[src.pixels[row + x]]++;
      total++;
    }
  }
  if (total === 0) return -1;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let bestT = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT;
}

const ORDERS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

export interface ImageResult {
  bytes: Uint8Array;
  info: DecodeInfo;
}

export function decodeImageInternal(
  source: Source,
  options: Partial<DecodeOptions> | undefined,
  utf8: boolean,
  hooks: KanjiHooks,
): ImageResult {
  if (!source.pixels || source.width === 0 || source.height === 0) {
    throw new QRError(Status.InvalidArgument);
  }
  if (source.width > MAX_IMAGE_DIMENSION || source.height > MAX_IMAGE_DIMENSION) {
    throw new QRError(Status.InvalidArgument);
  }
  const o: DecodeOptions = { ...defaultDecodeOptions(), ...options };
  const outer = new RunScratch();
  const inner = new RunScratch();
  const matrix = new Uint8Array(177 * 177);
  let lastError: QRError = new QRError(Status.NotFound);

  const thresholds = [source.threshold];
  if (!source.packed) {
    const otsu = otsuThreshold(source);
    if (otsu >= 0 && otsu !== source.threshold) thresholds.push(otsu);
  }
  const polarities = o.tryInverted ? 2 : 1;

  for (const threshold of thresholds) {
    for (let p = 0; p < polarities; p++) {
      const active: Source = { ...source, threshold, invert: source.invert !== (p !== 0) };
      let finders = findFinders(active, outer, inner);
      if (finders.length > 10) finders = finders.slice(0, 10);
      const orderCount = o.tryRotations ? 6 : 1;
      for (let i = 0; i < finders.length; i++) {
        for (let j = i + 1; j < finders.length; j++) {
          for (let k = j + 1; k < finders.length; k++) {
            const local = [i, j, k];
            for (let oi = 0; oi < orderCount; oi++) {
              const a = finders[local[ORDERS[oi][0]]];
              const b = finders[local[ORDERS[oi][1]]];
              const c = finders[local[ORDERS[oi][2]]];
              const module = Math.floor((a.module + b.module + c.module) / 3);
              const ax = a.x + 0.5;
              const ay = a.y + 0.5;
              const bx = b.x + 0.5;
              const by = b.y + 0.5;
              const cx = c.x + 0.5;
              const cy = c.y + 0.5;
              if (!geometryPlausible(ax, ay, bx, by, cx, cy, module)) continue;
              const dx = bx - ax;
              const dy = by - ay;
              const ex = cx - ax;
              const ey = cy - ay;
              let estX = estimateVersion(vecLength(dx, dy), module);
              let estY = estimateVersion(vecLength(ex, ey), module);
              if (estX > estY + 1) estX = estY;
              if (estY > estX + 1) estY = estX;
              const center = Math.floor((estX + estY) / 2);
              for (let delta = -2; delta <= 2; delta++) {
                const version = center + delta;
                if (version < 1 || version > 40) continue;
                const mirrors = o.tryMirror ? 2 : 1;
                for (let m = 0; m < mirrors; m++) {
                  if (
                    !sampleGeometry(active, ax, ay, bx, by, cx, cy, version, m !== 0, matrix)
                  )
                    continue;
                  const size = version * 4 + 17;
                  try {
                    const r = decodeNormalized(matrix.subarray(0, size * size), size, utf8, hooks);
                    const info: DecodeInfo = {
                      version: r.version,
                      size: r.size,
                      ecc: r.ecc,
                      mask: r.mask,
                      modeMask: r.modeMask,
                      orientation: m << 2,
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
                    } else throw e;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  throw lastError;
}

export function toImageSource(view: ImageView, packed: boolean, options?: Partial<DecodeOptions>): Source {
  const o: DecodeOptions = { ...defaultDecodeOptions(), ...options };
  return {
    pixels: view.pixels,
    width: view.width,
    height: view.height,
    stride: view.stride,
    packed,
    threshold: o.threshold,
    darkWhenLow: o.darkWhenLow,
    invert: false,
  };
}
