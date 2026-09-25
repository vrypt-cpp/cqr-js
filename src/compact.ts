// cqr/compact — same API without the UTF-8 Kanji tables.
// Raw Shift-JIS Kanji mode still works; UTF-8 non-ASCII falls back to byte
// mode. Import from 'cqr/compact' for a smaller bundle.
import { stubKanjiHooks } from './kanjiStub.ts';
import { encodeWithHooks } from './encoder.ts';
import { decodeMatrixInternal } from './decoder.ts';
import { decodeImageInternal, toImageSource } from './image.ts';
import type {
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
  type DecodeResult,
  type DecodeTextResult,
  type ImageView,
  type KanjiHooks,
} from './types.ts';
export { packRows, renderAscii, renderSvg } from './renderer.ts';

export function encode(data: Uint8Array | string, options?: Partial<EncodeOptions>): QrCode {
  return encodeWithHooks(data, options, stubKanjiHooks);
}

export function decodeMatrix(
  matrix: Uint8Array,
  size: number,
  options?: Partial<DecodeOptions>,
): DecodeResult {
  return decodeMatrixInternal(matrix, size, size, size, options, false, stubKanjiHooks);
}

export function decodeMatrixUtf8(
  matrix: Uint8Array,
  size: number,
  options?: Partial<DecodeOptions>,
): DecodeResult {
  return decodeMatrixInternal(matrix, size, size, size, options, true, stubKanjiHooks);
}

export function decodePacked(bitmap: ImageView, options?: Partial<DecodeOptions>): DecodeResult {
  return decodeImageInternal(toImageSource(bitmap, true, options), options, false, stubKanjiHooks);
}

export function decodePackedUtf8(
  bitmap: ImageView,
  options?: Partial<DecodeOptions>,
): DecodeResult {
  return decodeImageInternal(toImageSource(bitmap, true, options), options, true, stubKanjiHooks);
}

export function decodeGray8(image: ImageView, options?: Partial<DecodeOptions>): DecodeResult {
  return decodeImageInternal(toImageSource(image, false, options), options, false, stubKanjiHooks);
}

export function decodeGray8Utf8(image: ImageView, options?: Partial<DecodeOptions>): DecodeResult {
  return decodeImageInternal(toImageSource(image, false, options), options, true, stubKanjiHooks);
}

export function decodeText(matrix: Uint8Array, size: number, options?: Partial<DecodeOptions>): DecodeTextResult {
  const { bytes, info } = decodeMatrixUtf8(matrix, size, options);
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), info };
}
