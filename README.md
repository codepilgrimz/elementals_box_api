# Daily Free Box — Solana (Node/TypeScript backend)

Implements an NFT-gated "Daily Free Box" with a 0.001 SOL entry fee, cooldown rules, and prizes (Nothing / Elementals NFT / 0.5 SOL / 2.5 SOL).

## Key Features
- **Fee**: 0.001 SOL to open (configurable).
- **Cooldown**: `>= 10` NFTs in collection: 2 opens per 24h; otherwise: 1 per 24h.
- **Prizes**: 90 (weight): Nothing, 10: Elementals NFT, 1: 0.5 SOL, 0.1: 2.5 SOL — normalized to sum to 100%.
- **Payouts**: SOL from the treasury key; NFT prize transferred from treasury inventory (from `PRIZE_COLLECTION_ADDRESS`).

> ⚠️ The provided prize weights sum to 101.1%. The code treats them as weights and **normalizes** them to probabilities. Adjust in `src/rewards.ts` if you want exact percentages.

## Setup

1. **Install**

```bash
pnpm i  # or npm i / yarn
```

2. **Configure** `.env`

Copy `.env.example` to `.env` and fill:

```bash
RPC_URL=
TREASURY_SECRET_KEY=
GATE_COLLECTION_ADDRESS=
PRIZE_COLLECTION_ADDRESS=
```

- `TREASURY_SECRET_KEY` can be base58 or JSON array of 64 bytes.
- The treasury must hold SOL and NFTs from the prize collection.

3. **Run**

```bash
pnpm dev
# or build & start
pnpm build && node dist/index.js
```

## API

### GET `/health`
Returns network and treasury balance.

### POST `/prepare-payment`
Body: `{ "owner": "<pubkey>" }`  
Returns a transfer transaction (0.001 SOL) to the treasury you can sign client-side.

### POST `/open`
Body:
```json
{
  "owner": "<pubkey>",
  "signature": "<tx signature of payment to treasury>"
}
```
Verifies payment, enforces cooldown, rolls prize, and distributes (SOL / NFT / nothing).

## Notes
- **NFT Inventory**: For NFT prizes, the server picks an NFT owned by the treasury in `PRIZE_COLLECTION_ADDRESS`. If none available, it falls back to nothing.
- **Security**: Keep the treasury key safe. Consider running this on a backend with strict access controls.
- **Randomness**: Uses JS `Math.random()`. For stronger randomness, replace with `crypto.randomInt` or a VRF oracle.
