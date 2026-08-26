import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import pool from "../pool"; // patch_v38 added 2026-08-11
import { logger } from "../logger";

const DB_DIR = join(__dirname, "../../db");

function patchVersion(name: string): number {
  const m = name.match(/^patch_v(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function listPatchFiles(): string[] {
  return readdirSync(DB_DIR)
    .filter(f => /^patch_v\d+.*\.sql$/.test(f))
    .sort((a, b) => {
      const d = patchVersion(a) - patchVersion(b);
      return d !== 0 ? d : a.localeCompare(b);
    });
}

export async function runPendingMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    // Detect whether schema_migrations already exists
    const { rows: exists } = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'schema_migrations'
      ) AS exists
    `);
    const firstInit = !exists[0].exists;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const patches = listPatchFiles();

    if (firstInit) {
      // Existing DB: baseline all current patches as already applied so we
      const { rows: nftCheck } = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'nft_records'
        ) AS exists
      `);
      if (nftCheck[0].exists) {
        // Existing DB — mark all patches as applied without running them
        for (const filename of patches) {
          await client.query(
            "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
            [filename],
          );
        }
        logger.info(`[migrate] Existing DB: baselined ${patches.length} patch(es) — none re-run`);
        return;
      }
      // Fresh DB — fall through and apply all patches from scratch
    }

    // Find unapplied patches
    const { rows: applied } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations",
    );
    const done = new Set(applied.map(r => r.filename));
    const pending = patches.filter(f => !done.has(f));

    if (pending.length === 0) {
      logger.info("[migrate] All patches up to date");
      return;
    }

    for (const filename of pending) {
      const sql = readFileSync(join(DB_DIR, filename), "utf8");
      logger.info(`[migrate] Applying ${filename}...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
          [filename],
        );
        await client.query("COMMIT");
        logger.info(`[migrate] ✓ ${filename}`);
      } catch (err) {
        await client.query("ROLLBACK");
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[migrate] ✗ ${filename}: ${msg}`);
        throw new Error(`Migration failed on ${filename}: ${msg}`);
      }
    }

    logger.info(`[migrate] Applied ${pending.length} pending patch(es)`);
  } finally {
    client.release();
  }
}
