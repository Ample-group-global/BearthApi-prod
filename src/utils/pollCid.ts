import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Filebase assigns an object's IPFS CID asynchronously after upload — it
// isn't guaranteed to be readable via HeadObject immediately. Poll briefly
// instead of checking once, or the CID silently comes back null under any
// real load.
export async function pollCid(s3: S3Client, bucket: string, key: string, maxMs = 6000): Promise<string> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 80));
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const cid = head.Metadata?.cid ?? "";
      if (cid) return cid;
    } catch { /* not ready yet */ }
  }
  return "";
}
