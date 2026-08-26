import { Router } from "express";
import { randomUUID } from "crypto";
import path from "path";
import { requirePermission } from "../../adminAuth";
import pool from "../../pool";
import * as svc from "../../services/nft-gen.service";
import { logger } from "../../logger";
import { saveTask, getTask, keepAlive } from '../../utils/taskProgress';

const router = Router();

// ── In-memory progress map ────────────────────────────────────────────────────

interface GenerateState {
  status: 'running' | 'done' | 'error';
  phase: string;
  progress: number;
  total: number;
  jobId?: string;
  error?: string;
}
const generateJobs = new Map<string, GenerateState>();

// Tracks collections currently undergoing generation — blocks duplicate parallel runs
const generatingCollections = new Set<string>();

// ── POST /  start server-side generation ──────────────────────────────────────

router.post("/", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const { collectionId, editionSize } = req.body ?? {};
    if (!collectionId) { res.status(422).json({ error: "collectionId is required." }); return; }
    if (!editionSize || Number(editionSize) < 1) { res.status(422).json({ error: "editionSize must be >= 1." }); return; }
    if (Number(editionSize) > 50000) { res.status(422).json({ error: 'editionSize cannot exceed 50,000.' }); return; }
    if (generatingCollections.has(String(collectionId))) { res.status(409).json({ error: 'A generation is already running for this collection. Wait for it to complete.' }); return; }
    const generateId = randomUUID();
    generatingCollections.add(String(collectionId));
    generateJobs.set(generateId, { status: "running", phase: "Loading layers…", progress: 0, total: Number(editionSize) });

    const createdBy: string | null = (req as any).user?.userId ?? null;
    const job = runGenerate(generateId, String(collectionId), Number(editionSize), createdBy)
      .catch(async err => {
        const s = generateJobs.get(generateId);
        const msg = err instanceof Error ? err.message : String(err);
        if (s) { s.status = "error"; s.error = msg; }
        await saveTask(generateId, 'generate', { status: 'error', phase: 'Failed', progress: s?.progress ?? 0, total: Number(editionSize), error: msg, meta: { collectionId: String(collectionId) } });
        logger.warn("[generate] job failed", err);
      })
      .finally(() => { generatingCollections.delete(String(collectionId)); });
    keepAlive(job);
    await saveTask(generateId, 'generate', { status: 'running', phase: 'Loading layers…', progress: 0, total: Number(editionSize), meta: { collectionId: String(collectionId) } });

    res.status(202).json({ generateId });
  } catch (e) { next(e); }
});

router.get("/:generateId", async (req, res) => {
  const state = generateJobs.get(req.params.generateId);
  if (state) { res.json(state); return; }
  const db = await getTask(req.params.generateId);
  if (!db) { res.status(404).json({ error: "Generate job not found." }); return; }
  res.json(db);
});
router.post("/preview", async (req, res, next) => {
  try {
    requirePermission(req, "nft_gen.generate");
    const { supply, layers, weights, conflicts } = req.body ?? {};
    const editionSize = Number(supply) || 0;
    if (editionSize < 1) { res.status(422).json({ error: "supply must be >= 1." }); return; }
    if (editionSize > 50000) { res.status(422).json({ error: "supply cannot exceed 50,000." }); return; }
    if (!Array.isArray(layers) || !layers.length) { res.status(422).json({ error: "layers must be a non-empty array." }); return; }

    const combos = generateAllCombos(editionSize, layers, weights ?? {}, conflicts ?? []);
    const scored = computeRarity(combos, layers);

    res.json({
      items: scored.map(item => ({
        index: item.index,
        score: item.score,
        rank: item.rank,
        tier: item.tier,
        combo: combos[item.index - 1],
      })),
    });
  } catch (e) { next(e); }
});

type Asset = { stem: string; name: string; rel: string | null; defaultWeight: number };
type Layer = { folder: string; label: string; bypassDna: boolean; rarityPct: number; assets: Asset[] };
type ConflictRule = { type?: string; ifLayer: string; ifTrait: string; thenLayer: string; thenTraits: string[] };

function pickWeighted(assets: Asset[], ws: Record<string, number>): Asset | null {
  const pool = assets.filter(a => (ws[a.stem] ?? a.defaultWeight) > 0);
  if (!pool.length) return null;
  const tot = pool.reduce((s, a) => s + (ws[a.stem] ?? a.defaultWeight), 0);
  let r = Math.random() * tot;
  for (const a of pool) {
    r -= ws[a.stem] ?? a.defaultWeight;
    if (r <= 0) return a;
  }
  return pool[pool.length - 1];
}

