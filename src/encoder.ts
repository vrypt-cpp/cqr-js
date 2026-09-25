// QR encoder: mode segmentation (linear DP with phase queues), bitstream
// packing, version selection. Faithful port of detail/encoder.inc.h.
import {
  Ecc,
  Mode,
  InputEncoding,
  Status,
  QRError,
  MAX_INPUT_BYTES,
  defaultEncodeOptions,
  type EncodeOptions,
  type KanjiHooks,
  type QrCode,
} from './types.ts';
import { DATA_CODEWORDS } from './tables.core.generated.ts';
import { kanjiFromShiftJis } from './kanjiCommon.ts';
import { addEccAndInterleave } from './rs.ts';
import { buildMatrix } from './matrix.ts';

const IM_NUMERIC = 0;
const IM_ALNUM = 1;
const IM_BYTE = 2;
const IM_KANJI = 3;

const UNIT_NUMERIC = 0x01;
const UNIT_ALNUM = 0x02;
const UNIT_KANJI = 0x04;

const INF = 0xffffffff;
const NONE = 0xffff;

const MODE_INDICATOR = [1, 2, 4, 8];
const COUNT_WIDTHS = [
  [10, 12, 14],
  [9, 11, 13],
  [8, 16, 16],
  [8, 10, 12],
];
const QUOTIENT_FACTOR = [10, 11, 8, 13];

interface Unit {
  offset: number;
  kanji: number;
  length: number;
  flags: number;
}

function publicModeToInternal(mode: number): number {
  switch (mode) {
    case Mode.Numeric:
      return IM_NUMERIC;
    case Mode.Alphanumeric:
      return IM_ALNUM;
    case Mode.Byte:
      return IM_BYTE;
    case Mode.Kanji:
      return IM_KANJI;
    default:
      return -1;
  }
}

function alnumValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x5a) return c - 0x41 + 10;
  switch (c) {
    case 0x20:
      return 36;
    case 0x24:
      return 37;
    case 0x25:
      return 38;
    case 0x2a:
      return 39;
    case 0x2b:
      return 40;
    case 0x2d:
      return 41;
    case 0x2e:
      return 42;
    case 0x2f:
      return 43;
    case 0x3a:
      return 44;
    default:
      return -1;
  }
}

function unitValidForMode(u: Unit, mode: number): boolean {
  switch (mode) {
    case IM_NUMERIC:
      return (u.flags & UNIT_NUMERIC) !== 0;
    case IM_ALNUM:
      return (u.flags & UNIT_ALNUM) !== 0;
    case IM_BYTE:
      return true;
    case IM_KANJI:
      return (u.flags & UNIT_KANJI) !== 0;
    default:
      return false;
  }
}

function unitCountForMode(u: Unit, mode: number): number {
  return mode === IM_BYTE ? u.length : 1;
}

function payloadBits(mode: number, count: number): number {
  const c = count;
  switch (mode) {
    case IM_NUMERIC:
      return Math.floor((10 * c + 2) / 3);
    case IM_ALNUM:
      return Math.floor((11 * c + 1) / 2);
    case IM_BYTE:
      return 8 * c;
    case IM_KANJI:
      return 13 * c;
    default:
      return 0;
  }
}

export function versionGroup(version: number): number {
  return Math.floor((version + 7) / 17);
}

function countBitsForGroup(mode: number, group: number): number {
  return COUNT_WIDTHS[mode & 3][group < 3 ? group : 2];
}

function modePeriod(mode: number): number {
  return mode === IM_NUMERIC ? 3 : mode === IM_ALNUM ? 2 : 1;
}

function modePhaseCount(mode: number): number {
  return mode === IM_NUMERIC ? 3 : mode === IM_ALNUM ? 2 : 1;
}

function phasePayloadBits(mode: number, phase: number, currentCount: number): number {
  if (currentCount < phase) return INF;
  const count = currentCount - phase;
  if (mode === IM_NUMERIC) {
    const q = Math.floor(count / 3);
    const r = count % 3;
    return 10 * q + (r === 0 ? 0 : r === 1 ? 4 : 7);
  }
  if (mode === IM_ALNUM) {
    const q = Math.floor(count / 2);
    return 11 * q + (count % 2 !== 0 ? 6 : 0);
  }
  return payloadBits(mode, count);
}

