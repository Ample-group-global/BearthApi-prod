import pool from "../pool";
import { buildMerkleTree } from "../merkle";
import { contractSetAllowlistRoot } from "./contract.service";
import { keepAlive } from "../utils/taskProgress";

async function rebuildMerkleAndPush(collectionId: string): Promise<void> {
  const { rows } = await pool.query("SELECT * FROM whitelist_addresses_for_collection($1)", [collectionId]);
  const addresses = rows.map((r: { address: string }) => r.address);
  if (!addresses.length) return;
  const { root } = buildMerkleTree(addresses);
  await pool.query("SELECT whitelist_state_update_root($1, $2)", [collectionId, root]);
  try {
    await contractSetAllowlistRoot(root, collectionId);
    await pool.query("SELECT whitelist_state_record_push_attempt($1, $2, true, NULL)", [collectionId, root]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      "SELECT whitelist_state_record_push_attempt($1, $2, false, $3)",
      [collectionId, root, message],
    );
    throw err;
  }
}

// The whitelist roster and its merkle-root/push-status tracking are both
// genuinely per-collection now (nft_collection_whitelist, whitelist_state
// keyed by collection_id) -- collectionId is required everywhere in this
// file so a caller can never accidentally push one collection's root onto
// another's contract.
export function triggerChainSync(collectionId: string): void {
  keepAlive(
    rebuildMerkleAndPush(collectionId).catch(err => {
      console.error(
        "[customer-whitelist] Chain sync failed:",
        err instanceof Error ? err.message : String(err)
      );
    }),
  );
}

export interface ReconcileResult {
  checkedAt: string;
  wasInSync: boolean;
  healed: boolean;
  merkleRoot: string | null;
  onchainRootBefore: string | null;
  error?: string;
}

export async function reconcileWhitelistRoot(collectionId: string): Promise<ReconcileResult> {
  const checkedAt = new Date().toISOString();
  const { rows } = await pool.query("SELECT * FROM whitelist_sync_status_for_collection($1)", [collectionId]);
  const status = rows[0] as
    | { merkle_root: string | null; onchain_root: string | null; in_sync: boolean }
    | undefined;

  if (!status || status.in_sync) {
    return {
      checkedAt,
      wasInSync: true,
      healed: false,
      merkleRoot: status?.merkle_root ?? null,
      onchainRootBefore: status?.onchain_root ?? null,
    };
  }

  try {
    await rebuildMerkleAndPush(collectionId);
    return {
      checkedAt,
      wasInSync: false,
      healed: true,
      merkleRoot: status.merkle_root,
      onchainRootBefore: status.onchain_root,
    };
  } catch (err) {
    return {
      checkedAt,
      wasInSync: false,
      healed: false,
      merkleRoot: status.merkle_root,
      onchainRootBefore: status.onchain_root,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface PushChainResult {
  root: string;
  txHash: string;
}

export async function pushEffectiveRootOnChain(collectionId: string): Promise<PushChainResult> {
  const { rows } = await pool.query(
    "SELECT merkle_root, manual_override FROM whitelist_state WHERE collection_id = $1",
    [collectionId],
  );
  const state = rows[0] as { merkle_root: string | null; manual_override: boolean } | undefined;

  let root: string;
  if (state?.manual_override && state.merkle_root) {
    root = state.merkle_root;
  } else {
    const { rows: addrRows } = await pool.query("SELECT * FROM whitelist_addresses_for_collection($1)", [collectionId]);
    const addresses = addrRows.map((r: { address: string }) => r.address);
    if (!addresses.length) throw new Error("No whitelisted addresses to push");
    root = buildMerkleTree(addresses).root;
    await pool.query("SELECT whitelist_state_update_root($1, $2)", [collectionId, root]);
  }

  try {
    const receipt = await contractSetAllowlistRoot(root, collectionId);
    await pool.query("SELECT whitelist_state_record_push_attempt($1, $2, true, NULL)", [collectionId, root]);
    return { root, txHash: receipt.hash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query("SELECT whitelist_state_record_push_attempt($1, $2, false, $3)", [collectionId, root, message]);
    throw err;
  }
}

// collectionId is optional here specifically because the customer-facing
// wallet-connect flow (Bearth-FE) has no concept of "which collection" at
// all -- it only ever sends a raw address. Registering the wallet's identity
// doesn't need a collection; pushing a merkle root does. Skipping the push
// when collectionId is absent is deliberate: the old code guessed a target
// via a legacy shared CONTRACT_ADDRESS fallback, which is exactly the
// wrong-contract bug this whole redesign exists to eliminate. Once Bearth-FE
// is taught which collection it represents, pass collectionId here too.
export async function autoRegisterAndSync(
  address: string,
  source: string,
  collectionId?: string,
): Promise<void> {
  await pool.query(
    "SELECT customer_wallet_auto_register($1, $2)",
    [address.toLowerCase(), source]
  );
  if (collectionId) triggerChainSync(collectionId);
}

export async function requireRegisteredWallets(wallets: string[]): Promise<void> {
  const unregistered: string[] = [];
  for (const addr of wallets) {
    const { rows } = await pool.query(
      "SELECT customer_wallet_get_user_id($1) AS user_id",
      [addr.toLowerCase()]
    );
    if (!rows[0]?.user_id) unregistered.push(addr);
  }
  if (!unregistered.length) return;
  const preview = unregistered.slice(0, 3).join(", ");
  const extra   = unregistered.length > 3 ? ` and ${unregistered.length - 3} more` : "";
  throw new Error(
    `${unregistered.length} wallet(s) not registered: ${preview}${extra}.`
  );
}
