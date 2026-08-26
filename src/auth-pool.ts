import { Pool } from "pg";
import { logger } from "./logger";

let _authPool: Pool | null = null;

export function getAuthPool(): Pool {
  if (_authPool) return _authPool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  _authPool = new Pool({
    connectionString: url,
    ssl: (url.includes("localhost") || url.includes("127.0.0.1"))
      ? false
      : { rejectUnauthorized: false },
    max: 2,
    min: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
  });
  _authPool.on("error", (err) => {
    logger.warn("[auth-pool] idle client error", err);
  });
  return _authPool;
}

const authPool = new Proxy({} as Pool, {
  get(_target, prop) {
    return (getAuthPool() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export default authPool;
