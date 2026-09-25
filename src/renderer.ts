import type { QrCode, RenderOptions } from './types.ts';
import { QRError, Status } from './types.ts';

export function packRows(code: QrCode): Uint8Array {
  const rowBytes = Math.floor((code.size + 7) / 8);
  const out = new Uint8Array(rowBytes * code.size);
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y * code.size + x] !== 0) out[y * rowBytes + (x >> 3)] |= 1 << (7 - (x & 7));
    }
  }
  return out;
}

export function renderAscii(code: QrCode, options?: Partial<RenderOptions>): string {
  const scale = options?.scale && options.scale > 0 ? Math.floor(options.scale) : 1;
  const border = options?.border ?? 2;
  const invert = options?.invert ?? false;
  if (scale <= 0 || scale > 255 || border > 255) throw new QRError(Status.InvalidArgument);
  const dark = invert ? '  ' : '##';
  const light = invert ? '##' : '  ';
  const lineWidth = code.size + border * 2;
  let out = '';
  const blankLine = light.repeat(lineWidth) + '\n';
  for (let i = 0; i < border * scale; i++) out += blankLine;
  for (let y = 0; y < code.size; y++) {
    let line = light.repeat(border);
    for (let x = 0; x < code.size; x++) {
      line += (code.modules[y * code.size + x] !== 0 ? dark : light).repeat(scale);
    }
    line += light.repeat(border);
    line += '\n';
    for (let r = 0; r < scale; r++) out += line;
  }
  for (let i = 0; i < border * scale; i++) out += blankLine;
  return out;
}

export function renderSvg(code: QrCode, options?: Partial<RenderOptions>): string {
  const scale = options?.scale && options.scale > 0 ? Math.floor(options.scale) : 4;
  const border = options?.border ?? 4;
  const invert = options?.invert ?? false;
  if (scale <= 0 || scale > 255 || border > 255) throw new QRError(Status.InvalidArgument);
  const dimension = (code.size + border * 2) * scale;
  const bg = invert ? '#000' : '#fff';
  const fg = invert ? '#fff' : '#000';
  let d = '';
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      let dark = code.modules[y * code.size + x] !== 0;
      if (invert) dark = !dark;
      if (!dark) continue;
      if (d !== '') d += ' ';
      d += `M${(x + border) * scale} ${(y + border) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" viewBox="0 0 ${dimension} ${dimension}">` +
    `<rect width="100%" height="100%" fill="${bg}"/>` +
    `<path fill="${fg}" d="${d}"/></svg>\n`
  );
}
