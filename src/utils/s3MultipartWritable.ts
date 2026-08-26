import { Writable } from "stream";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";

// Minimum part size required by S3 spec (5 MB), except for the final part.
const MIN_PART_SIZE = 5 * 1024 * 1024;

// Streams data into an S3 multipart upload without holding the full payload in
// memory. Buffers until MIN_PART_SIZE, then flushes a part asynchronously.
// Caller must await complete() after the source stream ends.
export class S3MultipartWritable extends Writable {
  private s3: S3Client;
  private bucket: string;
  private key: string;
  private contentType: string;

  private uploadId: string | null = null;
  private parts: { PartNumber: number; ETag: string }[] = [];
  private buf: Buffer[] = [];
  private bufLen = 0;
  private partNum = 1;

  // Serialises async S3 part uploads so parts arrive in order.
  private flushChain: Promise<void> = Promise.resolve();
  private uploadError: Error | null = null;

  // Resolves once CreateMultipartUpload succeeds.
  private initDone: Promise<void>;

  constructor(s3: S3Client, bucket: string, key: string, contentType = "application/zip") {
    // highWaterMark: allow up to 12 MB in the Node write buffer before
    // applying backpressure — large enough not to stall ZipStream writers
    // while still keeping resident memory bounded.
    super({ highWaterMark: 12 * 1024 * 1024 });
    this.s3 = s3;
    this.bucket = bucket;
    this.key = key;
    this.contentType = contentType;
    this.initDone = this._init();
    // Prevent Node.js unhandledRejection crash: _init() rejection is handled
    // in _sendPart() via await, but Node.js fires the event if no .catch()
    // is attached before the microtask queue drains.
    this.initDone.catch(() => {});
  }

  private async _init() {
    const res = await this.s3.send(new CreateMultipartUploadCommand({
      Bucket: this.bucket,
      Key: this.key,
      ContentType: this.contentType,
    }));
    this.uploadId = res.UploadId!;
  }

  _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
    this.buf.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.bufLen += chunk.length;

    if (this.bufLen >= MIN_PART_SIZE) {
      const body = Buffer.concat(this.buf);
      this.buf = [];
      this.bufLen = 0;
      // Chain onto previous flush to preserve part ordering.
      this.flushChain = this.flushChain.then(() => this._sendPart(body)).catch(e => {
        this.uploadError = e instanceof Error ? e : new Error(String(e));
      });
    }
    // Signal the chunk is consumed immediately — lets ZipStream continue
    // without waiting for S3. complete() will drain the queue before finishing.
    cb();
  }

  private async _sendPart(body: Buffer) {
    await this.initDone;
    const pn = this.partNum++;
    const res = await this.s3.send(new UploadPartCommand({
      Bucket: this.bucket,
      Key: this.key,
      UploadId: this.uploadId!,
      PartNumber: pn,
      Body: body,
      ContentLength: body.length,
    }));
    this.parts.push({ PartNumber: pn, ETag: res.ETag! });
  }

  // Must be called after the source stream (ZipStream) finishes writing.
  // Flushes any remaining buffer and completes the multipart upload.
  async complete(): Promise<void> {
    // Wait for all queued part uploads to finish.
    await this.flushChain;
    if (this.uploadError) throw this.uploadError;

    // Last part (may be < 5 MB — that is allowed for the final part).
    if (this.bufLen > 0) {
      const body = Buffer.concat(this.buf);
      this.buf = [];
      this.bufLen = 0;
      await this._sendPart(body);
    }

    if (this.uploadError) throw this.uploadError;

    await this.s3.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket,
      Key: this.key,
      UploadId: this.uploadId!,
      MultipartUpload: {
        Parts: this.parts.sort((a, b) => a.PartNumber - b.PartNumber),
      },
    }));
  }

  // Call on error paths to release the incomplete upload.
  async abort(): Promise<void> {
    if (this.uploadId) {
      await this.s3.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: this.uploadId!,
      })).catch(() => {});
    }
  }
}
