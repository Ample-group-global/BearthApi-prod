// Transforms judy-conflict-rules-backup.json (shape: {ifLayer, ifTrait, type,
// then: [{layer, stem}, ...]}) into the DB's actual storage shape (shape:
// {id, type, ifLayer, ifTrait, thenLayer, thenTraits: [...]}, grouped by
// thenLayer, one row per (rule, thenLayer) pair -- confirmed against a real
// collection's stored conflict_rules) and PUTs it to the given collection
// via the same endpoint the browser UI uses.
//
// Usage: node scripts/apply-conflict-rules.js <collectionId>

const fs = require('fs');
const path = require('path');

const BASE = 'https://bearthadmin-v1.vercel.app';
const EMAIL = 'amplecapitalholding@gmail.com';
const PASSWORD = 'amplecapitalholding@123';

const collectionId = process.argv[2];
if (!collectionId) {
  console.error('Usage: node scripts/apply-conflict-rules.js <collectionId>');
  process.exit(1);
}

const BACKUP_PATH = path.join(__dirname, '..', 'judy-conflict-rules-backup.json');
const raw = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));

function randomId() {
  return Math.random().toString(36).slice(2, 12);
}

const transformed = [];
for (const rule of raw) {
  const byLayer = new Map();
  for (const t of rule.then) {
    if (!byLayer.has(t.layer)) byLayer.set(t.layer, []);
    byLayer.get(t.layer).push(t.stem);
  }
  for (const [thenLayer, thenTraits] of byLayer) {
    transformed.push({
      id: randomId(),
      type: rule.type,
      ifLayer: rule.ifLayer,
      ifTrait: rule.ifTrait,
      thenLayer,
      thenTraits,
    });
  }
}

console.log(`Transformed ${raw.length} raw rules -> ${transformed.length} DB-shaped rule rows.`);

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = loginRes.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : null;
  if (!cookie) throw new Error('login failed, no cookie');

  const putRes = await fetch(`${BASE}/api/nft-gen/collections/${collectionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ conflictRules: transformed }),
  });
  const body = await putRes.json().catch(() => ({}));
  console.log('PUT status:', putRes.status);
  console.log('Response:', JSON.stringify(body).slice(0, 300));

  // Verify by reading it back
  const getRes = await fetch(`${BASE}/api/nft-gen/collections/${collectionId}`, { headers: { Cookie: cookie } });
  const getData = await getRes.json().catch(() => ({}));
  const stored = getData?.collection?.conflictRules ?? getData?.conflictRules ?? [];
  console.log(`Verified: collection now has ${stored.length} conflict_rules rows stored.`);
}

main().catch(e => { console.error(e); process.exit(1); });
