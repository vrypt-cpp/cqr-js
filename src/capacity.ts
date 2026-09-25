import { DATA_CODEWORDS } from './tables.core.generated.ts';

export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

export function dataCodewords(version: number, ecc: number): number {
  return DATA_CODEWORDS[ecc & 3][version];
}

export function versionGroup(version: number): number {
  return Math.floor((version + 7) / 17);
}
