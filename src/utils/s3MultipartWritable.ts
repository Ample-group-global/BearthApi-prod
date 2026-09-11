import { Writable } from "stream";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";

const MIN_PART_SIZE = 5 * 1024 * 1024;

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

  private flushChain: Promise<void> = Promise.resolve();
  private uploadError: Error | null = null;

  private initDone: Promise<void>;

  constructor(s3: S3Client, bucket: string, key: string, contentType = "application/zip") {
    super({ highWaterMark: 12 * 1024 * 1024 });
    this.s3 = s3;
    this.bucket = bucket;
    this.key = key;
    this.contentType = contentType;
    this.initDone = this._init();
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
      this.flushChain = this.flushChain.then(() => this._sendPart(body)).catch(e => {
        this.uploadError = e instanceof Error ? e : new Error(String(e));
      });
    }
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

  async complete(): Promise<void> {
    await this.flushChain;
    if (this.uploadError) throw this.uploadError;

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
