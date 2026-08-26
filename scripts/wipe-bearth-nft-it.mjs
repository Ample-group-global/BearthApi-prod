// Deliberately narrow deletion script. ONLY ever operates on the literal
// string "bearth-nft-it" (hardcoded, not a CLI arg) — this is the one bucket
// this whole test project is allowed to write/delete in. amgbearth and
// bearthv1 are never referenced anywhere in this file.
// Run from BearthApi-V1/: node scripts/wipe-bearth-nft-it.mjs --confirm
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import fs from "fs";

const BUCKET = "bearth-nft-it"; // hardcoded, not parameterized — see comment above

if (!process.argv.includes("--confirm")) {
  console.error("Refusing to run without --confirm flag.");
  process.exit(1);
}

const envPath = new URL("../.env.local", import.meta.url);
const envText = fs.readFileSync(envPath, "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const client = new S3Client({
  endpoint: "https://s3.filebase.io",
  region: "auto",
  credentials: { accessKeyId: env.FILEBASE_ACCESS_KEY, secretAccessKey: env.FILEBASE_SECRET_KEY },
  forcePathStyle: true,
});

let continuationToken;
let totalDeleted = 0;
do {
  const listResp = await client.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    ContinuationToken: continuationToken,
    MaxKeys: 1000,
  }));
  const objs = listResp.Contents ?? [];
  if (objs.length) {
    const delResp = await client.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: objs.map(o => ({ Key: o.Key })), Quiet: true },
    }));
    totalDeleted += objs.length;
    if (delResp.Errors?.length) console.error("Delete errors:", delResp.Errors);
  }
  continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
} while (continuationToken);

console.log(`Deleted ${totalDeleted} objects from ${BUCKET}.`);

// Verify empty
const verify = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 10 }));
console.log(`Post-wipe object count check: ${(verify.Contents ?? []).length} objects remaining (should be 0).`);