function decodeUtf8(data: Uint8Array, position: number): { codepoint: number; bytes: number } {
  if (position >= data.length) throw new QRError(Status.InvalidUtf8);
  const first = data[position++];
  if (first < 0x80) return { codepoint: first, bytes: 1 };
  if (first >= 0xc2 && first <= 0xdf) {
    if (position >= data.length || (data[position] & 0xc0) !== 0x80) throw new QRError(Status.InvalidUtf8);
    return { codepoint: ((first & 0x1f) << 6) | (data[position] & 0x3f), bytes: 2 };
  }
  if (first >= 0xe0 && first <= 0xef) {
    if (
      position + 1 >= data.length ||
      (data[position] & 0xc0) !== 0x80 ||
      (data[position + 1] & 0xc0) !== 0x80
    )
      throw new QRError(Status.InvalidUtf8);
    const value = ((first & 0x0f) << 12) | ((data[position] & 0x3f) << 6) | (data[position + 1] & 0x3f);
    if (value < 0x800 || (value >= 0xd800 && value <= 0xdfff)) throw new QRError(Status.InvalidUtf8);
    return { codepoint: value, bytes: 3 };
  }
  if (first >= 0xf0 && first <= 0xf4) {
    if (
      position + 2 >= data.length ||
      (data[position] & 0xc0) !== 0x80 ||
      (data[position + 1] & 0xc0) !== 0x80 ||
      (data[position + 2] & 0xc0) !== 0x80
    )
      throw new QRError(Status.InvalidUtf8);
    const value =
      ((first & 0x07) << 18) |
      ((data[position] & 0x3f) << 12) |
      ((data[position + 1] & 0x3f) << 6) |
      (data[position + 2] & 0x3f);
    if (value < 0x10000 || value > 0x10ffff) throw new QRError(Status.InvalidUtf8);
    return { codepoint: value, bytes: 4 };
  }
  throw new QRError(Status.InvalidUtf8);
}

function tokenize(data: Uint8Array, input: number, hooks: KanjiHooks): Unit[] {
  const units: Unit[] = [];
  let position = 0;
  while (position < data.length) {
    if (units.length >= MAX_INPUT_BYTES) throw new QRError(Status.DataTooLong);
    let bytes = 1;
    let kanji = 0;
    let flags = 0;
    if (input === InputEncoding.ShiftJis && position + 1 < data.length) {
      kanji = kanjiFromShiftJis(data[position], data[position + 1]);
      if (kanji !== 0) {
        bytes = 2;
        flags = UNIT_KANJI;
      }
    }
    if (input === InputEncoding.Utf8 && kanji === 0) {
      const { codepoint, bytes: len } = decodeUtf8(data, position);
      bytes = len;
      if (codepoint <= 0x7f) {
        const c = codepoint;
        if (c >= 0x30 && c <= 0x39) flags = UNIT_NUMERIC | UNIT_ALNUM;
        else if (alnumValue(c) >= 0) flags = UNIT_ALNUM;
        kanji = hooks.unicodeToKanjiValue(codepoint);
      } else {
        const mapped = hooks.unicodeToKanjiValue(codepoint);
        if (mapped !== 0) {
          kanji = mapped;
          flags = UNIT_KANJI;
        } else {
          kanji = 0;
        }
      }
    }
    if (input !== InputEncoding.Utf8 || flags === 0) {
      const c = data[position];
      if (c >= 0x30 && c <= 0x39) flags = UNIT_NUMERIC | UNIT_ALNUM;
      else if (alnumValue(c) >= 0) flags = UNIT_ALNUM;
    }
    units.push({ offset: position, kanji: flags & UNIT_KANJI ? kanji : 0, length: bytes, flags });
    position += bytes;
  }
  return units;
}

interface Segmentation {
  cost: number;
  modes: Uint8Array;
  starts: Uint16Array;
  ends: Uint16Array;
  count: number;
}

