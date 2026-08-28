import { Pool } from "pg";
import { logger } from "./logger";

let _pool: Pool | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  _pool = new Pool({
    connectionString: url,
    ssl: (url.includes("localhost") || url.includes("127.0.0.1"))
      ? false
      : { rejectUnauthorized: false },
    // Parallel export runs up to 8 slices concurrently, each issuing its own
    // DB queries per batch, alongside normal admin/session traffic sharing
    // this same pool. At max=10 that queues behind connectionTimeoutMillis
    // and stalls everything, including unrelated requests like login --
    // confirmed live: a plain login call took ~90s and every export slice
    // sat at 0 progress for 9+ minutes. The real Postgres server here allows
    // 500 connections with only ~13 in use, so this had no server-side
    // reason to be this low.
    max: 40,
    min: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  });
  _pool.on("error", (err) => {
    logger.warn("[pool] idle client error", err);
  });
  return _pool;
}

const pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const real = getPool() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    // Methods (query, connect, end, ...) must run with `this` bound to the real
    // Pool, not this Proxy — pg's Pool relies on internal instance state that a
    // bare `proxy.connect()` call would otherwise read/write on the wrong object.
    return typeof value === "function" ? value.bind(real) : value;
  },
});

// Properly-bound client checkout for callers that need one connection held
// across multiple sequential queries (e.g. bulk inserts) instead of a fresh
// pool.query() per statement.
export async function getClient() {
  return getPool().connect();
}

// Ping the DB every 60 seconds so Railway never closes idle connections.
// Railway's idle TCP timeout is ~5 min; 60s keepalive keeps all pool
// connections warm and prevents "db_connection_timeout" 503 errors.
export function startPoolKeepalive(intervalMs = 60_000): void {
  setInterval(async () => {
    try {
      await getPool().query("SELECT 1");
    } catch (err) {
      logger.warn("[pool] keepalive ping failed — pool will reconnect on next request", err);
    }
  }, intervalMs);
}

export default pool;
