/* eslint-disable no-console */
import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { z } from 'zod';
import Redis from 'ioredis';
import bs58 from 'bs58';
import { v4 as uuidv4 } from 'uuid';
import {
  clusterApiUrl,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  Metaplex,
  keypairIdentity
} from '@metaplex-foundation/js';
import cors from "cors";

import { choosePrize } from './rewards.js';
import { findCollectionCountForOwner, checkGateTokenHoldings, pickPrizeNftFromTreasury, transferNftTo } from './nft.js';
import { logPrize } from './utils.js';

/* -------------------- ENV & SETUP -------------------- */

const EnvSchema = z.object({
  RPC_URL: z.string().min(1).default(clusterApiUrl('mainnet-beta')),
  TREASURY_SECRET_KEY: z.string().min(1),
  TREASURY_WALLET: z.string().min(1),
  GATE_COLLECTION_ADDRESS: z.string().min(1),
  PRIZE_COLLECTION_ADDRESS: z.string().min(1),
  GATE_TOKEN_ADDRESS: z.string().min(1),
  GATE_TOKEN1_ADDRESS: z.string().min(1),
  GATE_TOKEN2_ADDRESS: z.string().min(1),
  GATE_TOKEN3_ADDRESS: z.string().min(1),
  OPEN_TOKEN1_AMOUNT: z.coerce.number().default(10000),
  OPEN_TOKEN2_AMOUNT: z.coerce.number().default(10000),
  OPEN_TOKEN3_AMOUNT: z.coerce.number().default(10000),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  PORT: z.coerce.number().default(8080),
  OPEN_FEE_LAMPORTS: z.coerce.number().default(1_000_000), // 0.001 SOL
  OPEN_FEE_TOKEN: z.coerce.number().default(1000),
  COOLDOWN_HOURS: z.coerce.number().default(24),
  LOG_LEVEL: z.enum(['info', 'debug']).default('info'),
});

const ENV = EnvSchema.parse(process.env);

function loadKeypair(secret: string): Keypair {
  let secretKey: Uint8Array;
  try {
    // base58
    const bytes = bs58.decode(secret);
    if (bytes.length === 64) {
      secretKey = bytes;
    } else {
      throw new Error('Invalid base58 key length');
    }
  } catch {
    // maybe JSON array
    const arr = JSON.parse(secret);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error('Invalid secret key format');
    }
    secretKey = Uint8Array.from(arr);
  }
  return Keypair.fromSecretKey(secretKey);
}

const connection = new Connection(ENV.RPC_URL, { commitment: 'confirmed' });
const treasury = loadKeypair(ENV.TREASURY_SECRET_KEY);
const treasuryPubkey = treasury.publicKey;
const gateCollection = ENV.GATE_COLLECTION_ADDRESS;
const prizeCollection = ENV.PRIZE_COLLECTION_ADDRESS;
const feeWallet = new PublicKey(ENV.TREASURY_WALLET);
const gateToken = new PublicKey(ENV.GATE_TOKEN_ADDRESS);
const gateToken1 = new PublicKey(ENV.GATE_TOKEN1_ADDRESS);
const gateToken2 = new PublicKey(ENV.GATE_TOKEN2_ADDRESS);
const gateToken3 = new PublicKey(ENV.GATE_TOKEN3_ADDRESS);

const redis = new Redis(ENV.REDIS_URL);

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));


// Metaplex for NFT queries
const mx = Metaplex.make(connection).use(keypairIdentity(treasury));

/* -------------------- HELPER UTILS -------------------- */

const COOLDOWN_MS = ENV.COOLDOWN_HOURS * 60 * 60 * 1000;
const HOLDER_LIMIT = 1;
const SUPER_HOLDER_LIMIT = 2;
const SUPER_HOLDER_THRESHOLD = 10; // 10+ NFTs in collection

