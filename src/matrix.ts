// Matrix builder: function patterns, zigzag placement, masking, penalty.
// Port of detail/matrix.inc.h. Cells carry value bit 0 plus function flag 2.
import type { EccLevel, QrCode } from './types.ts';
import { ALIGN_COUNT, ALIGN_POS, FORMAT_BITS, VERSION_BITS } from './tables.core.generated.ts';
import { rawDataModules, dataCodewords } from './capacity.ts';

const FUNC = 2;

function setFunc(cells: Uint8Array, size: number, x: number, y: number, dark: boolean): void {
  cells[y * size + x] = (dark ? 1 : 0) | FUNC;
}

function drawFinder(cells: Uint8Array, size: number, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunc(cells, size, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(cells: Uint8Array, size: number, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunc(cells, size, cx + dx, cy + dy, dist !== 1);
    }
  }
}

function drawFunctionPatterns(cells: Uint8Array, size: number, version: number, ecc: number): void {
  for (let i = 0; i < size; i++) {
    setFunc(cells, size, 6, i, (i & 1) === 0);
    setFunc(cells, size, i, 6, (i & 1) === 0);
  }
  drawFinder(cells, size, 3, 3);
  drawFinder(cells, size, size - 4, 3);
  drawFinder(cells, size, 3, size - 4);
  const positions = ALIGN_POS[version];
  const count = ALIGN_COUNT[version];
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue;
      drawAlignment(cells, size, positions[i], positions[j]);
    }
  }
  // Dummy format value reserves all format modules before data placement.
  drawFormatBits(cells, size, ecc, 0);
  if (version >= 7) {
    const bits = VERSION_BITS[version];
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(cells, size, a, b, dark);
      setFunc(cells, size, b, a, dark);
    }
  }
}

function drawFormatBits(cells: Uint8Array, size: number, ecc: number, mask: number): void {
  const bits = FORMAT_BITS[ecc & 3][mask & 7];
  for (let i = 0; i <= 5; i++) setFunc(cells, size, 8, i, ((bits >> i) & 1) !== 0);
  setFunc(cells, size, 8, 7, ((bits >> 6) & 1) !== 0);
  setFunc(cells, size, 8, 8, ((bits >> 7) & 1) !== 0);
  setFunc(cells, size, 7, 8, ((bits >> 8) & 1) !== 0);
  for (let i = 9; i < 15; i++) setFunc(cells, size, 14 - i, 8, ((bits >> i) & 1) !== 0);
  for (let i = 0; i < 8; i++) setFunc(cells, size, size - 1 - i, 8, ((bits >> i) & 1) !== 0);
  for (let i = 8; i < 15; i++) setFunc(cells, size, 8, size - 15 + i, ((bits >> i) & 1) !== 0);
  setFunc(cells, size, 8, size - 8, true);
}

function drawCodewords(cells: Uint8Array, size: number, version: number, stream: Uint8Array): void {
  let bit = 0;
  const limit = rawDataModules(version);
  const dataBits = limit & ~7;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        const index = y * size + x;
        if ((cells[index] & FUNC) === 0 && bit < limit) {
          // Remainder bits past the last full codeword are defined as light.
          cells[index] = bit < dataBits ? (stream[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
          bit++;
        }
      }
    }
  }
}

export function maskInvert(mask: number, x: number, y: number): boolean {
  switch (mask & 7) {
    case 0:
      return ((x + y) & 1) === 0;
    case 1:
      return (y & 1) === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (((Math.floor(x / 3) + Math.floor(y / 2)) & 1) === 0);
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return ((((x * y) % 2) + ((x * y) % 3)) & 1) === 0;
    default:
      return ((((x + y) & 1) + ((x * y) % 3)) & 1) === 0;
  }
}

function applyMask(cells: Uint8Array, size: number, mask: number): void {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = y * size + x;
      if ((cells[index] & FUNC) === 0 && maskInvert(mask, x, y)) cells[index] ^= 1;
    }
  }
}

