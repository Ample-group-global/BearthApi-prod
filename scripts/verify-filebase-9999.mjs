// Verification-only script (read-only ListObjectsV2) — never used to trigger
// generation/export. Confirms bearth-nft-it object count after the 9999-item
// export, and that this script itself only ever touches bearth-nft-it.
// Run from BearthApi-V1/ so @aws-sdk/client-s3 resolves: node scripts/verify-filebase-9999.mjs
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import fs from "fs";

const ALLOWED_BUCKET = "bearth-nft-it";
const FORBIDDEN = ["amgbearth", "bearthv1"];

const envPath = new URL("../.env.local", import.meta.url);
const envText = fs.readFileSync(envPath, "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const accessKeyId = env.FILEBASE_ACCESS_KEY;
const secretAccessKey = env.FILEBASE_SECRET_KEY;
if (!accessKeyId || !secretAccessKey) throw new Error("Missing Filebase creds in .env.local");

const bucket = process.argv[2] || ALLOWED_BUCKET;
if (bucket !== ALLOWED_BUCKET) {
  console.error(`REFUSING: this script only ever lists "${ALLOWED_BUCKET}". Got "${bucket}".`);
  process.exit(1);
}
if (FORBIDDEN.includes(bucket)) {
  console.error(`REFUSING: "${bucket}" is a forbidden bucket, never touch it.`);
  process.exit(1);
}

const client = new S3Client({
  endpoint: "https://s3.filebase.io",
  region: "auto",
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
});

let continuationToken;
let total = 0, images = 0, metas = 0, other = 0;
const editionSet = new Set();
do {
  const resp = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    ContinuationToken: continuationToken,
    MaxKeys: 1000,
  }));
  for (const obj of resp.Contents ?? []) {
    total++;
    const k = obj.Key;
    if (k.startsWith("images/")) { images++; editionSet.add("img:" + k.slice(7).replace(/\.\w+$/, "")); }
    else if (k.startsWith("metadata/")) { metas++; editionSet.add("meta:" + k.slice(9).replace(/\.json$/, "")); }
    else other++;
  }
  continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
} while (continuationToken);

console.log(JSON.stringify({ bucket, total, images, metas, other }, null, 2));
