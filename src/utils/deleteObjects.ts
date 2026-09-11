import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";

export async function deleteObjectsChunked(s3: S3Client, bucket: string, keys: string[]): Promise<number> {
  const CHUNK = 1000;
  let deleted = 0;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: chunk.map(k => ({ Key: k })), Quiet: true },
    }));
    deleted += chunk.length - (result.Errors?.length ?? 0);
  }
  return deleted;
}
