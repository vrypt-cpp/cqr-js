// Pure-arithmetic Shift-JIS Kanji conversions shared by the full and
// compact builds. No lookup tables needed here.

/** Convert a Shift-JIS pair to a QR Kanji value; 0 = not encodable. */
export function kanjiFromShiftJis(high: number, low: number): number {
  let base: number;
  if (high >= 0x81 && high <= 0x9f) base = 0x8140;
  else if (high >= 0xe0 && high <= 0xeb) base = 0xc140;
  else return 0;
  if (low < 0x40 || low > 0xfc || low === 0x7f) return 0;
  const shiftJis = (high << 8) | low;
  if (shiftJis < base) return 0;
  if (base === 0x8140 && shiftJis > 0x9ffc) return 0;
  if (base === 0xc140 && shiftJis > 0xebbf) return 0;
  const adjusted = shiftJis - base;
  const value = ((adjusted >> 8) * 0xc0) + (adjusted & 0xff);
  return value === 0 ? 0 : value;
}

/** Convert a QR Kanji value back to Shift-JIS bytes; false = invalid. */
export function kanjiToShiftJis(value: number, out: { high: number; low: number }): boolean {
  const assembled = ((Math.floor(value / 0xc0) << 8) | (value % 0xc0)) >>> 0;
  let shifted: number;
  if (assembled < 0x1f00) shifted = assembled + 0x8140;
  else if (assembled <= 0x2a7f) shifted = assembled + 0xc140;
  else return false;
  const low = shifted & 0xff;
  if (low < 0x40 || low > 0xfc || low === 0x7f) return false;
  out.high = (shifted >> 8) & 0xff;
  out.low = low;
  return true;
}
