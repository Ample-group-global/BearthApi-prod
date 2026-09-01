// Deletes ALL objects from a Filebase S3-compatible bucket. Uses the AWS SDK
// directly (DeleteObjectsCommand in small batches) instead of the app's own
// /api/filebase/objects/batch route -- that route intermittently 500s on
// mixed-key batches for reasons not yet root-caused, this bypasses it.
//
// Usage: node scripts/clear-filebase-bucket.js <bucketName>
// No default bucket -- must be explicit, this is destructive.

const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const BUCKET = process.argv[2];
if (!BUCKET) {
  console.error('Usage: node scripts/clear-filebase-bucket.js <bucketName>');
  process.exit(1);
}

const s3 = new S3Client({
  endpoint: 'https://s3.filebase.com',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY,
    secretAccessKey: process.env.FILEBASE_SECRET_KEY,
  },
  forcePathStyle: true,
});

async function listAllKeys(bucket) {
  const keys = [];
  let continuationToken;
  do {
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: continuationToken }));
    for (const obj of resp.Contents ?? []) if (obj.Key) keys.push(obj.Key);
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

async function main() {
  console.log(`Listing objects in "${BUCKET}"...`);
  const keys = await listAllKeys(BUCKET);
  console.log(`Found ${keys.length} objects.`);
  if (!keys.length) { console.log('Nothing to delete.'); return; }

  const CHUNK = 1000; // S3 DeleteObjects max per call
  let deleted = 0;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const resp = await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: chunk.map(Key => ({ Key })), Quiet: true },
    }));
    deleted += chunk.length - (resp.Errors?.length ?? 0);
    if (resp.Errors?.length) {
      console.error(`  ${resp.Errors.length} errors in this chunk:`, resp.Errors.slice(0, 5));
    }
    console.log(`  Deleted ${deleted}/${keys.length}`);
  }
  console.log(`Done. Deleted ${deleted}/${keys.length} objects from "${BUCKET}".`);
}

main().catch(err => { console.error(err); process.exit(1); });
