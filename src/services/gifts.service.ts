import { ethers } from "ethers";
import pool from "../pool";
import { getProvider } from "../utils/contract-factory";
import { HttpError } from "../errors";
import { contractReserveMint } from "./contract.service";
import BearthNFT_ABI from "../abi/BearthNFT.abi.json";

const TREASURY_ABI = ["function transferNFT(address collection, address to, uint256 tokenId)"];
const NFT_ABI = ["function transferFrom(address from, address to, uint256 tokenId)"];

interface CollectionAddrs {
  contractAddress: string;
  treasuryAddress: string;
}

async function resolveAddrs(collectionId: string): Promise<CollectionAddrs> {
  const { rows } = await pool.query(
    "SELECT contract_address, contract_treasury_address FROM nft_collections WHERE id = $1",
    [collectionId],
  );
  const row = rows[0];
  if (!row?.contract_address) throw new HttpError(400, "This collection does not have a deployed contract yet.");
  if (!row?.contract_treasury_address) throw new HttpError(400, "This collection does not have a Treasury contract deployed yet.");
  return { contractAddress: row.contract_address, treasuryAddress: row.contract_treasury_address };
}

// Only ever pulls from tokens the Treasury already holds -- i.e. unsold
// remainder already swept out of a closed wave via treasuryClose(). Never
// touches active wave inventory, so the Fibonacci wave split is untouched.
// FOR UPDATE SKIP LOCKED so two concurrent airdrop calls can't both grab
// the same token.
async function pickUnsoldTreasuryToken(
  client: import("pg").PoolClient,
  collectionId: string,
  treasuryAddress: string,
  rarityTier?: string,
): Promise<{ id: string; tokenId: number } | null> {
  const { rows } = await client.query(
    `SELECT id, token_id FROM nft_records
      WHERE collection_id = $1 AND LOWER(owner_address) = LOWER($2) AND token_id IS NOT NULL
        AND ($3::text IS NULL OR rarity_tier = $3)
      ORDER BY token_id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [collectionId, treasuryAddress, rarityTier ?? null],
  );
  return rows[0] ? { id: rows[0].id, tokenId: Number(rows[0].token_id) } : null;
}

export interface AirdropResult {
  recipientWallet: string;
  ok: boolean;
  tokenId?: number;
  txHash?: string;
  error?: string;
}

// Two-hop transfer (Treasury -> operations wallet -> recipient) instead of
// a direct Treasury.transferNFT() to the recipient -- Treasury's destination
// allowlist is a small, deliberately curated set of trusted operators, not
// meant to hold one-off community airdrop addresses. Both hops use existing,
// already-audited functions; no new broad-destination contract code needed.
export async function airdropOneNftToWallet(
  collectionId: string,
  recipientWallet: string,
  rarityTier?: string,
): Promise<AirdropResult> {
  const { contractAddress, treasuryAddress } = await resolveAddrs(collectionId);
  const privateKey = process.env.CONTRACT_PRIVATE_KEY ?? process.env.FIXED_PRIVATE_KEY;
  if (!privateKey) throw new Error("CONTRACT_PRIVATE_KEY (or FIXED_PRIVATE_KEY) env var is required");
  const signer = new ethers.Wallet(privateKey, getProvider());
  const opsWallet = signer.address;

  const client = await pool.connect();
  let picked: { id: string; tokenId: number } | null;
  try {
    await client.query("BEGIN");
    picked = await pickUnsoldTreasuryToken(client, collectionId, treasuryAddress, rarityTier);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (!picked) {
    return {
      recipientWallet, ok: false,
      error: rarityTier
        ? `No unsold treasury-held tokens available matching rarity "${rarityTier}".`
        : "No unsold treasury-held tokens available.",
    };
  }

  const treasury = new ethers.Contract(treasuryAddress, TREASURY_ABI, signer);
  const nft = new ethers.Contract(contractAddress, NFT_ABI, signer);

  const tx1 = await (treasury.transferNFT as (c: string, t: string, id: number, o?: object) => Promise<ethers.TransactionResponse>)(
    contractAddress, opsWallet, picked.tokenId,
  );
  await tx1.wait(1);

  const tx2 = await (nft.transferFrom as (f: string, t: string, id: number) => Promise<ethers.TransactionResponse>)(
    opsWallet, recipientWallet, picked.tokenId,
  );
  const receipt2 = await tx2.wait(1);
  if (!receipt2) throw new Error("No receipt for final airdrop transfer");

  return { recipientWallet, ok: true, tokenId: picked.tokenId, txHash: receipt2.hash };
}

// Paid gifts are minted via reserveMint(..., waveNum=0) -- the contract's
// dedicated reserve/treasury allocation, entirely outside the 7 sale waves --
// so fulfilling a gift order never touches the Fibonacci wave split either.
export async function fulfillPaidGift(collectionId: string, recipientWallet: string): Promise<{ tokenId: number; txHash: string }> {
  const receipt = await contractReserveMint(recipientWallet, 1, 0, collectionId);
  const iface = new ethers.Interface(BearthNFT_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Transfer" && parsed.args[0] === ethers.ZeroAddress) {
        return { tokenId: Number(parsed.args[2]), txHash: receipt.hash };
      }
    } catch { /* not a Transfer log from this contract, skip */ }
  }
  throw new Error("reserveMint succeeded but no Transfer/mint event was found in the receipt");
}
