import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  keypairIdentity,
  Metadata,
  Metaplex,
  Nft,
  Sft,
  toBigNumber,
} from '@metaplex-foundation/js';
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAccount,
  getMint,
} from '@solana/spl-token';

export async function checkGateTokenHoldings(
  connection: Connection,
  walletAddress: PublicKey,
  gateTokenMint: PublicKey,
  requiredAmount: number = 1000
): Promise<{ hasAccess: boolean; balance: number }> {
  try {
    // Get all token accounts for the wallet
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletAddress, {
      mint: gateTokenMint,
    });

    if (tokenAccounts.value.length === 0) {
      return { hasAccess: false, balance: 0};
    }

    // Get token mint info to determine decimals
    const mintInfo = await getMint(connection, gateTokenMint);
    const decimals = mintInfo.decimals;

    // Calculate total balance across all token accounts
    let totalBalance = 0;
    
    for (const accountInfo of tokenAccounts.value) {
      const accountData = accountInfo.account.data.parsed.info;
      const tokenAmount = accountData.tokenAmount;
      
      // Convert to actual tokens using decimals
      const balance = tokenAmount.uiAmount || (tokenAmount.amount / Math.pow(10, decimals));
      totalBalance += balance;
    }

    // Check if balance meets requirement
    const hasAccess = totalBalance >= requiredAmount;

    return {
      hasAccess,
      balance: totalBalance
    };

  } catch (error) {
    console.error('Error checking gate token holdings:', error);
    return { hasAccess: false, balance: 0 };
  }
}


/**
 * Count the number of NFTs owned by `owner` that belong to the verified `collection`.
 * Uses Metaplex JS to look up metadata.
 */
export async function findCollectionCountForOwner(
  mx: Metaplex,
  owner: PublicKey,
  collection: PublicKey | string
): Promise<number> {
  try {
    const allMetadata = await mx.nfts().findAllByOwner({ owner });
    if (allMetadata.length === 0) return 0;

    // Process all NFTs in parallel with limited concurrency
    const BATCH_SIZE = 20;
    let count = 0;

    for (let i = 0; i < allMetadata.length; i += BATCH_SIZE) {
      const batch = allMetadata.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map(async (metadata) => {
          try {
            // For certified collections - quick check first
            if (collection instanceof PublicKey) {
              if (metadata.model === 'metadata') {
                const meta = metadata as Metadata;
                if (meta.collection && meta.collection.address.equals(collection)) {
                  if (!meta.collection.verified) {
                    const nft = await mx.nfts().load({ metadata: meta });
                    return nft.collection?.verified ? 1 : 0;
                  }
                  return 1;
                }
              } else {
                const nft = metadata as Nft | Sft;
                return (nft.collection?.address?.equals(collection) && nft.collection.verified) ? 1 : 0;
              }
            } else {
              const nft = metadata as Nft | Sft;
              if (nft && (nft.symbol === "ELMNT")) {
                return 1;
              }
              return 0;
            }

            return 0;
          } catch (err) {
            return 0;
          }
        })
      );

      // Sum results from this batch
      const batchCount = batchResults.reduce((sum, result) =>
        sum + (result.status === 'fulfilled' ? result.value : 0), 0
      );

      count += batchCount;

      // Early termination
    }

    return count;

  } catch (err) {
    console.error('Parallel collection count error:', err);
    return 0;
  }
}

/**
 * Pick one NFT in the treasury that belongs to the `prizeCollection`.
 * Returns full NFT/SFT model or null if none available.
 */
export async function pickPrizeNftFromTreasury(
  mx: Metaplex,
  treasury: PublicKey,
  collection: PublicKey | string // PublicKey = certified, string = legacy JSON name
): Promise<Nft | Sft | Metadata | null> {
  try {
    const all = await mx.nfts().findAllByOwner({ owner: treasury });
    const eligible: (Nft | Sft)[] = [];

    for (const metadata of all) {
      try {
        // For certified collections - quick check first
        if (collection instanceof PublicKey) {
          if (metadata.model === 'metadata') {
            const meta = metadata as Metadata;
            if (meta.collection && meta.collection.address.equals(collection)) {
              if (!meta.collection.verified) {
                const nft = await mx.nfts().load({ metadata: meta });
                if(nft.collection?.verified){
                  eligible.push(nft);
                }
              }
            }
          } else {
            const nft = metadata as Nft | Sft;
            if(nft.collection?.address?.equals(collection) && nft.collection.verified) {
              eligible.push(nft)
            }
          }
        } else {
          const nft = metadata as Nft | Sft;
          if (nft && (nft.symbol === "ELMNT")) {
            eligible.push(nft)
          }
        }

      } catch (err) {
        console.error("pickPrizeNft inner error:", err);
      }
    }

    if (eligible.length === 0) return null;

    const randomIndex = Math.floor(Math.random() * eligible.length);
    return eligible[randomIndex];
  } catch (err) {
    console.error("pickPrizeNftFromTreasury failed:", err);
    return null;
  }
}
/**
 * Transfer one token of the NFT mint from treasury to recipient.
 * Works for both 1/1 NFTs (decimals=0, supply=1) and SFTs (decimals may be >0, but transfer 1 unit).
 */
export async function transferNftTo(
  connection: Connection, 
  treasury: Keypair, 
  mint: PublicKey, 
  recipient: PublicKey
): Promise<string> {
  try {
    // Initialize Metaplex
    const metaplex = Metaplex.make(connection)
      .use(keypairIdentity(treasury));

    // Get the NFT
    const nft = await metaplex.nfts().findByMint({ mintAddress: mint });

    // Transfer using Metaplex (handles metadata properly)
    const { response } = await metaplex.nfts().transfer({
      nftOrSft: nft,
      fromOwner: treasury.publicKey,
      toOwner: recipient
    });

    return response.signature;

  } catch (error) {
    console.error('Metaplex transfer failed:', error);
    throw new Error(`NFT transfer failed`);
  }
}
