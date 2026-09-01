// Fixes "04_EMOTION" -> "03_EMOTION" in the "Rules Format" sheet
// (real folder is 03_EMOTION -- 04 is CLOTHES).

const XLSX = require('xlsx');
const path = require('path');

const FILE = path.join(
  'D:', 'AMG-Projects', 'AMGEcosystem', 'amgecosystem', 'amgecosystem-v1.0.0',
  'Judy', 'NFT-Files', 'FinalGenerationAndTesting', 'New-Judy', 'NFTTRAITS-FIXED.xlsx',
);

const wb = XLSX.readFile(FILE);
const ws = wb.Sheets['Rules Format'];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

let fixed = 0;
for (let r = 0; r < rows.length; r++) {
  for (let c = 0; c < rows[r].length; c++) {
    if (rows[r][c] === '04_EMOTION') {
      const addr = XLSX.utils.encode_cell({ r, c });
      ws[addr] = { t: 's', v: '03_EMOTION' };
      fixed++;
    }
  }
}

XLSX.writeFile(wb, FILE);
console.log(`Fixed ${fixed} cells: "04_EMOTION" -> "03_EMOTION"`);
