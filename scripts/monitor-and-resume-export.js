// Phase 2 (metadata/CID) version -- images are already 9999/9999. Re-POSTs
// /range with resumeFrom = rangeEnd for any range whose own metadata isn't
// fully caught up yet; the server skips re-compositing (nothing left in
// [rangeStart, rangeEnd) with editionNum > resumeFrom) and just continues
// straight into Phase 2 for that slice.

const BASE = 'https://bearthadmin-v1.vercel.app';
const EMAIL = 'amplecapitalholding@gmail.com';
const PASSWORD = 'amplecapitalholding@123';
const JOB_ID = '8bf5ec29-ea12-43b5-954f-9f55b7e16b84';
const BUCKET = 'bearth-nft-it';
const COLLECTION_NAME = 'Bearth';
const WIDTH = 2000, HEIGHT = 2000;
const SUPPLY = 9999;
const RANGES = [[0,1250],[1250,2500],[2500,3750],[3750,5000],[5000,6250],[6250,7500],[7500,8750],[8750,9999]];
const POLL_MS = 15000;
const MAX_MINUTES = 45;

let cookie = null;

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = r.headers.get('set-cookie');
  cookie = setCookie ? setCookie.split(';')[0] : null;
  if (!cookie) throw new Error('login failed, no cookie');
}

async function listMetadata() {
  const r = await fetch(`${BASE}/api/filebase/objects?bucket=${BUCKET}`, { headers: { Cookie: cookie } });
  const data = await r.json();
  const editions = new Set();
  for (const o of data.objects ?? []) {
    const m = String(o.key ?? '').match(/^metadata\/(\d+)\.json$/);
    if (m) editions.add(Number(m[1]));
  }
  return editions;
}

async function triggerRange(rangeStart, rangeEnd) {
  const body = {
    jobId: JOB_ID, bucket: BUCKET, format: 'png', width: WIDTH, height: HEIGHT,
    collectionName: COLLECTION_NAME, rangeStart, rangeEnd, resumeFrom: rangeEnd,
  };
  const r = await fetch(`${BASE}/api/nft-gen/export/range`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main() {
  await login();
  const deadline = Date.now() + MAX_MINUTES * 60 * 1000;
  let lastCount = -1;
  let lastMoveAt = Date.now();

  while (Date.now() < deadline) {
    let editions;
    try {
      editions = await listMetadata();
    } catch (e) {
      console.log(`[monitor2] listMetadata failed: ${e.message}, retrying`);
      await new Promise(r => setTimeout(r, POLL_MS));
      continue;
    }
    const count = editions.size;
    console.log(`[monitor2] ${new Date().toISOString()} metadata: ${count}/${SUPPLY}`);

    if (count >= SUPPLY) {
      console.log('[monitor2] DONE - all metadata present.');
      return;
    }

    if (count !== lastCount) { lastCount = count; lastMoveAt = Date.now(); }
    const stalledForS = (Date.now() - lastMoveAt) / 1000;

    if (stalledForS > 25) {
      for (const [s, e] of RANGES) {
        let missingInRange = 0;
        for (let n = s + 1; n <= e; n++) if (!editions.has(n)) missingInRange++;
        if (missingInRange > 0) {
          try {
            const { status, body } = await triggerRange(s, e);
            console.log(`[monitor2]   trigger ${s}-${e} (${missingInRange} missing): ${status} ${JSON.stringify(body).slice(0,120)}`);
          } catch (err) {
            console.log(`[monitor2]   trigger ${s}-${e} FAILED: ${err.message}`);
          }
        }
      }
      lastMoveAt = Date.now();
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }
  console.log('[monitor2] deadline reached, exiting.');
}

main().catch(e => { console.error(e); process.exit(1); });
