import { waitUntil } from '@vercel/functions';
import pool from '../pool';

export interface TaskRow {
  status: 'running' | 'done' | 'error';
  phase: string;
  progress: number;
  total: number;
  error?: string | null;
  meta: Record<string, unknown>;
}

// Auto-created on first use — no migration file needed.
let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nft_task_progress (
      id          TEXT        PRIMARY KEY,
      task_type   TEXT        NOT NULL,
      status      TEXT        NOT NULL DEFAULT 'running',
      phase       TEXT        NOT NULL DEFAULT '',
      progress    INT         NOT NULL DEFAULT 0,
      total       INT         NOT NULL DEFAULT 0,
      meta        JSONB       NOT NULL DEFAULT '{}',
      error       TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  ensured = true;
}

// Upserts task state. Never throws — in-memory Map is the primary source.
export async function saveTask(id: string, taskType: string, row: TaskRow): Promise<void> {
  try {
    await ensureTable();
    await pool.query(
      `INSERT INTO nft_task_progress (id, task_type, status, phase, progress, total, meta, error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (id) DO UPDATE SET
         status=$3, phase=$4, progress=$5, total=$6, meta=$7, error=$8, updated_at=NOW()`,
      [id, taskType, row.status, row.phase, row.progress, row.total,
       JSON.stringify(row.meta ?? {}), row.error ?? null],
    );
  } catch { /* non-fatal — caller has in-memory fallback */ }
}

// Reads task state from DB. Returns null on miss or error.
export async function getTask(id: string): Promise<TaskRow | null> {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `SELECT status, phase, progress, total, meta, error
       FROM nft_task_progress WHERE id = $1`,
      [id],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return { status: r.status, phase: r.phase, progress: r.progress, total: r.total, error: r.error, meta: r.meta ?? {} };
  } catch { return null; }
}

// Signals Vercel to keep the function instance alive until the promise settles
// (up to vercel.json maxDuration). On local dev / non-Vercel the call is a no-op.
export function keepAlive(p: Promise<unknown>): void {
  try { waitUntil(p); } catch { /* non-Vercel environment */ }
}