function resolveConflicts(picks: Record<string, Asset | null>, rules: ConflictRule[], weights: Record<string, Record<string, number>>, layers: Layer[]) {
  if (!rules.length) return;
  const layerMap = Object.fromEntries(layers.map(l => [l.folder, l]));
  const expanded: ConflictRule[] = [];
  for (const rule of rules) {
    if ((rule.type ?? "exclude") === "exclude") {
      for (const t of rule.thenTraits) {
        const reverseExists = rules.some(r =>
          (r.type ?? "exclude") === "exclude" &&
          r.ifLayer === rule.thenLayer && r.ifTrait === t &&
          r.thenLayer === rule.ifLayer && r.thenTraits.includes(rule.ifTrait)
        );
        if (!reverseExists) expanded.push({ type: "exclude", ifLayer: rule.thenLayer, ifTrait: t, thenLayer: rule.ifLayer, thenTraits: [rule.ifTrait] });
      }
    }
  }
  const allRules = [...rules, ...expanded];

  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const rule of allRules) {
      if (picks[rule.ifLayer]?.stem !== rule.ifTrait) continue;
      const thenLayer = layerMap[rule.thenLayer];
      if (!thenLayer) continue;
      const ws = weights[rule.thenLayer] ?? {};
      if ((rule.type ?? "exclude") === "exclude") {
        if (!rule.thenTraits.includes(picks[rule.thenLayer]?.stem ?? "")) continue;
        const valid = thenLayer.assets.filter(a => !rule.thenTraits.includes(a.stem) && (ws[a.stem] ?? a.defaultWeight) > 0);
        const fallback = valid.length ? valid : thenLayer.assets.filter(a => (ws[a.stem] ?? a.defaultWeight) > 0);
        if (fallback.length) { picks[rule.thenLayer] = pickWeighted(fallback, ws); changed = true; }
      } else {
        if (rule.thenTraits.includes(picks[rule.thenLayer]?.stem ?? "")) continue;
        const valid = thenLayer.assets.filter(a => rule.thenTraits.includes(a.stem) && (ws[a.stem] ?? a.defaultWeight) > 0);
        if (valid.length) { picks[rule.thenLayer] = pickWeighted(valid, ws); changed = true; }
      }
    }
    if (!changed) break;
  }
}

function generateAllCombos(supply: number, layers: Layer[], weights: Record<string, Record<string, number>>, conflicts: ConflictRule[]): Record<string, Asset | null>[] {
  const seen = new Set<string>();
  return Array.from({ length: supply }, () => {
    let picks: Record<string, Asset | null> = {};
    for (let attempt = 0; attempt < 200; attempt++) {
      picks = {};
      for (const layer of layers) {
        if (layer.rarityPct < 100 && Math.random() * 100 >= layer.rarityPct) {
          picks[layer.folder] = null;
          continue;
        }
        const ws = weights[layer.folder] ?? {};
        picks[layer.folder] = pickWeighted(layer.assets, ws);
      }
      resolveConflicts(picks, conflicts, weights, layers);
      const key = layers.filter(l => !l.bypassDna).map(l => picks[l.folder]?.stem ?? "").join("|");
      if (!seen.has(key)) { seen.add(key); break; }
    }
    return picks;
  });
}

type RarityTier = "Legendary" | "Epic" | "Rare" | "Common";
type ScoredItem = { index: number; score: number; rank: number; tier: RarityTier; attrs: { trait_type: string; value: string }[]; dnaHash: string };

