import pool from "../pool";
import { buildMerkleTree } from "../merkle";
import { contractSetAllowlistRoot } from "./contract.service";
import { keepAlive } from "../utils/taskProgress";

async function rebuildMerkleAndPush(): Promise<void> {
  const { rows } = await pool.query("SELECT * FROM whitelist_addresses_all()");
  const addresses = rows.map((r: { address: string }) => r.address);
  if (!addresses.length) return;
  const { root } = buildMerkleTree(addresses);
  await pool.query("SELECT whitelist_state_update_root($1)", [root]);
  try {
    await contractSetAllowlistRoot(root);
    await pool.query("SELECT whitelist_state_record_push_attempt($1, true, NULL)", [root]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      "SELECT whitelist_state_record_push_attempt($1, false, $2)",
      [root, message],
    );
    throw err;
  }
}

export function triggerChainSync(): void {
  keepAlive(
    rebuildMerkleAndPush().catch(err => {
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

export async function reconcileWhitelistRoot(): Promise<ReconcileResult> {
  const checkedAt = new Date().toISOString();
  const { rows } = await pool.query("SELECT * FROM v_whitelist_sync_status");
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
    await rebuildMerkleAndPush();
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

export async function pushEffectiveRootOnChain(): Promise<PushChainResult> {
  const { rows } = await pool.query(
    "SELECT merkle_root, manual_override FROM whitelist_state WHERE id = 1"
  );
  const state = rows[0] as { merkle_root: string | null; manual_override: boolean } | undefined;

  let root: string;
  if (state?.manual_override && state.merkle_root) {
    root = state.merkle_root;
  } else {
    const { rows: addrRows } = await pool.query("SELECT * FROM whitelist_addresses_all()");
    const addresses = addrRows.map((r: { address: string }) => r.address);
    if (!addresses.length) throw new Error("No whitelisted addresses to push");
    root = buildMerkleTree(addresses).root;
    await pool.query("SELECT whitelist_state_update_root($1)", [root]);
  }

  try {
    const receipt = await contractSetAllowlistRoot(root);
    await pool.query("SELECT whitelist_state_record_push_attempt($1, true, NULL)", [root]);
    return { root, txHash: receipt.hash };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query("SELECT whitelist_state_record_push_attempt($1, false, $2)", [root, message]);
    throw err;
  }
}

export async function autoRegisterAndSync(
  address: string,
  source: string
): Promise<void> {
  await pool.query(
    "SELECT customer_wallet_auto_register($1, $2)",
    [address.toLowerCase(), source]
  );
  triggerChainSync();
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
