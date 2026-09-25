// cqr — public API (full build with UTF-8 Kanji tables).
import { fullKanjiHooks } from './kanji.ts';
import { encodeWithHooks } from './encoder.ts';
import { decodeMatrixInternal } from './decoder.ts';
import { decodeImageInternal, toImageSource } from './image.ts';
import type {
  DecodeInfo,
  DecodeOptions,
  DecodeResult,
  DecodeTextResult,
  EncodeOptions,
  ImageView,
  QrCode,
} from './types.ts';

export {
  VERSION_MIN,
  VERSION_MAX,
  MAX_MATRIX_SIZE,
  MAX_RAW_CODEWORDS,
  MAX_DATA_CODEWORDS,
  MAX_RS_DEGREE,
  MAX_INPUT_BYTES,
  Status,
  statusString,
  QRError,
  Ecc,
  Mode,
  InputEncoding,
  defaultEncodeOptions,
  getModule,
  defaultRenderOptions,
  defaultDecodeOptions,
  type StatusCode,
  type EccLevel,
  type EncodeMode,
  type InputEncodingKind,
  type EncodeOptions,
  type QrCode,
  type RenderOptions,
  type DecodeOptions,
  type DecodeInfo,
  type ImageView,
  type KanjiHooks,
} from './types.ts';
export type { DecodeResult, DecodeTextResult } from './types.ts';
export { packRows, renderAscii, renderSvg } from './renderer.ts';

export function encode(data: Uint8Array | string, options?: Partial<EncodeOptions>): QrCode {
  return encodeWithHooks(data, options, fullKanjiHooks);
}

export function decodeMatrix(
  matrix: Uint8Array,
  size: number,
  options?: Partial<DecodeOptions>,
): DecodeResult {
  return decodeMatrixInternal(matrix, size, size, size, options, false, fullKanjiHooks);
}

export function decodeMatrixUtf8(
  matrix: Uint8Array,
  size: number,
  options?: Partial<DecodeOptions>,
): DecodeResult {
  return decodeMatrixInternal(matrix, size, size, size, options, true, fullKanjiHooks);
}

export function decodePacked(bitmap: ImageView, options?: Partial<DecodeOptions>): DecodeResult {
  return decodeImageInternal(toImageSource(bitmap, true, options), options, false, fullKanjiHooks);
}

export function decodePackedUtf8(
  bitmap: ImageView,
  options?: Partial<DecodeOptions>,
): DecodeResult {
  return decodeImageInternal(toImageSource(bitmap, true, options), options, true, fullKanjiHooks);
}

export function decodeGray8(image: ImageView, options?: Partial<DecodeOptions>): DecodeResult {
  return decodeImageInternal(toImageSource(image, false, options), options, false, fullKanjiHooks);
}

export function decodeGray8Utf8(image: ImageView, options?: Partial<DecodeOptions>): DecodeResult {
  return decodeImageInternal(toImageSource(image, false, options), options, true, fullKanjiHooks);
}

export function decodeText(matrix: Uint8Array, size: number, options?: Partial<DecodeOptions>): DecodeTextResult {
  const { bytes, info } = decodeMatrixUtf8(matrix, size, options);
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), info };
}
