import pool from "../pool";
import { buildMerkleTree } from "../merkle";
import { contractSetAllowlistRoot } from "./contract.service";
import { keepAlive } from "../utils/taskProgress";

// ── Chain sync ────────────────────────────────────────────────────────────────

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
    // Durable record, not just a console line nobody's watching -- this is
    // exactly how the 2026-09-09 desync went unnoticed until a customer's
    // mint silently reverted. Query v_whitelist_sync_status to check.
    await pool.query(
      "SELECT whitelist_state_record_push_attempt($1, false, $2)",
      [root, message],
    );
    throw err;
  }
}

// Merkle rebuild + on-chain push (Wave 1 allowlist root), kept alive past the
// HTTP response via Vercel's waitUntil() -- previously this ran fully
// unawaited with no waitUntil, so Vercel could (and, on 2026-09-09, did)
// freeze/tear down the function mid-push, silently leaving the on-chain root
// stale with nothing but a console.error nobody was watching. Safe to call
// before this collection's contract is deployed/configured -- a missing
// CONTRACT_ADDRESS/signer just makes contractSetAllowlistRoot throw, which is
// now durably recorded (see rebuildMerkleAndPush's catch) rather than lost.
// DB registration (the part that actually matters for the Customers page)
// already completed before this fires.
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

// ── Auto-register (wallet_connect path) ───────────────────────────────────────

// Creates a stub customer user for a wallet that just connected for the first time.
// Always ensures the wallet has a user_id and is_whitelisted = TRUE.
// Triggers async Merkle rebuild + on-chain push.
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

// ── Strict validation (admin_sale / airdrop paths) ────────────────────────────

// Throws an Error listing any wallets that are not in customer_wallets with a user_id.
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
