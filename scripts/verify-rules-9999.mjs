// Read-only verification script — checks all generated items' actual trait
// combinations against the collection's configured conflict_rules (force /
// exclude), reporting violation count. Never mutates data.
// Run from BearthApi-V1/: node scripts/verify-rules-9999.mjs <collectionId>
import pg from "pg";
import fs from "fs";

const envPath = new URL("../.env.local", import.meta.url);
const envText = fs.readFileSync(envPath, "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: false });

const collectionId = process.argv[2];
if (!collectionId) { console.error("Usage: node verify-rules-9999.mjs <collectionId>"); process.exit(1); }

function stemFromPath(p) {
  if (!p) return null;
  const base = p.split("/").pop() || p;
  return base.replace(/\.[a-zA-Z0-9]+$/, "");
}

const { rows: collRows } = await pool.query(
  "SELECT id, name, conflict_rules FROM nft_collections WHERE id = $1::uuid", [collectionId]
);
if (!collRows.length) { console.error("Collection not found"); process.exit(1); }
const rules = collRows[0].conflict_rules ?? [];
console.log(`Collection: ${collRows[0].name} — ${rules.length} conflict rule groups`);

const { rows: jobRows } = await pool.query(
  "SELECT id, status FROM nft_generation_jobs WHERE collection_id = $1::uuid ORDER BY created_at DESC LIMIT 1",
  [collectionId]
);
if (!jobRows.length) { console.error("No generation job found"); process.exit(1); }
const jobId = jobRows[0].id;
console.log(`Job: ${jobId} — status ${jobRows[0].status}`);

const { rows: layerRows } = await pool.query(
  "SELECT id, name AS folder, display_name AS label FROM nft_layers WHERE collection_id = $1::uuid", [collectionId]
);
const layerById = new Map(layerRows.map(l => [l.id, l]));

const { rows: traitRows } = await pool.query(
  "SELECT id, layer_id, file_path FROM nft_traits WHERE layer_id = ANY($1::uuid[])",
  [layerRows.map(l => l.id)]
);
const traitStemById = new Map(traitRows.map(t => [t.id, stemFromPath(t.file_path)]));

console.log("Loading nft_item_traits for all generated items (this may take a bit at 9999 scale)...");
const { rows: itemRows } = await pool.query(
  "SELECT id, edition_number FROM nft_generated_items WHERE job_id = $1::uuid ORDER BY edition_number", [jobId]
);
console.log(`Items: ${itemRows.length}`);

const { rows: traitLinkRows } = await pool.query(
  `SELECT it.item_id, it.trait_id, it.trait_type, it.trait_value
   FROM nft_item_traits it
   JOIN nft_generated_items gi ON gi.id = it.item_id
   WHERE gi.job_id = $1::uuid`,
  [jobId]
);
console.log(`Trait rows: ${traitLinkRows.length}`);

// Build per-item combo: { folder: stem }
const labelToFolder = new Map(layerRows.map(l => [l.label, l.folder]));
const comboByItem = new Map(); // item_id -> { folder: stem }
let unresolvedTraitId = 0;
for (const tr of traitLinkRows) {
  let combo = comboByItem.get(tr.item_id);
  if (!combo) { combo = {}; comboByItem.set(tr.item_id, combo); }
  const folder = labelToFolder.get(tr.trait_type) ?? tr.trait_type;
  let stem = tr.trait_id ? traitStemById.get(tr.trait_id) : undefined;
  if (!stem) { unresolvedTraitId++; stem = tr.trait_value; } // fallback: compare by name if stem unresolved
  combo[folder] = stem;
}
if (unresolvedTraitId) console.log(`WARNING: ${unresolvedTraitId} trait rows had no resolvable trait_id->stem (fell back to trait_value name)`);

let violations = [];
for (const item of itemRows) {
  const combo = comboByItem.get(item.id);
  if (!combo) continue;
  for (const rule of rules) {
    if (combo[rule.ifLayer] !== rule.ifTrait) continue;
    const thenVal = combo[rule.thenLayer];
    const type = rule.type ?? "exclude";
    if (type === "exclude") {
      if (thenVal !== undefined && rule.thenTraits.includes(thenVal)) {
        violations.push({ edition: item.edition_number, rule: `exclude ${rule.ifLayer}:${rule.ifTrait} -> ${rule.thenLayer} must NOT be one of [${rule.thenTraits.join(",")}], got ${thenVal}` });
      }
    } else if (type === "force") {
      if (thenVal !== undefined && !rule.thenTraits.includes(thenVal)) {
        violations.push({ edition: item.edition_number, rule: `force ${rule.ifLayer}:${rule.ifTrait} -> ${rule.thenLayer} must be one of [${rule.thenTraits.join(",")}], got ${thenVal}` });
      }
    }
  }
}

console.log(`\n=== RESULT: ${violations.length} violations across ${itemRows.length} items, ${rules.length} rule groups ===`);
if (violations.length) {
  console.log("First 30 violations:");
  for (const v of violations.slice(0, 30)) console.log(`  #${v.edition}: ${v.rule}`);
  fs.writeFileSync(new URL("../scripts/violations-9999.json", import.meta.url), JSON.stringify(violations, null, 2));
  console.log(`Full list written to scripts/violations-9999.json (${violations.length} entries)`);
}

await pool.end();