function openKey(owner: PublicKey) {
  return `opens:${owner.toBase58()}`;
}
function sigKey(sig: string) {
  return `sig:${sig}`;
}
function nowMs() { return Date.now(); }

async function getOpensRemaining(
  owner: PublicKey,
  holderCount: number,
  isTokenHolder: boolean
): Promise<{ remaining: number; used: number; limit: number; cooldownMs: number }> {
  const key = openKey(owner);
  const now = nowMs();
  const cutoff = now - COOLDOWN_MS;

  // Remove stale entries
  await redis.zremrangebyscore(key, 0, cutoff);

  // Count used opens
  const used = await redis.zcard(key);

  // Determine limit based on holder count
  const limit = holderCount >= SUPER_HOLDER_THRESHOLD ? SUPER_HOLDER_LIMIT : holderCount > 0 || isTokenHolder ? HOLDER_LIMIT : 0;
  const remaining = Math.max(0, limit - used);

  // Set TTL so Redis key expires automatically
  await redis.expire(key, Math.ceil(COOLDOWN_MS / 1000));

  // Determine time until next available open (cooldown)
  let cooldownMs = 0;
  if (remaining === 0) {
    // Get oldest entry timestamp
    const oldestArr = await redis.zrange(key, 0, 0, 'WITHSCORES');
    if (oldestArr.length === 2) {
      const oldestTimestamp = parseInt(oldestArr[1], 10);
      cooldownMs = Math.max(0, COOLDOWN_MS - (now - oldestTimestamp));
    } else {
      cooldownMs = COOLDOWN_MS;
    }
  }

  return { remaining, used, limit, cooldownMs };
}

async function recordOpen(owner: PublicKey) {
  const key = openKey(owner);
  await redis.zadd(key, nowMs(), uuidv4());
  await redis.expire(key, Math.ceil(COOLDOWN_MS / 1000));
}

async function hasUsedSignature(signature: string): Promise<boolean> {
  const exists = await redis.get(sigKey(signature));
  return Boolean(exists);
}
async function markSignatureUsed(signature: string) {
  // Prevent re-use up to 7 days
  await redis.set(sigKey(signature), '1', 'EX', 7 * 24 * 60 * 60);
}

/** Verify that the provided signature paid at least the required fee to the treasury */
async function verifyPaymentSignature(signature: string, payer: PublicKey, minLamports: number): Promise<{ ok: boolean; lamportsToTreasury: number; slot?: number; blockTime?: number; err?: string }>
{
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return { ok: false, lamportsToTreasury: 0, err: 'Transaction not found or not confirmed' };
    if (tx.meta?.err) return { ok: false, lamportsToTreasury: 0, slot: tx.slot, blockTime: tx.blockTime ?? undefined, err: 'Transaction has error' };

    const keys = tx.transaction.message.getAccountKeys();
    const payerIndex = keys.staticAccountKeys.findIndex((k) => k.equals(payer));
    const treasuryIndex = keys.staticAccountKeys.findIndex((k) => k.equals(feeWallet));
    if (payerIndex === -1 || treasuryIndex === -1 || !tx.meta) {
      return { ok: false, lamportsToTreasury: 0, slot: tx.slot, blockTime: tx.blockTime ?? undefined, err: 'Required accounts not in transaction' };
    }
    const pre = tx.meta.preBalances[payerIndex];
    const post = tx.meta.postBalances[payerIndex];
    const preT = tx.meta.preBalances[treasuryIndex];
    const postT = tx.meta.postBalances[treasuryIndex];
    const paidFromPayer = pre - post; // includes fee + transfer
    const receivedByTreasury = postT - preT;

    const ok = receivedByTreasury >= minLamports && paidFromPayer >= minLamports;
    return { ok, lamportsToTreasury: receivedByTreasury, slot: tx.slot, blockTime: tx.blockTime ?? undefined, err: ok ? undefined : 'Insufficient payment to treasury' };
  } catch (e: any) {
    return { ok: false, lamportsToTreasury: 0, err: e?.message || String(e) };
  }
}

