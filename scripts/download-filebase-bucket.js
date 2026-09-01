// Downloads all objects (images + metadata) from a Filebase S3-compatible bucket
// to a local folder, preserving the bucket's key structure.
//
// Usage: node scripts/download-filebase-bucket.js [bucketName] [destPath] [concurrency]
// Defaults: bucket = bearth-nft-it, dest = D:\Bearth-Downloads\<bucket>, concurrency = 40

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const BUCKET = process.argv[2] || 'bearth-nft-it';
const DEST_ROOT = process.argv[3] || path.join('D:\\Bearth-Downloads', BUCKET);
const CONCURRENCY = Number(process.argv[4]) || 40;

const s3 = new S3Client({
  endpoint: 'https://s3.filebase.com',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.FILEBASE_ACCESS_KEY,
    secretAccessKey: process.env.FILEBASE_SECRET_KEY,
  },
  forcePathStyle: true,
});

function streamToFile(body, filePath) {
  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(filePath);
    body.pipe(writeStream);
    body.on('error', reject);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
}

async function listAllObjects() {
  const objects = [];
  let continuationToken;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      ContinuationToken: continuationToken,
    }));
    if (resp.Contents) objects.push(...resp.Contents);
    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

async function main() {
  console.log(`Listing objects in bucket "${BUCKET}"...`);
  const objects = await listAllObjects();
  console.log(`Found ${objects.length} objects. Downloading to ${DEST_ROOT} ...`);

  fs.mkdirSync(DEST_ROOT, { recursive: true });

  let done = 0;
  let failed = 0;
  const failedKeys = [];
  const total = objects.length;

  async function downloadOne(obj) {
    const key = obj.Key;
    const destPath = path.join(DEST_ROOT, key.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    if (fs.existsSync(destPath) && fs.statSync(destPath).size === obj.Size) {
      done++;
      return;
    }

    try {
      const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      await streamToFile(resp.Body, destPath);
      done++;
    } catch (err) {
      failed++;
      failedKeys.push(key);
      console.error(`FAILED: ${key} -> ${err.message}`);
    }

    if ((done + failed) % 500 === 0) {
      console.log(`Progress: ${done + failed}/${total} (done: ${done}, failed: ${failed})`);
    }
  }

  let cursor = 0;
  async function worker() {
    while (cursor < total) {
      const obj = objects[cursor++];
      await downloadOne(obj);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nDone. Downloaded/verified: ${done}, Failed: ${failed}`);
  if (failedKeys.length) {
    const failLog = path.join(DEST_ROOT, '_failed_keys.txt');
    fs.writeFileSync(failLog, failedKeys.join('\n'));
    console.log(`Failed keys written to ${failLog} — re-run this script to retry them.`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
