// Public types for the cqr package. Mirrors the C API in
// /root/cQR/include/qrcode/qrcode.h, adapted to idiomatic TypeScript:
// no workspace parameter (GC manages scratch memory) and compact
// row-major matrices (size*size) instead of the C fixed stride of 177.

export const VERSION_MIN = 1;
export const VERSION_MAX = 40;
export const MAX_MATRIX_SIZE = 177;
export const MAX_RAW_CODEWORDS = 3706;
export const MAX_DATA_CODEWORDS = 2956;
export const MAX_RS_DEGREE = 30;
export const MAX_INPUT_BYTES = 7089;

export const Status = {
  Ok: 0,
  InvalidArgument: 1,
  DataTooLong: 2,
  InvalidUtf8: 3,
  InvalidModeData: 4,
  Capacity: 5,
  VersionRange: 6,
  RenderBuffer: 7,
  Callback: 8,
  NotFound: 9,
  DecodeFormat: 10,
  DecodeEcc: 11,
  DecodeMode: 12,
  DecodeBuffer: 13,
  DecodeVersion: 14,
} as const;
export type StatusCode = (typeof Status)[keyof typeof Status];

const STATUS_NAMES: Record<number, string> = {
  [Status.Ok]: 'ok',
  [Status.InvalidArgument]: 'invalid argument',
  [Status.DataTooLong]: 'data too long',
  [Status.InvalidUtf8]: 'invalid UTF-8',
  [Status.InvalidModeData]: 'data cannot be represented in requested mode',
  [Status.Capacity]: 'insufficient QR capacity',
  [Status.VersionRange]: 'invalid version range',
  [Status.RenderBuffer]: 'render buffer too small',
  [Status.Callback]: 'renderer callback failed',
  [Status.NotFound]: 'QR symbol not found',
  [Status.DecodeFormat]: 'invalid QR format information',
  [Status.DecodeEcc]: 'uncorrectable QR errors',
  [Status.DecodeMode]: 'invalid or unsupported QR mode',
  [Status.DecodeBuffer]: 'decode output buffer too small',
  [Status.DecodeVersion]: 'invalid QR version',
};

export function statusString(code: StatusCode): string {
  return STATUS_NAMES[code] ?? 'unknown QR status';
}

export class QRError extends Error {
  readonly code: StatusCode;
  constructor(code: StatusCode, detail?: string) {
    super(detail !== undefined ? `${statusString(code)}: ${detail}` : statusString(code));
    this.name = 'QRError';
    this.code = code;
  }
}

export const Ecc = {
  L: 0,
  M: 1,
  Q: 2,
  H: 3,
} as const;
export type EccLevel = (typeof Ecc)[keyof typeof Ecc];

export const Mode = {
  Auto: 0,
  Numeric: 1,
  Alphanumeric: 2,
  Byte: 3,
  Kanji: 4,
} as const;
export type EncodeMode = (typeof Mode)[keyof typeof Mode];

export const InputEncoding = {
  Bytes: 0,
  Utf8: 1,
  ShiftJis: 2,
} as const;
export type InputEncodingKind = (typeof InputEncoding)[keyof typeof InputEncoding];

export interface EncodeOptions {
  ecc: EccLevel;
  mode: EncodeMode;
  input: InputEncodingKind;
  minVersion: number;
  maxVersion: number;
  /** -1 selects the lowest-penalty mask; 0..7 forces a mask. */
  mask: number;
}

export function defaultEncodeOptions(): EncodeOptions {
  return { ecc: Ecc.M, mode: Mode.Auto, input: InputEncoding.Utf8, minVersion: 1, maxVersion: 40, mask: -1 };
}

export interface QrCode {
  version: number;
  size: number;
  ecc: EccLevel;
  mask: number;
  /** Bit `1 << internalMode`: numeric 1, alnum 2, byte 4, kanji 8. 0 = empty input. */
  modeMask: number;
  dataCodewords: number;
  totalCodewords: number;
  penalty: number;
  /** Compact row-major modules[y * size + x], each 0 (light) or 1 (dark). */
  modules: Uint8Array;
}

export function getModule(code: QrCode, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= code.size || y >= code.size) return false;
  return code.modules[y * code.size + x] !== 0;
}

export interface RenderOptions {
  scale: number;
  border: number;
  invert: boolean;
}

export function defaultRenderOptions(): RenderOptions {
  return { scale: 1, border: 2, invert: false };
}

export interface DecodeOptions {
  /** Grayscale threshold. Dark is pixel <= threshold when darkWhenLow is true. */
  threshold: number;
  darkWhenLow: boolean;
  tryInverted: boolean;
  tryRotations: boolean;
  tryMirror: boolean;
}

export function defaultDecodeOptions(): DecodeOptions {
  return { threshold: 128, darkWhenLow: true, tryInverted: true, tryRotations: true, tryMirror: true };
}

export interface DecodeInfo {
  version: number;
  size: number;
  ecc: EccLevel;
  mask: number;
  modeMask: number;
  /** Matrix path: rotation (0..3) plus mirror flag in bit 2. Image path: mirror flag in bit 2. */
  orientation: number;
  dataLength: number;
  dataCodewords: number;
  totalCodewords: number;
  correctedCodewords: number;
}

export interface ImageView {
  pixels: Uint8Array;
  width: number;
  height: number;
  stride: number;
}

export interface DecodeResult {
  bytes: Uint8Array;
  info: DecodeInfo;
}

export interface DecodeTextResult {
  text: string;
  info: DecodeInfo;
}

/** Kanji hooks let the compact entry point omit the UTF-8 Kanji tables. */
export interface KanjiHooks {
  /** Map a Unicode scalar value to a QR Kanji value; 0 = no mapping. */
  unicodeToKanjiValue(codepoint: number): number;
  /** Map a QR Kanji value to a Unicode scalar value; -1 = no mapping. */
  kanjiValueToCodePoint(value: number): number;
}
