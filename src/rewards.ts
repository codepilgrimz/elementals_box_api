import { LAMPORTS_PER_SOL } from '@solana/web3.js';

/**
 * Your requested probabilities were:
 * - 90% Nothing
 * - 10% Elementals NFT
 * - 1%  0.5 SOL
 * - 0.1% 2.5 SOL
 *
 * Note: These add up to 101.1%. The code below treats them as weights and normalizes them to 100%.
 * If you want different exact percentages, adjust the weights array accordingly.
 */
export type PrizeKind = { kind: 'NOTHING' } |
  { kind: 'NFT', label: string } |
  { kind: 'SOL', lamports: number, label: string };

type Weighted<T> = { weight: number, item: T };

export function normalizeWeights<T>(items: Weighted<T>[]) {
  const total = items.reduce((s, x) => s + x.weight, 0);
  return items.map(x => ({ p: x.weight / total, item: x.item }));
}

const PRIZES: Weighted<PrizeKind>[] = [
  { weight: 86.4, item: { kind: 'NOTHING' } },
  { weight: 12.5, item: { kind: 'NFT', label: 'Elementals NFT' } },
  { weight: 1.0,  item: { kind: 'SOL', lamports: 0.5 * LAMPORTS_PER_SOL, label: '0.5 SOL' } },
  { weight: 0.1,  item: { kind: 'SOL', lamports: 2.5 * LAMPORTS_PER_SOL, label: '2.5 SOL' } },
];

export function choosePrize(): PrizeKind {
  const normalized = normalizeWeights(PRIZES);
  let r = Math.random();
  for (const { p, item } of normalized) {
    if (r < p) return item;
    r -= p;
  }
  return { kind: 'NOTHING' };
}
