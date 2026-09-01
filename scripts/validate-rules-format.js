// Validates the "Rules Format" sheet against real ground truth:
// - every cell must be genuine text type (catches Excel auto-date/number
//   corruption, the same class of bug found earlier in NFTTRAITS.xlsx)
// - every If Layer / Then Layer must be one of the 8 real layer folder names
// - every If Trait / Then Trait must be a real file stem that actually
//   exists inside that specific layer's folder (not just "looks like" one --
//   this also catches the BACK-vs-BEAR-HEAD "1-" prefix collision risk)
// - Type must be exactly "Block" or "Force"

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const XLSX_PATH = path.join(
  'D:', 'AMG-Projects', 'AMGEcosystem', 'amgecosystem', 'amgecosystem-v1.0.0',
  'Judy', 'NFT-Files', 'FinalGenerationAndTesting', 'New-Judy', 'NFTTRAITS-FIXED.xlsx',
);
const LAYER_ROOT = path.join(
  'D:', 'AMG-Projects', 'AMGEcosystem', 'amgecosystem', 'amgecosystem-v1.0.0',
  'Judy', 'NFT-Files', 'FinalGenerationAndTesting', 'New-Judy', 'NFTLayer-FinalGeneration',
);

// Ground truth: real layer folder -> set of real trait stems (from filenames)
const layerStems = {};
for (const folder of fs.readdirSync(LAYER_ROOT)) {
  const full = path.join(LAYER_ROOT, folder);
  if (!fs.statSync(full).isDirectory()) continue;
  const stems = new Set(
    fs.readdirSync(full)
      .filter(f => /\.png$/i.test(f))
      .map(f => f.replace(/\.png$/i, '')),
  );
  layerStems[folder] = stems;
}
const realLayerNames = new Set(Object.keys(layerStems));

const wb = XLSX.readFile(XLSX_PATH, { cellDates: false });
const ws = wb.Sheets['Rules Format'];
if (!ws) { console.error('No "Rules Format" sheet found.'); process.exit(1); }

const rowsRaw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
const header = rowsRaw[0].map(h => String(h).trim());
const idx = {
  ifLayer: header.indexOf('If Layer'),
  ifTrait: header.indexOf('If Trait'),
  type: header.indexOf('Type'),
  thenLayer: header.indexOf('Then Layer'),
  thenTrait: header.indexOf('Then Trait'),
};
for (const [k, v] of Object.entries(idx)) {
  if (v === -1) { console.error(`Missing expected column: ${k}`); process.exit(1); }
}

let dataStart = 1;
// Skip the two instructional/example placeholder rows if still present
// (rows whose If Trait value contains parentheses, e.g. "(exact trait stem...)")
while (dataStart < rowsRaw.length && /[()]/.test(String(rowsRaw[dataStart][idx.ifTrait] ?? ''))) dataStart++;

const errors = [];
let checked = 0;
for (let r = dataStart; r < rowsRaw.length; r++) {
  const row = rowsRaw[r];
  if (row.every(c => c === '' || c == null)) continue; // blank row
  checked++;

  for (const col of ['ifLayer', 'ifTrait', 'type', 'thenLayer', 'thenTrait']) {
    const val = row[idx[col]];
    if (typeof val === 'number') {
      errors.push(`Row ${r + 1}: ${col} = ${val} is a NUMBER, not text -- likely Excel auto-converted it (date/other). Needs fixing.`);
    }
  }

  const ifLayer = String(row[idx.ifLayer] ?? '').trim();
  const ifTrait = String(row[idx.ifTrait] ?? '').trim();
  const type = String(row[idx.type] ?? '').trim();
  const thenLayer = String(row[idx.thenLayer] ?? '').trim();
  const thenTrait = String(row[idx.thenTrait] ?? '').trim();

  if (!realLayerNames.has(ifLayer)) errors.push(`Row ${r + 1}: If Layer "${ifLayer}" is not a real layer folder name.`);
  if (!realLayerNames.has(thenLayer)) errors.push(`Row ${r + 1}: Then Layer "${thenLayer}" is not a real layer folder name.`);
  if (!['Block', 'Force'].includes(type)) errors.push(`Row ${r + 1}: Type "${type}" must be exactly "Block" or "Force".`);
  if (realLayerNames.has(ifLayer) && !layerStems[ifLayer].has(ifTrait)) {
    errors.push(`Row ${r + 1}: If Trait "${ifTrait}" does not exist as a real file in "${ifLayer}".`);
  }
  if (realLayerNames.has(thenLayer) && !layerStems[thenLayer].has(thenTrait)) {
    errors.push(`Row ${r + 1}: Then Trait "${thenTrait}" does not exist as a real file in "${thenLayer}".`);
  }
}

console.log(`Checked ${checked} rule rows (data starts at row ${dataStart + 1}).`);
if (errors.length) {
  console.log(`\n${errors.length} PROBLEM(S) FOUND:\n`);
  console.log(errors.slice(0, 100).join('\n'));
  if (errors.length > 100) console.log(`... and ${errors.length - 100} more.`);
} else {
  console.log('\nAll rows valid: every cell is genuine text, every layer name is real, every trait stem exists in its stated layer, every Type is Block/Force.');
}