function optimizeGroup(units: Unit[], group: number, forcedMode: number): Segmentation {
  const n = units.length;
  const modes = new Uint8Array(n);
  const starts = new Uint16Array(n);
  const ends = new Uint16Array(n);
  const firstMode = forcedMode < 0 ? 0 : forcedMode;
  const modeCount = forcedMode < 0 ? 4 : 1;
  const dpCost: Uint32Array[] = [];
  const dpStart: Uint16Array[] = [];
  for (let m = 0; m < 4; m++) {
    dpCost.push(new Uint32Array(n + 1).fill(INF));
    dpStart.push(new Uint16Array(n + 1));
  }
  if (n === 0) return { cost: 0, modes, starts, ends, count: 0 };

  // Linked-list monotone queues: one node per input position per mode.
  const adjusted: Int32Array[] = [];
  const next: Int32Array[] = [];
  const prev: Int32Array[] = [];
  const qcount: Uint16Array[] = [];
  for (let m = 0; m < 4; m++) {
    adjusted.push(new Int32Array(n + 1));
    next.push(new Int32Array(n + 1).fill(-1));
    prev.push(new Int32Array(n + 1).fill(-1));
    qcount.push(new Uint16Array(n + 1));
  }
  const head: Int32Array[] = [];
  const tail: Int32Array[] = [];
  for (let m = 0; m < 4; m++) {
    head.push(new Int32Array(3).fill(-1));
    tail.push(new Int32Array(3).fill(-1));
  }
  const runCount = new Uint16Array(4);

  const push = (mode: number, phase: number, node: number, adj: number, sc: number): void => {
    let t = tail[mode][phase];
    while (t !== -1 && adjusted[mode][t] >= adj) t = prev[mode][t];
    adjusted[mode][node] = adj;
    qcount[mode][node] = sc;
    prev[mode][node] = t;
    next[mode][node] = -1;
    if (t !== -1) next[mode][t] = node;
    else head[mode][phase] = node;
    tail[mode][phase] = node;
  };
  const popFront = (mode: number, phase: number): void => {
    const h = head[mode][phase];
    if (h === -1) return;
    const nx = next[mode][h];
    if (nx === -1) tail[mode][phase] = -1;
    else prev[mode][nx] = -1;
    head[mode][phase] = nx;
  };

  for (let position = 0; position < n; position++) {
    const unit = units[position];
    let prior = position === 0 ? 0 : INF;
    if (position !== 0) {
      for (let mi = 0; mi < modeCount; mi++) {
        const p = firstMode + mi;
        if (dpCost[p][position] < prior) prior = dpCost[p][position];
      }
    }
    for (let mi = 0; mi < modeCount; mi++) {
      const mode = firstMode + mi;
      if (!unitValidForMode(unit, mode)) {
        for (let ph = 0; ph < 3; ph++) {
          head[mode][ph] = -1;
          tail[mode][ph] = -1;
        }
        runCount[mode] = 0;
        continue;
      }
      if (prior !== INF) {
        const cw = countBitsForGroup(mode, group);
        const seed = prior + 4 + cw;
        const sc = runCount[mode];
        const period = modePeriod(mode);
        const phase = sc % period;
        const adj = seed - QUOTIENT_FACTOR[mode] * Math.floor(sc / period);
        push(mode, phase, position, adj, sc);
      }
    }
    for (let mi = 0; mi < modeCount; mi++) {
      const mode = firstMode + mi;
      if (!unitValidForMode(unit, mode)) continue;
      runCount[mode] += unitCountForMode(unit, mode);
      const cw = countBitsForGroup(mode, group);
      const maxCount = (1 << cw) - 1;
      let best = INF;
      let bestStart = 0;
      for (let ph = 0; ph < modePhaseCount(mode); ph++) {
        while (head[mode][ph] !== -1 && runCount[mode] - qcount[mode][head[mode][ph]] > maxCount) {
          popFront(mode, ph);
        }
        if (head[mode][ph] === -1) continue;
        const bits = phasePayloadBits(mode, ph, runCount[mode]);
        if (bits === INF) continue;
        const cost = adjusted[mode][head[mode][ph]] + bits;
        if (cost < best) {
          best = cost;
          bestStart = head[mode][ph];
        }
      }
      if (best !== INF) {
        dpCost[mode][position + 1] = best;
        dpStart[mode][position + 1] = bestStart;
      }
    }
  }

  let best = INF;
  for (let mi = 0; mi < modeCount; mi++) {
    const mode = firstMode + mi;
    if (dpCost[mode][n] < best) best = dpCost[mode][n];
  }
  if (best === INF) return { cost: INF, modes, starts, ends, count: 0 };

  let currentMode = -1;
  for (let mi = 0; mi < modeCount; mi++) {
    const mode = firstMode + mi;
    if (dpCost[mode][n] === best) {
      currentMode = mode;
      break;
    }
  }
  let count = 0;
  let position = n;
  while (position > 0) {
    const start = dpStart[currentMode][position];
    if (start >= position || count >= n) return { cost: INF, modes, starts, ends, count: 0 };
    modes[count] = currentMode;
    starts[count] = start;
    ends[count] = position;
    count++;
    position = start;
    if (position === 0) break;
    let priorBest = INF;
    let priorMode = -1;
    for (let mi = 0; mi < modeCount; mi++) {
      const mode = firstMode + mi;
      if (dpCost[mode][position] < priorBest) {
        priorBest = dpCost[mode][position];
        priorMode = mode;
      }
    }
    if (priorMode < 0) return { cost: INF, modes, starts, ends, count: 0 };
    currentMode = priorMode;
  }
  // Reverse in place.
  for (let i = 0; i < Math.floor(count / 2); i++) {
    const j = count - 1 - i;
    let t = modes[i];
    modes[i] = modes[j];
    modes[j] = t;
    t = starts[i];
    starts[i] = starts[j];
    starts[j] = t;
    t = ends[i];
    ends[i] = ends[j];
    ends[j] = t;
  }
  return { cost: best, modes, starts, ends, count };
}

