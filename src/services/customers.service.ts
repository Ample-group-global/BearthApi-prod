import pool from "../pool";
import { toCamel } from "../utils/camel";

export async function listCustomers(params: {
  search?: string | null;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: string;
}) {
  const { search = null, activeOnly = true, limit = 20, offset = 0, sortBy = "created_at", sortDir = "desc" } = params;
  const { rows } = await pool.query(
    "SELECT * FROM customers_list($1, $2, $3, $4, $5, $6)",
    [search, activeOnly, limit, offset, sortBy, sortDir],
  );
  return { customers: toCamel(rows), total: Number(rows[0]?.total_count ?? 0), limit, offset };
}

export async function getCustomer(id: string) {
  const { rows } = await pool.query("SELECT customers_get($1::uuid) AS data", [id]);
  return rows[0]?.data ?? null;
}

export async function createCustomer(params: {
  firstName: string; lastName: string; phone?: string; email?: string;
  lineId?: string; referrerId?: string; notes?: string;
}) {
  const { firstName, lastName, phone, email, lineId, referrerId, notes } = params;
  const { rows } = await pool.query(
    "SELECT * FROM customers_create($1, $2, $3, $4, $5, $6, $7)",
    [firstName, lastName, phone ?? null, email ?? null, lineId ?? null, referrerId ?? null, notes ?? null],
  );
  return rows[0] ?? null;
}

export async function updateCustomer(id: string, params: {
  firstName?: string; lastName?: string; phone?: string; email?: string;
  lineId?: string; referrerId?: string; notes?: string; isActive?: boolean;
}) {
  const { firstName, lastName, phone, email, lineId, referrerId, notes, isActive } = params;
  const { rows } = await pool.query(
    "SELECT * FROM customers_update($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [id, firstName ?? null, lastName ?? null, phone ?? null, email ?? null, lineId ?? null, referrerId ?? null, notes ?? null, isActive ?? null],
  );
  return rows[0] ?? null;
}

export async function setCustomerStatus(id: string, isActive: boolean) {
  const { rows } = await pool.query(
    "SELECT * FROM customers_update($1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, $2)",
    [id, isActive],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, isActive: rows[0].is_active };
}

export async function deactivateCustomer(id: string) {
  const { rows } = await pool.query("SELECT * FROM customers_deactivate($1::uuid)", [id]);
  return rows[0] ?? null;
}

export async function listCustomerWallets(customerId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM customer_wallets_list($1::uuid)",
    [customerId],
  );
  return toCamel(rows);
}

export async function addCustomerWallet(customerId: string, address: string) {
  const { rows } = await pool.query(
    "SELECT * FROM customer_wallets_add($1::uuid, $2)",
    [customerId, address],
  );
  return rows[0] ?? null;
}

export async function removeCustomerWallet(walletId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM customer_wallets_remove($1::uuid)",
    [walletId],
  );
  return rows[0] ?? null;
}

// Cross-customer wallet view -- used for a "which wallets are already
// registered" glance rather than drilling into each customer individually.
export async function listAllCustomerWallets() {
  const { rows } = await pool.query(`
    SELECT
      u.id               AS user_id,
      u.user_code,
      CONCAT(u.first_name, ' ', u.last_name) AS full_name,
      u.email,
      cw.id              AS wallet_id,
      cw.address,
      cw.is_whitelisted,
      cw.is_blocked,
      cw.is_vip,
      cw.wallet_total_minted,
      cw.added_at
    FROM users u
    INNER JOIN customer_wallets cw ON cw.user_id = u.id
    WHERE u.role_id = (SELECT id FROM roles WHERE code = 'customer')
      AND u.is_active = TRUE
    ORDER BY u.first_name, u.last_name, cw.added_at
  `);
  return toCamel(rows);
}
