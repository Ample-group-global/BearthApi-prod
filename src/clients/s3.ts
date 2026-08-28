import https from "https";
import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";

let _client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (_client) return _client;
  const accessKeyId = process.env.FILEBASE_ACCESS_KEY;
  const secretAccessKey = process.env.FILEBASE_SECRET_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("FILEBASE_ACCESS_KEY and FILEBASE_SECRET_KEY must be set");
  _client = new S3Client({
    endpoint: "https://s3.filebase.io",
    region: "auto",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({
      // Parallel export runs up to 8 slices at CONCURRENCY=150 each (see
      // export-workers.ts) -- up to ~1200 concurrent S3 calls sharing this
      // one client. At maxSockets=200, requests queued for a free socket
      // routinely sat past the 10s connectionTimeout and got killed with
      // "the request socket did not establish a connection ... within
      // 10000 ms" -- a local pool-capacity failure, not a Filebase-side
      // one, confirmed live: multiple slices died this way simultaneously
      // while the real bucket still had zero objects uploaded.
      httpsAgent: new https.Agent({ maxSockets: 1500 }),
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
    }),
  });
  return _client;
}
