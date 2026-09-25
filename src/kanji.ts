// Full Kanji hooks backed by the packed Unicode <-> Shift-JIS tables.
import { KANJI_COUNT, KANJI_PACKED } from './tables.kanji.generated.ts';
import type { KanjiHooks } from './types.ts';
import { kanjiFromShiftJis } from './kanjiCommon.ts';

const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let cache: { offsets: Uint16Array; codepoints: Uint16Array; values: Uint16Array } | null = null;

function loadTables(): { offsets: Uint16Array; codepoints: Uint16Array; values: Uint16Array } {
  if (cache) return cache;
  const lut = new Uint8Array(128).fill(255);
  for (let i = 0; i < 64; i++) lut[B64CHARS.charCodeAt(i)] = i;
  const s = KANJI_PACKED;
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let pos = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code > 127 || lut[code] === 255) continue;
    acc = (acc << 6) | lut[code];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >> bits) & 0xff;
    }
  }
  const words = new Uint16Array(out.buffer, out.byteOffset, Math.floor(pos / 2));
  const offsets = words.slice(0, 257);
  const codepoints = words.slice(257, 257 + KANJI_COUNT);
  const values = words.slice(257 + KANJI_COUNT, 257 + KANJI_COUNT * 2);
  cache = { offsets, codepoints, values };
  return cache;
}

function shiftJisToKanjiValue(shiftJis: number): number {
  const high = (shiftJis >> 8) & 0xff;
  let base: number;
  if (high >= 0x81 && high <= 0x9f) base = 0x8140;
  else if (high >= 0xe0 && high <= 0xeb) base = 0xc140;
  else return 0;
  if ((base === 0x8140 && shiftJis > 0x9ffc) || (base === 0xc140 && shiftJis > 0xebbf)) return 0;
  const adjusted = shiftJis - base;
  return ((adjusted >> 8) * 0xc0 + (adjusted & 0xff)) >>> 0;
}

export function unicodeToKanjiValue(codepoint: number): number {
  if (codepoint > 0xffff) return 0;
  const { offsets, codepoints } = loadTables();
  const high = (codepoint >> 8) & 0xff;
  let begin = offsets[high];
  let end = offsets[high + 1];
  while (begin < end) {
    const middle = begin + ((end - begin) >> 1);
    const candidate = codepoints[middle];
    if (candidate === codepoint) {
      const { values } = loadTables();
      return kanjiFromShiftJis((values[middle] >> 8) & 0xff, values[middle] & 0xff);
    }
    if (candidate < codepoint) begin = middle + 1;
    else end = middle;
  }
  return 0;
}

export function kanjiValueToCodePoint(value: number): number {
  const { codepoints, values } = loadTables();
  for (let i = 0; i < KANJI_COUNT; i++) {
    if (shiftJisToKanjiValue(values[i]) === value) return codepoints[i];
  }
  return -1;
}

export const fullKanjiHooks: KanjiHooks = { unicodeToKanjiValue, kanjiValueToCodePoint };
