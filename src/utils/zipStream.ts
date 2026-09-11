import type { Writable } from "stream";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeUInt64LE(buf: Buffer, value: bigint, offset: number) {
  const lo = Number(value & 0xFFFFFFFFn);
  const hi = Number((value >> 32n) & 0xFFFFFFFFn);
  buf.writeUInt32LE(lo, offset);
  buf.writeUInt32LE(hi, offset + 4);
}

interface ZipEntryRecord {
  name: string;
  crc: number;
  size: bigint;
  offset: bigint;
}

export class ZipStream {
  private out: Writable;
  private offset: bigint = 0n;
  private entries: ZipEntryRecord[] = [];

  constructor(out: Writable) {
    this.out = out;
  }

  private async writeBuf(buf: Buffer) {
    const ok = this.out.write(buf);
    this.offset += BigInt(buf.length);
    if (!ok) await new Promise<void>(resolve => this.out.once("drain", resolve));
  }

  async addFile(name: string, data: Buffer) {
    const crc    = crc32(data);
    const size   = BigInt(data.length);
    const nameBuf = Buffer.from(name, "utf8");
    const localHeaderOffset = this.offset;

    const zip64Extra = Buffer.alloc(20);
    zip64Extra.writeUInt16LE(0x0001, 0);
    zip64Extra.writeUInt16LE(16,     2);
    writeUInt64LE(zip64Extra, size, 4);
    writeUInt64LE(zip64Extra, size, 12);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,  0);
    header.writeUInt16LE(45,          4);
    header.writeUInt16LE(0x0800,      6);
    header.writeUInt16LE(0,           8);
    header.writeUInt16LE(0,          10);
    header.writeUInt16LE(0x21,       12);
    header.writeUInt32LE(crc,        14);
    header.writeUInt32LE(0xFFFFFFFF, 18);
    header.writeUInt32LE(0xFFFFFFFF, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(zip64Extra.length, 28);

    await this.writeBuf(header);
    await this.writeBuf(nameBuf);
    await this.writeBuf(zip64Extra);
    await this.writeBuf(data);

    this.entries.push({ name, crc, size, offset: localHeaderOffset });
  }

  async finish() {
    const centralDirStart: bigint = this.offset;

    for (const entry of this.entries) {
      const nameBuf = Buffer.from(entry.name, "utf8");

      const zip64Extra = Buffer.alloc(28);
      zip64Extra.writeUInt16LE(0x0001, 0);
      zip64Extra.writeUInt16LE(24,     2);
      writeUInt64LE(zip64Extra, entry.size,   4);
      writeUInt64LE(zip64Extra, entry.size,  12);
      writeUInt64LE(zip64Extra, entry.offset, 20);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50,  0);
      header.writeUInt16LE(45,          4);
      header.writeUInt16LE(45,          6);
      header.writeUInt16LE(0x0800,      8);
      header.writeUInt16LE(0,          10);
      header.writeUInt16LE(0x21,       14);
      header.writeUInt32LE(entry.crc,  16);
      header.writeUInt32LE(0xFFFFFFFF, 20);
      header.writeUInt32LE(0xFFFFFFFF, 24);
      header.writeUInt16LE(nameBuf.length, 28);
      header.writeUInt16LE(zip64Extra.length, 30);
      header.writeUInt16LE(0,          32);
      header.writeUInt16LE(0,          34);
      header.writeUInt16LE(0,          36);
      header.writeUInt32LE(0,          38);
      header.writeUInt32LE(0xFFFFFFFF, 42);

      await this.writeBuf(header);
      await this.writeBuf(nameBuf);
      await this.writeBuf(zip64Extra);
    }

    const centralDirSize: bigint = this.offset - centralDirStart;
    const entryCount = BigInt(this.entries.length);

    const zip64Eocd = Buffer.alloc(56);
    zip64Eocd.writeUInt32LE(0x06064b50, 0);
    writeUInt64LE(zip64Eocd, 44n,             4);
    zip64Eocd.writeUInt16LE(45,              12);
    zip64Eocd.writeUInt16LE(45,              14);
    zip64Eocd.writeUInt32LE(0,              16);
    zip64Eocd.writeUInt32LE(0,              20);
    writeUInt64LE(zip64Eocd, entryCount,    24);
    writeUInt64LE(zip64Eocd, entryCount,    32);
    writeUInt64LE(zip64Eocd, centralDirSize, 40);
    writeUInt64LE(zip64Eocd, centralDirStart, 48);
    await this.writeBuf(zip64Eocd);

    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50, 0);
    zip64Locator.writeUInt32LE(0,           4);
    writeUInt64LE(zip64Locator, centralDirStart + centralDirSize, 8);
    zip64Locator.writeUInt32LE(1,          16);
    await this.writeBuf(zip64Locator);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50,  0);
    eocd.writeUInt16LE(0xFFFF,      4);
    eocd.writeUInt16LE(0xFFFF,      6);
    eocd.writeUInt16LE(0xFFFF,      8);
    eocd.writeUInt16LE(0xFFFF,     10);
    eocd.writeUInt32LE(0xFFFFFFFF, 12);
    eocd.writeUInt32LE(0xFFFFFFFF, 16);
    eocd.writeUInt16LE(0,          20);
    await this.writeBuf(eocd);

    this.out.end();
  }
}
