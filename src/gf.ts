import { GF_EXP, GF_LOG } from './tables.core.generated.ts';

export function gfMul(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return GF_EXP[GF_LOG[x] + GF_LOG[y]];
}

export function gfInv(x: number): number {
  if (x === 0) return 0;
  return GF_EXP[255 - GF_LOG[x]];
}
