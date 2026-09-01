// Fixes NFTTRAITS.xlsx's Trait ID column where Excel silently auto-converted
// entries like "1-1" into a calendar date (month=layer prefix, day=trait
// index) and the cell was later reformatted to show the raw date serial
// instead of the date. Confirmed by decoding real serials: 46023->2026-01-01
// (BEAR HEAD "1-1"), 46054->2026-02-01 (BEAR BODY "2-1"), 46082->2026-03-01
// (EMOTION "3-1"), 46113->2026-04-01 (CLOTHES "4-1"), 46143->2026-05-01
// (HOLDING "5-1"), 46174->2026-06-01 (HEADWEAR "6-1") -- exact month match
// to each layer's REAL file-stem prefix (verified against actual files on
// disk, not assumed from folder sort order -- HOLDING is folder 07 but its
// real files use prefix "5-", HEADWEAR is folder 06 and uses "6-").
//
// Usage: node scripts/fix-trait-id-dates.js
// Reads:  <New-Judy>/NFTTRAITS.xlsx
// Writes: <New-Judy>/NFTTRAITS-FIXED.xlsx  (original left untouched)

const XLSX = require('xlsx');
const path = require('path');

const SRC = path.join(
  'D:', 'AMG-Projects', 'AMGEcosystem', 'amgecosystem', 'amgecosystem-v1.0.0',
  'Judy', 'NFT-Files', 'FinalGenerationAndTesting', 'New-Judy', 'NFTTRAITS.xlsx',
);
const DEST = path.join(
  'D:', 'AMG-Projects', 'AMGEcosystem', 'amgecosystem', 'amgecosystem-v1.0.0',
  'Judy', 'NFT-Files', 'FinalGenerationAndTesting', 'New-Judy', 'NFTTRAITS-FIXED.xlsx',
);

// sheet name (normalized) -> real file-stem prefix, verified against the
// actual layer folders on disk (see NFTLayer-FinalGeneration/<folder>/*.png)
const SHEET_PREFIX = {
  'background': '0',
  'bear head': '1',
  'bear body': '2',
  'emotion': '3',
  'clothes': '4',
  'back': '1',      // no date-corrupted IDs in this sheet, kept for completeness
  'headwear': '6',
  'holding': '5',
};

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
function serialToMonthDay(serial) {
  const d = new Date(EXCEL_EPOCH_MS + serial * 86400000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

const wb = XLSX.readFile(SRC, { cellDates: false });
let totalFixed = 0;
const report = [];

for (const sheetName of wb.SheetNames) {
  const key = sheetName.trim().toLowerCase();
  const expectedPrefix = SHEET_PREFIX[key];
  if (!expectedPrefix) continue; // e.g. "Corrected Rules", "Headwear Rules" -- not a trait sheet

  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  if (!rows.length) continue;
  const header = rows[0].map(h => String(h || '').trim().toLowerCase());
  const idColIdx = header.findIndex(h => h.includes('id'));
  if (idColIdx === -1) continue;

  let sheetFixed = 0;
  for (let r = 1; r < rows.length; r++) {
    const cellAddr = XLSX.utils.encode_cell({ r, c: idColIdx });
    const raw = rows[r][idColIdx];
    if (typeof raw !== 'number') continue; // already text (real stem or blank) -- leave alone

    const { year, month, day } = serialToMonthDay(raw);
    if (year !== 2026 || month !== Number(expectedPrefix)) {
      report.push(`  ! ${sheetName} ${cellAddr}: numeric ${raw} did NOT decode to expected month ${expectedPrefix} (got ${year}-${month}-${day}) -- left unchanged, needs manual review`);
      continue;
    }
    const fixedStem = `${expectedPrefix}-${day}`;
    ws[cellAddr] = { t: 's', v: fixedStem };
    sheetFixed++;
  }
  if (sheetFixed) {
    report.push(`  ${sheetName}: fixed ${sheetFixed} Trait ID cell(s)`);
    totalFixed += sheetFixed;
  }
}

XLSX.writeFile(wb, DEST);
console.log(`Fixed ${totalFixed} Trait ID cells across all sheets.`);
console.log(report.join('\n'));
console.log(`\nWritten to: ${DEST}`);
console.log(`Original untouched: ${SRC}`);