/* -------------------- API ROUTES -------------------- */

/**
 * Get basic status
 */
app.get('/health', async (_req: any, res: any) => {
  const balance = await connection.getBalance(treasuryPubkey);
  res.json({
    ok: true,
    network: await connection.getVersion().catch(() => null),
    treasury: treasury.publicKey,
    treasuryBalanceSOL: balance / LAMPORTS_PER_SOL,
  });
});

/**
 * Check eligibility & allowance remaining within cooldown window.
 * Query: ?owner=<pubkeyBase58>
 */
app.get('/eligibility', async (req: any, res: any) => {
  try {
    const ownerStr = String(req.query.owner || '');
    const owner = new PublicKey(ownerStr);
    const count = await findCollectionCountForOwner(mx, owner, gateCollection);
    const tokenCheck = await checkGateTokenHoldings(connection, owner, gateToken, ENV.OPEN_FEE_TOKEN)
    const tokenCheck1 = await checkGateTokenHoldings(connection, owner, gateToken1, ENV.OPEN_TOKEN1_AMOUNT)
    const tokenCheck2 = await checkGateTokenHoldings(connection, owner, gateToken2, ENV.OPEN_TOKEN2_AMOUNT)
    const tokenCheck3 = await checkGateTokenHoldings(connection, owner, gateToken3, ENV.OPEN_TOKEN3_AMOUNT)
    const isTokenHolder = tokenCheck.hasAccess || tokenCheck1.hasAccess || tokenCheck2.hasAccess || tokenCheck3.hasAccess;
    const { remaining, used, limit, cooldownMs } = await getOpensRemaining(owner, count, isTokenHolder);
    res.json({
      ok: true,
      owner: owner.toBase58(),
      gateCollection: gateCollection,
      holderCount: count,
      tokenBalance: tokenCheck.balance,
      opens: { used, limit, remaining, cooldownMs: cooldownMs },
      rule: count >= 10 ? '10+ holders can open 2 boxes / 24h' : 'Others can open 1 box / 24h'
    });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Prepare a payment transaction a client can sign to pay the opening fee.
 * POST { owner: <pubkeyBase58> }
 * Response: { txBase64, recentBlockhash, treasury }
 */
app.post('/prepare-payment', async (req: any, res: any) => {
  try {
    const owner = new PublicKey(String(req.body.owner || ''));
    const holderCount = await findCollectionCountForOwner(mx, owner, gateCollection);
    const tokenCheck = await checkGateTokenHoldings(connection, owner, gateToken, ENV.OPEN_FEE_TOKEN);
    const tokenCheck1 = await checkGateTokenHoldings(connection, owner, gateToken1, ENV.OPEN_TOKEN1_AMOUNT)
    const tokenCheck2 = await checkGateTokenHoldings(connection, owner, gateToken2, ENV.OPEN_TOKEN2_AMOUNT)
    const tokenCheck3 = await checkGateTokenHoldings(connection, owner, gateToken3, ENV.OPEN_TOKEN3_AMOUNT)
    const isTokenHolder = tokenCheck.hasAccess || tokenCheck1.hasAccess || tokenCheck2.hasAccess || tokenCheck3.hasAccess;
    if (holderCount < 1 && !isTokenHolder) {
      return res.status(403).json({ ok: false, error: 'Only NFT holders are allowed to open.' });
    }
    const { remaining } = await getOpensRemaining(owner, holderCount, isTokenHolder);
    if (remaining <= 0) {
      return res.status(403).json({ ok: false, error: 'Open limit reached in the last cooldown window' });
    }
    const ix = SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: feeWallet,
      lamports: ENV.OPEN_FEE_LAMPORTS,
    });
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: owner }).add(ix);
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    res.json({
      ok: true,
      txBase64: Buffer.from(serialized).toString('base64'),
      recentBlockhash: blockhash,
      lastValidBlockHeight,
      treasury: feeWallet.toBase58(),
      lamports: ENV.OPEN_FEE_LAMPORTS,
    });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Open the box (verify payment signature, enforce limits, roll prize, and distribute if any).
 * POST {
 *   owner: <pubkeyBase58>,
 *   signature: <solana tx signature of payment to treasury>
 * }
 */
app.post('/open', async (req: any, res: any) => {
  try {
    const owner = new PublicKey(String(req.body.owner || ''));
    const sig = String(req.body.signature || '');
    if (!sig) return res.status(400).json({ ok: false, error: 'Missing signature' });

    if (await hasUsedSignature(sig)) {
      return res.status(409).json({ ok: false, error: 'Signature already used' });
    }

    const holderCount = await findCollectionCountForOwner(mx, owner, gateCollection);
    const tokenCheck = await checkGateTokenHoldings(connection, owner, gateToken, ENV.OPEN_FEE_TOKEN)
    const tokenCheck1 = await checkGateTokenHoldings(connection, owner, gateToken1, ENV.OPEN_TOKEN1_AMOUNT)
    const tokenCheck2 = await checkGateTokenHoldings(connection, owner, gateToken2, ENV.OPEN_TOKEN2_AMOUNT)
    const tokenCheck3 = await checkGateTokenHoldings(connection, owner, gateToken3, ENV.OPEN_TOKEN3_AMOUNT)
    const isTokenHolder = tokenCheck.hasAccess || tokenCheck1.hasAccess || tokenCheck2.hasAccess || tokenCheck3.hasAccess;
    const { remaining } = await getOpensRemaining(owner, holderCount, isTokenHolder);
    if (remaining <= 0) {
      return res.status(403).json({ ok: false, error: 'Open limit reached in the last cooldown window' });
    }

    // Verify payment
    const check = await verifyPaymentSignature(sig, owner, ENV.OPEN_FEE_LAMPORTS);
    if (!check.ok) {
      return res.status(400).json({ ok: false, error: 'Payment verification failed: ' + (check.err || 'unknown') });
    }

    // Prevent re-use
    await markSignatureUsed(sig);

    // Roll prize (weights will be normalized; your requested weights sum to 101.1%)
    const prize = choosePrize();

    logPrize(prize);

    let prizeTxSig: string | null = null;
    let prizeMint: string | null = null;

    if (prize.kind === 'SOL') {
      const lamports = prize.lamports;
      const ix = SystemProgram.transfer({ fromPubkey: treasuryPubkey, toPubkey: owner, lamports });
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: treasuryPubkey }).add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
        ix
      );
      prizeTxSig = await sendAndConfirmTransaction(connection, tx, [treasury], { commitment: 'confirmed' });
    } else if (prize.kind === 'NFT') {
      // Pick NFT prize from treasury in prizeCollection
      const nft: any = await pickPrizeNftFromTreasury(mx, treasuryPubkey, prizeCollection);
      if (nft) {
        const mintAddress = nft.mint?.address || nft.mintAddress
        const sigNft = await transferNftTo(connection, treasury, mintAddress, owner);
        prizeMint = mintAddress.toString();
        prizeTxSig = sigNft;
      } else {
        // no NFT inventory, fallback to nothing
        console.warn('No NFT available in treasury for prizeCollection; fallback to nothing');
      }
    } else {
      // NOTHING
    }

    // Record open AFTER distribution attempt to avoid edge-cases
    await recordOpen(owner);

    res.json({
      ok: true,
      result: prize,
      prizeTxSig,
      prizeMint,
      payment: {
        signature: sig,
        lamportsToTreasury: check.lamportsToTreasury,
        slot: check.slot,
        blockTime: check.blockTime
      }
    });
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/* -------------------- START SERVER -------------------- */
app.listen(ENV.PORT, () => {
  console.log(`[daily-free-box] Listening on :${ENV.PORT}`);
  console.log(`Treasury: ${treasuryPubkey.toBase58()}`);
});