function segmentCount(units: Unit[], mode: number, start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++) count += unitCountForMode(units[i], mode);
  return count;
}

class BitWriter {
  buf: Uint8Array;
  len = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(size);
  }
  append(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      if ((value >> i) & 1) this.buf[this.len >> 3] |= 1 << (7 - (this.len & 7));
      this.len++;
    }
  }
}

function writeSegmentPayload(
  units: Unit[],
  data: Uint8Array,
  mode: number,
  start: number,
  end: number,
  w: BitWriter,
): void {
  if (mode === IM_BYTE) {
    for (let i = start; i < end; i++) {
      for (let j = 0; j < units[i].length; j++) w.append(data[units[i].offset + j], 8);
    }
    return;
  }
  if (mode === IM_KANJI) {
    for (let i = start; i < end; i++) w.append(units[i].kanji, 13);
    return;
  }
  if (mode === IM_NUMERIC) {
    let index = start;
    while (index < end) {
      let group = Math.min(end - index, 3);
      let value = 0;
      for (let j = 0; j < group; j++) value = value * 10 + (data[units[index + j].offset] - 0x30);
      w.append(value, group * 3 + 1);
      index += group;
    }
    return;
  }
  let index = start;
  while (index < end) {
    let group = Math.min(end - index, 2);
    let value = alnumValue(data[units[index].offset]);
    if (group === 2) value = value * 45 + alnumValue(data[units[index + 1].offset]);
    w.append(value, group === 2 ? 11 : 6);
    index += group;
  }
}

function buildDataCodewords(
  units: Unit[],
  data: Uint8Array,
  version: number,
  ecc: number,
  group: number,
  seg: Segmentation,
): Uint8Array {
  const dataCodewords = DATA_CODEWORDS[ecc][version];
  const capacityBits = dataCodewords * 8;
  const w = new BitWriter(dataCodewords);
  for (let s = 0; s < seg.count; s++) {
    const mode = seg.modes[s];
    const count = segmentCount(units, mode, seg.starts[s], seg.ends[s]);
    const cw = countBitsForGroup(mode, group);
    if (count >= 1 << cw) throw new QRError(Status.Capacity);
    w.append(MODE_INDICATOR[mode], 4);
    w.append(count, cw);
    writeSegmentPayload(units, data, mode, seg.starts[s], seg.ends[s], w);
  }
  if (w.len > capacityBits) throw new QRError(Status.Capacity);
  let terminator = capacityBits - w.len;
  if (terminator > 4) terminator = 4;
  w.append(0, terminator);
  while ((w.len & 7) !== 0) w.append(0, 1);
  let pad = 0xec;
  while (w.len < capacityBits) {
    w.append(pad, 8);
    pad ^= 0xec ^ 0x11;
  }
  return w.buf;
}

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  return input instanceof Uint8Array ? input : Uint8Array.from(input);
}

