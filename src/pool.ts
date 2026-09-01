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
    return typeof value === "function" ? value.bind(real) : value;
  },
});
export async function getClient() {
  return getPool().connect();
}
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
