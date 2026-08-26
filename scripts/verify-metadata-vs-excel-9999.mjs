// Read-only spot-check: for a sample of generated items, confirm every trait
// name used per layer is a legitimate name from the artist's NFTTRAITS.xlsx
// sheet for that layer (set-membership, sheet matched by normalized name ==
// layer folder/display name — same normalization rule CollectionSetup.tsx
// uses), and sanity-checks weight-vs-observed-frequency ranking.
// Run from BearthApi-V1/: node scripts/verify-metadata-vs-excel-9999.mjs <collectionId> [sampleSize]
import pg from "pg";
import fs from "fs";
import XLSX from "xlsx";

const envPath = new URL("../.env.local", import.meta.url);
const envText = fs.readFileSync(envPath, "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: false });

const collectionId = process.argv[2];
const sampleSize = Number(process.argv[3] || 80);
if (!collectionId) { console.error("Usage: node verify-metadata-vs-excel-9999.mjs <collectionId> [sampleSize]"); process.exit(1); }

const EXCEL_PATH = "D:\\AMG-Projects\\AMGEcosystem\\amgecosystem\\amgecosystem-v1.0.0\\Judy\\NFT-Files\\FinalGenerationAndTesting\\New-Judy\\NFTTRAITS.xlsx";

function normalizeLayerKey(s) {
  return String(s).toLowerCase().replace(/^\d+[_\-\s]*/, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function parseWeightCell(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).replace("%", "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const wb = XLSX.readFile(EXCEL_PATH);
const excelByLayerKey = {}; // normalized key -> { names: Set, weightByName: Map }
for (const sheetName of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: "" });
  if (!rows.length) continue;
  const header = rows[0].map(h => String(h).toLowerCase());
  const nameColIdx = header.findIndex(h => h.includes("name"));
  if (nameColIdx === -1) continue;
  const weightColIdx = header.findIndex(h => h.includes("weight"));
  const names = new Set();
  const weightByName = new Map();
  for (const r of rows.slice(1)) {
    const name = String(r[nameColIdx] ?? "").trim();
    if (!name) continue;
    names.add(name);
    if (weightColIdx !== -1) {
      const w = parseWeightCell(r[weightColIdx]);
      if (w != null) weightByName.set(name, w);
    }
  }
  excelByLayerKey[normalizeLayerKey(sheetName)] = { sheetName, names, weightByName };
}
console.log("Excel sheets parsed:", Object.keys(excelByLayerKey).map(k => `${k} (${excelByLayerKey[k].names.size} names)`).join(", "));

const { rows: layerRows } = await pool.query(
  "SELECT id, name AS folder, display_name AS label FROM nft_layers WHERE collection_id = $1::uuid", [collectionId]
);
const { rows: jobRows } = await pool.query(
  "SELECT id FROM nft_generation_jobs WHERE collection_id = $1::uuid ORDER BY created_at DESC LIMIT 1", [collectionId]
);
const jobId = jobRows[0]?.id;
if (!jobId) { console.error("No job found"); process.exit(1); }

const { rows: countRow } = await pool.query("SELECT COUNT(*) AS c FROM nft_generated_items WHERE job_id=$1::uuid", [jobId]);
const total = Number(countRow[0].c);
console.log(`Total items: ${total}. Sampling ${sampleSize} spread across the range.`);

const step = Math.max(1, Math.floor(total / sampleSize));
const { rows: sampleItems } = await pool.query(
  `SELECT id, edition_number FROM nft_generated_items WHERE job_id=$1::uuid
   AND edition_number % $2 = 0 ORDER BY edition_number LIMIT $3`,
  [jobId, step, sampleSize]
);
console.log(`Sample size actually retrieved: ${sampleItems.length}`);

const { rows: allTraitRows } = await pool.query(
  `SELECT it.item_id, it.trait_type, it.trait_value
   FROM nft_item_traits it JOIN nft_generated_items gi ON gi.id = it.item_id
   WHERE gi.job_id = $1::uuid`,
  [jobId]
);

// Frequency count across ALL items (for weight-vs-frequency sanity, not just sample)
const freqByLayerTrait = {}; // layerLabel -> {name -> count}
for (const tr of allTraitRows) {
  freqByLayerTrait[tr.trait_type] ??= {};
  freqByLayerTrait[tr.trait_type][tr.trait_value] = (freqByLayerTrait[tr.trait_type][tr.trait_value] ?? 0) + 1;
}

const byItem = new Map();
for (const tr of allTraitRows) {
  if (!sampleItems.find(s => s.id === tr.item_id)) continue;
  let m = byItem.get(tr.item_id); if (!m) { m = []; byItem.set(tr.item_id, m); }
  m.push(tr);
}

let mismatches = [];
let checked = 0;
for (const item of sampleItems) {
  const traits = byItem.get(item.id) ?? [];
  for (const t of traits) {
    const layer = layerRows.find(l => l.label === t.trait_type);
    const key = normalizeLayerKey(layer ? layer.folder : t.trait_type);
    const excelSheet = excelByLayerKey[key];
    checked++;
    if (!excelSheet) { mismatches.push({ edition: item.edition_number, layer: t.trait_type, trait: t.trait_value, issue: "no matching Excel sheet found for this layer" }); continue; }
    if (!excelSheet.names.has(t.trait_value)) {
      mismatches.push({ edition: item.edition_number, layer: t.trait_type, trait: t.trait_value, issue: `"${t.trait_value}" not found in Excel sheet "${excelSheet.sheetName}"` });
    }
  }
}

console.log(`\n=== Name match check: ${checked} trait instances checked across ${sampleItems.length} items ===`);
console.log(`Mismatches: ${mismatches.length}`);
if (mismatches.length) {
  console.log(mismatches.slice(0, 30).map(m => `  #${m.edition} [${m.layer}] ${m.issue}`).join("\n"));
}

// Weight-vs-frequency sanity: for each layer with weights, rank correlation (top-N overlap)
console.log("\n=== Weight vs observed-frequency sanity (top 5 by weight vs top 5 by frequency) ===");
for (const key of Object.keys(excelByLayerKey)) {
  const { sheetName, weightByName } = excelByLayerKey[key];
  if (!weightByName.size) continue;
  const layer = layerRows.find(l => normalizeLayerKey(l.folder) === key);
  if (!layer) continue;
  const freq = freqByLayerTrait[layer.label] ?? {};
  const topByWeight = [...weightByName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
  const topByFreq = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
  const overlap = topByWeight.filter(n => topByFreq.includes(n)).length;
  console.log(`  ${sheetName}: top-5-by-weight ${JSON.stringify(topByWeight)} | top-5-by-frequency ${JSON.stringify(topByFreq)} | overlap ${overlap}/5`);
}

fs.writeFileSync(new URL("../scripts/metadata-vs-excel-mismatches.json", import.meta.url), JSON.stringify(mismatches, null, 2));
await pool.end();