function computeRarity(combos: Record<string, Asset | null>[], layers: Layer[]): ScoredItem[] {
  const supply = combos.length;
  const traitCounts: Record<string, number> = {};
  for (const combo of combos) {
    for (const layer of layers) {
      const pick = combo[layer.folder];
      if (!pick) continue;
      const key = `${layer.label}\x00${pick.name}`;
      traitCounts[key] = (traitCounts[key] ?? 0) + 1;
    }
  }
  const scored = combos.map((combo, i) => {
    let score = 0;
    const attrs: { trait_type: string; value: string }[] = [];
    for (const layer of layers) {
      const pick = combo[layer.folder];
      if (!pick) continue;
      const key = `${layer.label}\x00${pick.name}`;
      score += supply / (traitCounts[key] ?? 1);
      attrs.push({ trait_type: layer.label, value: pick.name });
    }
    const dnaHash = layers.filter(l => !l.bypassDna).map(l => combo[l.folder]?.stem ?? "").join("|");
    return { index: i + 1, score: Math.round(score * 100) / 100, attrs, rank: 0, tier: "Common" as RarityTier, dnaHash };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  scored.forEach((item, i) => { item.rank = i + 1; });
  for (const item of scored) {
    if (item.rank <= Math.ceil(supply * 0.01)) item.tier = "Legendary";
    else if (item.rank <= Math.ceil(supply * 0.05)) item.tier = "Epic";
    else if (item.rank <= Math.ceil(supply * 0.15)) item.tier = "Rare";
  }
  return scored;
}

// ── Async cleanup — runs fire-and-forget AFTER generation completes ────────────
async function cleanOldGenerationData(collectionId: string, newJobId: string): Promise<void> {
  const { rows: oldJobs } = await pool.query<{ id: string }>(
    `SELECT id FROM nft_generation_jobs
     WHERE collection_id = $1::uuid
       AND id <> $2::uuid
       AND status IN ('complete', 'failed')`,
    [collectionId, newJobId]
  );
  if (!oldJobs.length) return;

  const oldIds = oldJobs.map(r => r.id);
  await pool.query(
    "DELETE FROM nft_generation_jobs WHERE id = ANY($1::uuid[])",
    [oldIds]
  );
  logger.info(`[generate] cleanup: removed ${oldIds.length} old job(s) for collection ${collectionId}`);
}

// ── Background worker ─────────────────────────────────────────────────────────

const BATCH_SIZE = 500;
const BATCH_CONCUR = 2;

async function runGenerate(generateId: string, collectionId: string, editionSize: number, createdBy: string | null) {
  const state = generateJobs.get(generateId)!;

  // 1. Load layers from DB
  const { rows: layerRows } = await pool.query(
    "SELECT * FROM nft_gen_layers_list($1::uuid)", [collectionId]
  );
  const activeLayers = layerRows
    .filter((l: any) => l.is_active)
    .sort((a: any, b: any) => a.sort_order - b.sort_order);

  if (!activeLayers.length) throw new Error("No active layers found for this collection. Go to the Settings tab and click Continue to sync your layers, then try generating again.");

  // 2. Load traits
  const layerIds = activeLayers.map((l: any) => l.id);
  const { rows: traitRows } = await pool.query(
    "SELECT * FROM nft_traits WHERE layer_id = ANY($1::uuid[]) AND is_active = true ORDER BY created_at ASC",
    [layerIds]
  );
  const { rows: collRows } = await pool.query(
    "SELECT conflict_rules FROM nft_collections WHERE id = $1::uuid",
    [collectionId]
  );
  const conflicts: ConflictRule[] = collRows[0]?.conflict_rules ?? [];
  const weights: Record<string, Record<string, number>> = {};

  // 4. Build layer structure
  const layers: Layer[] = activeLayers.map((l: any) => {
    const layerTraits = traitRows.filter((t: any) => t.layer_id === l.id);
    return {
      folder: l.name,
      label: l.display_name,
      bypassDna: l.bypass_dna ?? false,
      rarityPct: l.layer_rarity_pct ?? 100,
      assets: layerTraits.map((t: any) => ({
        stem: t.file_path ? path.basename(t.file_path, path.extname(t.file_path)) : t.id,
        name: t.name,
        rel: t.file_path,
        defaultWeight: Number(t.rarity_weight ?? 1),
      })),
    };
  });

  state.phase = "Generating combinations…";

  // 5. Run combo + rarity algorithm
  const combos = generateAllCombos(editionSize, layers, weights, conflicts);
  state.phase = "Computing rarity…";
  const scored = computeRarity(combos, layers);

  state.phase = "Creating job in database…";

  // 6. Create + start job
  const jobData = await svc.createJob({ collectionId, editionSize, createdBy: createdBy ?? undefined });
  const jobId = jobData?.id ?? jobData;
  if (!jobId) throw new Error("Failed to create generation job in DB.");
  await svc.startJob(String(jobId));
  state.jobId = String(jobId);

  state.phase = "Saving to database…";
  const allChunks: ScoredItem[][] = [];
  for (let i = 0; i < scored.length; i += BATCH_SIZE) allChunks.push(scored.slice(i, i + BATCH_SIZE));

  let done = 0;
  for (let g = 0; g < allChunks.length; g += BATCH_CONCUR) {
    const group = allChunks.slice(g, g + BATCH_CONCUR);
    await Promise.all(group.map(chunk =>
      svc.insertItemsBatch({
        jobId: String(jobId),
        items: chunk.map(item => ({
          editionNumber: item.index,
          dnaHash: item.dnaHash,
          score: item.score,
          rank: item.rank,
          tier: item.tier,
          traits: item.attrs.map(a => ({ traitType: a.trait_type, traitValue: a.value })),
        })),
      })
    ));
    done += group.reduce((s, c) => s + c.length, 0);
    state.progress = done;
    state.phase = `Saving to database… ${done} / ${editionSize}`;
    await saveTask(generateId, 'generate', { status: 'running', phase: state.phase, progress: done, total: editionSize, meta: { collectionId } });
  }

  // 8. Complete job, then clean up old jobs (after inserts finish to avoid lock contention)
  await svc.completeJob(String(jobId));
  state.status = "done";
  state.phase = `Complete — ${editionSize} NFTs generated`;
  await saveTask(generateId, 'generate', { status: 'done', phase: state.phase, progress: editionSize, total: editionSize, meta: { collectionId, jobId: String(jobId) } });

  cleanOldGenerationData(collectionId, String(jobId)).catch(err =>
    logger.warn("[generate] cleanup error (non-critical)", err)
  );
}

export default router;
