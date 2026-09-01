// Adds a self-documenting "Rules Format" sheet to NFTTRAITS-FIXED.xlsx --
// a flat, unambiguous template (explicit layer names, one row per single
// if-trait/then-trait relationship) for communicating future conflict-rule
// changes. Existing "Corrected Rules"/"Headwear Rules" sheets are untouched.

const XLSX = require('xlsx');
const path = require('path');

const FILE = path.join(
  'D:', 'AMG-Projects', 'AMGEcosystem', 'amgecosystem', 'amgecosystem-v1.0.0',
  'Judy', 'NFT-Files', 'FinalGenerationAndTesting', 'New-Judy', 'NFTTRAITS-FIXED.xlsx',
);

const wb = XLSX.readFile(FILE);

const rows = [
  ['If Layer', 'If Trait', 'Type', 'Then Layer', 'Then Trait'],
  ['(exact layer name, e.g. "01_BEAR HEAD")', '(exact trait stem, e.g. "1-1")', 'Block or Force', '(exact layer name, e.g. "06_HEADWEAR")', '(exact trait stem, e.g. "6-3")'],
  ['01_BEAR HEAD', '1-1', 'Block', '06_HEADWEAR', '6-3'],
  ['01_BEAR HEAD', '1-1', 'Block', '06_HEADWEAR', '6-4'],
  ['01_BEAR HEAD', '1-1', 'Force', '02_BEAR BODY', '2-1'],
];

const ws = XLSX.utils.aoa_to_sheet(rows);
ws['!cols'] = [{ wch: 32 }, { wch: 22 }, { wch: 12 }, { wch: 32 }, { wch: 22 }];

// Replace if it already exists (re-runnable), else append.
const sheetName = 'Rules Format';
if (wb.SheetNames.includes(sheetName)) {
  wb.Sheets[sheetName] = ws;
} else {
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

XLSX.writeFile(wb, FILE);
console.log(`Added/updated "${sheetName}" sheet in ${FILE}`);
console.log('Rules: one row = one if-trait -> then-trait relationship.');
console.log('Block = these traits cannot appear together. Force = if the "If" trait is picked, the "Then" trait is required.');
console.log('IMPORTANT: use the exact full layer folder name (e.g. "01_BEAR HEAD", not just "Bear Head" or "1"), since trait number prefixes like "1-" are reused across different layers (BEAR HEAD and BACK both use "1-").');