export function encodeWithHooks(
  input: Uint8Array | string,
  options: Partial<EncodeOptions> | undefined,
  hooks: KanjiHooks,
): QrCode {
  const data = toBytes(input);
  if (data.length > MAX_INPUT_BYTES) throw new QRError(Status.DataTooLong);
  const o: EncodeOptions = { ...defaultEncodeOptions(), ...options };
  if (
    o.ecc !== Ecc.L &&
    o.ecc !== Ecc.M &&
    o.ecc !== Ecc.Q &&
    o.ecc !== Ecc.H
  )
    throw new QRError(Status.InvalidArgument, 'ecc');
  if (
    o.mode !== Mode.Auto &&
    o.mode !== Mode.Numeric &&
    o.mode !== Mode.Alphanumeric &&
    o.mode !== Mode.Byte &&
    o.mode !== Mode.Kanji
  )
    throw new QRError(Status.InvalidArgument, 'mode');
  if (o.mask < -1 || o.mask > 7) throw new QRError(Status.InvalidArgument, 'mask');
  if (o.input !== InputEncoding.Bytes && o.input !== InputEncoding.Utf8 && o.input !== InputEncoding.ShiftJis)
    throw new QRError(Status.InvalidArgument, 'input');
  if (o.minVersion < 1 || o.maxVersion > 40 || o.minVersion > o.maxVersion)
    throw new QRError(Status.VersionRange);

  const units = tokenize(data, o.input, hooks);
  const forcedMode = publicModeToInternal(o.mode);
  if (forcedMode >= 0) {
    for (const u of units) {
      if (!unitValidForMode(u, forcedMode)) throw new QRError(Status.InvalidModeData);
    }
  }

  const groupCost = [INF, INF, INF];
  for (let group = 0; group < 3; group++) {
    let skip = false;
    if (forcedMode >= 0 && units.length !== 0) {
      let total = 0;
      for (const u of units) total += unitCountForMode(u, forcedMode);
      const cw = countBitsForGroup(forcedMode, group);
      const maxCount = (1 << cw) - 1;
      const segLower = Math.floor((total + maxCount - 1) / maxCount);
      const payloadLower =
        forcedMode === IM_NUMERIC
          ? 3 * total
          : forcedMode === IM_ALNUM
            ? 5 * total
            : forcedMode === IM_BYTE
              ? 8 * total
              : 13 * total;
      const lower = payloadLower + segLower * (4 + cw);
      const groupLast = Math.min(group === 0 ? 9 : group === 1 ? 26 : 40, o.maxVersion);
      if (groupLast < o.minVersion || lower > DATA_CODEWORDS[o.ecc][groupLast] * 8) skip = true;
    }
    groupCost[group] = skip ? INF : optimizeGroup(units, group, forcedMode).cost;
  }

  let version = 0;
  let selectedGroup = 0;
  for (let v = o.minVersion; v <= o.maxVersion; v++) {
    const group = versionGroup(v);
    const capacity = DATA_CODEWORDS[o.ecc][v] * 8;
    if (groupCost[group] !== INF && groupCost[group] <= capacity) {
      version = v;
      selectedGroup = group;
      break;
    }
  }
  if (version === 0) throw new QRError(Status.DataTooLong);

  const seg = optimizeGroup(units, selectedGroup, forcedMode);
  if (seg.cost === INF) throw new QRError(Status.Capacity);
  if (units.length !== 0 && seg.count === 0) throw new QRError(Status.Capacity);

  const dataBytes = buildDataCodewords(units, data, version, o.ecc, selectedGroup, seg);
  const stream = addEccAndInterleave(dataBytes, version, o.ecc);

  let modeMask = 0;
  for (let i = 0; i < seg.count; i++) {
    if (seg.ends[i] > seg.starts[i]) modeMask |= 1 << seg.modes[i];
  }
  return buildMatrix(stream, version, o.ecc, o.mask, modeMask);
}
