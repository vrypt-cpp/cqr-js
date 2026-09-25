// Compact Kanji hooks: raw Shift-JIS Kanji mode still works (pure
// arithmetic in kanjiCommon.ts); UTF-8 non-ASCII falls back to byte mode.
import type { KanjiHooks } from './types.ts';

export const stubKanjiHooks: KanjiHooks = {
  unicodeToKanjiValue: (_codepoint: number): number => 0,
  kanjiValueToCodePoint: (_value: number): number => -1,
};
