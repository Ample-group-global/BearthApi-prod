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
      httpsAgent: new https.Agent({ maxSockets: 200 }),
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
    }),
  });
  return _client;
}