function linePenalty(cells: Uint8Array, offset: number, stride: number, size: number): number {
  let runDark = false;
  let runLength = 0;
  let h0 = 0;
  let h1 = 0;
  let h2 = 0;
  let h3 = 0;
  let h4 = 0;
  let h5 = 0;
  let h6 = 0;
  let result = 0;
  const push = (value: number): void => {
    let v = value;
    if (h0 === 0) v += size;
    h6 = h5;
    h5 = h4;
    h4 = h3;
    h3 = h2;
    h2 = h1;
    h1 = h0;
    h0 = v;
  };
  const count = (): void => {
    const n = h1;
    const core = n > 0 && h2 === n && h3 === n * 3 && h4 === n && h5 === n;
    if (core && h0 >= n * 4 && h6 >= n) result += 40;
    if (core && h6 >= n * 4 && h0 >= n) result += 40;
  };
  for (let i = 0; i < size; i++) {
    const dark = (cells[offset + i * stride] & 1) !== 0;
    if (dark === runDark) {
      runLength++;
    } else {
      if (runLength >= 5) result += 3 + runLength - 5;
      push(runLength);
      if (!runDark) count();
      runDark = dark;
      runLength = 1;
    }
  }
  if (runLength >= 5) result += 3 + runLength - 5;
  if (runDark) {
    push(runLength);
    runLength = 0;
  }
  runLength += size;
  push(runLength);
  count();
  return result;
}

export function penaltyScore(cells: Uint8Array, size: number): number {
  let result = 0;
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    result += linePenalty(cells, row, 1, size);
    const next = y + 1 < size ? row + size : -1;
    for (let x = 0; x < size; x++) {
      const dark = (cells[row + x] & 1) !== 0;
      if (dark) darkCount++;
      if (next !== -1 && x + 1 < size) {
        const a = (cells[row + x + 1] & 1) !== 0;
        const b = (cells[next + x] & 1) !== 0;
        const c = (cells[next + x + 1] & 1) !== 0;
        if (dark === a && dark === b && dark === c) result += 3;
      }
    }
  }
  for (let x = 0; x < size; x++) result += linePenalty(cells, x, size, size);
  const total = size * size;
  const diff = Math.abs(darkCount * 20 - total * 10);
  let k = Math.floor((diff + total - 1) / total) - 1;
  if (k < 0) k = 0;
  return result + k * 10;
}

export function buildMatrix(
  stream: Uint8Array,
  version: number,
  ecc: EccLevel,
  requestedMask: number,
  modeMask: number,
): QrCode {
  const size = version * 4 + 17;
  const cells = new Uint8Array(size * size);
  drawFunctionPatterns(cells, size, version, ecc);
  drawCodewords(cells, size, version, stream);

  let bestMask = 0;
  let bestPenalty = 0xffffffff;
  if (requestedMask < 0) {
    const scratch = cells.slice();
    for (let mask = 0; mask < 8; mask++) {
      cells.set(scratch);
      applyMask(cells, size, mask);
      drawFormatBits(cells, size, ecc, mask);
      const penalty = penaltyScore(cells, size);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestMask = mask;
      }
    }
    cells.set(scratch);
  } else {
    bestMask = requestedMask;
  }
  applyMask(cells, size, bestMask);
  drawFormatBits(cells, size, ecc, bestMask);
  if (bestPenalty === 0xffffffff) bestPenalty = penaltyScore(cells, size);

  const modules = new Uint8Array(size * size);
  for (let i = 0; i < modules.length; i++) modules[i] = cells[i] & 1;
  return {
    version,
    size,
    ecc,
    mask: bestMask,
    modeMask,
    dataCodewords: dataCodewords(version, ecc),
    totalCodewords: Math.floor(rawDataModules(version) / 8),
    penalty: bestPenalty >>> 0,
    modules,
  };
}

/** Function-module map for decoders: 1 = function module. */
export function createFunctionMap(version: number): { size: number; func: Uint8Array } {
  const size = version * 4 + 17;
  const cells = new Uint8Array(size * size);
  drawFunctionPatterns(cells, size, version, 0);
  const func = new Uint8Array(size * size);
  for (let i = 0; i < func.length; i++) func[i] = (cells[i] & FUNC) !== 0 ? 1 : 0;
  return { size, func };
}
