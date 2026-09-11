import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

export async function pollCid(s3: S3Client, bucket: string, key: string, maxMs = 6000): Promise<string> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 80));
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const cid = head.Metadata?.cid ?? "";
      if (cid) return cid;
    } catch { }
  }
  return "";
}
