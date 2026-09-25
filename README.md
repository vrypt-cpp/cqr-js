# cQR — fast, lightweight QR Code generator/decoder for JS/TS

Dependency-free QR Code library for Node and browsers (ISO/IEC 18004, Model 2,
versions 1–40). TypeScript port of the [cQR C library](../cQR), with the same
algorithms, the same test vectors, and the same sync, zero-dependency design.

- Encode: Numeric, Alphanumeric, Byte (UTF-8), Kanji — with optimal mixed-mode
  segmentation and minimum-version selection
- ECC levels L / M / Q / H, Reed–Solomon, all 8 mask patterns with full
  penalty scoring
- Decode: module matrix, packed 1-bit bitmap, and 8-bit grayscale images
  (finder detection, affine sampling, Otsu fallback, rotation/mirror/inversion)
- Reed–Solomon error correction on decode, Kanji → Shift-JIS or UTF-8 output
- Sync API, no Promises, no WASM loader, no dependencies
- `@vrypt-cpp/cqr/compact` entry without the UTF-8 Kanji tables for smaller bundles

## Install

```sh
npm install @vrypt-cpp/cqr
```

## Quick start

```ts
import { encode, decodeText, renderAscii } from '@vrypt-cpp/cqr';

const code = encode('HELLO WORLD');
console.log(`v${code.version} ${code.size}x${code.size} mask=${code.mask}`);
console.log(renderAscii(code));

const { text } = decodeText(code.modules, code.size);
console.log(text); // HELLO WORLD
```

`Uint8Array` input is also accepted (`encode(bytes, { input: InputEncoding.Bytes })`).
For raw image pixels see `decodeGray8` / `decodePacked` below.

## API

### Encode

```ts
import { encode, Ecc, Mode, InputEncoding } from '@vrypt-cpp/cqr';

const code = encode('Hello, 世界', {
  ecc: Ecc.M,              // L | M | Q | H (default M)
  mode: Mode.Auto,         // Auto | Numeric | Alphanumeric | Byte | Kanji
  input: InputEncoding.Utf8, // Bytes | Utf8 | ShiftJis
  minVersion: 1,
  maxVersion: 40,
  mask: -1,                // -1 = lowest penalty, 0..7 = force
});
```

Returns a `QrCode`:

```ts
interface QrCode {
  version: number; size: number; ecc: EccLevel; mask: number;
  modeMask: number; // 1=numeric 2=alnum 4=byte 8=kanji (bit per used mode)
  dataCodewords: number; totalCodewords: number; penalty: number;
  modules: Uint8Array; // compact row-major size*size, 0/1
}
```

Note: unlike the C API (fixed stride 177), `modules` is tightly packed
`size*size`. Use `getModule(code, x, y)` for bounds-checked access.

### Render

```ts
import { packRows, renderAscii, renderSvg } from '@vrypt-cpp/cqr';

packRows(code); // Uint8Array, MSB-first rows
renderAscii(code, { scale: 1, border: 2, invert: false }); // string
renderSvg(code, { scale: 4, border: 4 }); // string
```

### Decode

```ts
import { decodeMatrix, decodeMatrixUtf8, decodeGray8, decodePacked } from '@vrypt-cpp/cqr';

// Normalized module matrix (e.g. QrCode.modules from encode):
const { bytes, info } = decodeMatrix(code.modules, code.size);

// Grayscale image pixels (dark = pixel <= threshold):
decodeGray8({ pixels, width, height, stride: width });
// Packed 1-bit bitmap, MSB-first, 1 = dark:
decodePacked({ pixels, width, height, stride: Math.ceil(width / 8) });
```

`*Utf8` variants (`decodeMatrixUtf8`, `decodeGray8Utf8`, `decodePackedUtf8`)
convert Kanji segments to UTF-8; the plain variants emit Kanji as Shift-JIS
bytes. Byte mode always yields raw bytes. `info` reports
`version/size/ecc/mask/modeMask/orientation/dataLength/correctedCodewords`.

Errors throw `QRError` with a `code` from `Status`
(`DataTooLong`, `InvalidUtf8`, `InvalidModeData`, `DecodeEcc`, …) and
`statusString(code)` describes them.

### Compact build

```ts
import { encode } from '@vrypt-cpp/cqr/compact';
```

Same API, no UTF-8 Kanji tables: raw Shift-JIS Kanji still works, other
non-ASCII falls back to byte mode. Matches the C `QR_DISABLE_UTF8_KANJI`
profile.

### C API mapping

| C (`qrcode.h`)            | npm (`cqr`)                          |
| ------------------------- | ------------------------------------ |
| `qr_encode`               | `encode(data, options?)`             |
| `qr_matrix_get`           | `getModule(code, x, y)`              |
| `qr_pack_rows`            | `packRows(code)`                     |
| `qr_render_ascii/svg`     | `renderAscii/renderSvg(code, opts?)` |
| `qr_decode_matrix[_utf8]` | `decodeMatrix[_Utf8](m, size, opts?)`|
| `qr_decode_packed[_utf8]` | `decodePacked[_Utf8](view, opts?)`   |
| `qr_decode_gray8[_utf8]`  | `decodeGray8[_Utf8](view, opts?)`    |
| `qr_options_default`      | `defaultEncodeOptions()`             |
| `qr_decode_options_default` | `defaultDecodeOptions()`           |
| `qr_status_string`        | `statusString(code)`                 |

Workspace management, callbacks, and output buffers don't exist here — the GC
and return values replace them. Two bug-for-bug incompatibilities were
deliberately *not* ported: remainder bits are always encoded as light (the C
library read stale workspace bytes there before v1.0.1), and exact-fit
payloads without a terminator now decode successfully in both.

## Develop

```sh
npm install
npm run gen:tables   # regenerate src/tables.*.generated.ts from /root/cQR
npm run build        # tsc -> dist/
npm test             # node:test, 238 tests
npm run bench
```

Test coverage: 25 fixtures generated from the C library (exact matrices +
penalties), a golden row-by-row matrix, 160 version×ECC round-trips, RS
correction, format damage, image rotation/mirror/inversion, Otsu fallback,
and compact-build parity.

## Size (esbuild, minified)

| entry     | minified | gzip  | brotli |
| --------- | -------- | ----- | ------ |
| `cqr`     | 62.3 KB  | 33.8 KB | 30.4 KB |
| `@vrypt-cpp/cqr/compact` | 35.0 KB | 13.5 KB | 11.6 KB |

The full Kanji table (~20 KB packed) dominates the full build. The compact
build meets the <15 KB (gzip) budget. Run `npm run size` for dist file sizes.

## Benchmarks (Node 24, container, `npm run bench`)

```text
encode-small     v3  0.359 ms/op p50 0.306 p95 0.581
encode-v10       v10 1.180 ms/op p50 1.097 p95 1.468
encode-v40       v40 10.289 ms/op p50 9.543 p95 13.139
decode-small     v3  0.046 ms/op
decode-v40       v40 1.181 ms/op
```

## License

MIT — see LICENSE. QR block-layout constants were cross-checked against
Project Nayuki's QR Code generator (MIT); no Nayuki code is included.
