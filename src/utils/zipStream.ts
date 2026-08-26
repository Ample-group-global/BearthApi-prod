import type { Writable } from "stream";

// Streaming ZIP writer — always uses ZIP64 extensions so archives beyond 4 GB
// (e.g. 9 999 × 2 000×2 000 PNG) write correctly. ZIP64 is supported by every
// modern zip tool (7-Zip, macOS Archive Utility, Windows Explorer 10+).
//
// Compression method STORED (0) — images are already PNG/WEBP-compressed so
// DEFLATE would cost CPU for negligible size savings.

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

// Write a BigInt as a little-endian 64-bit value into buf at offset.
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

  // write() returns false once the stream's internal buffer exceeds its
  // highWaterMark — the caller is expected to wait for 'drain' before
  // writing more. This was previously ignored entirely, so a batch of many
  // large image buffers written back-to-back (the normal case for any real
  // collection) just piled up in memory unbounded rather than actually
  // being paced by how fast the socket could drain — fine at 100 items,
  // a real problem well before 50k.
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

    // ZIP64 extra field for local header (20 bytes)
    const zip64Extra = Buffer.alloc(20);
    zip64Extra.writeUInt16LE(0x0001, 0); // ZIP64 tag
    zip64Extra.writeUInt16LE(16,     2); // data size (two 8-byte fields)
    writeUInt64LE(zip64Extra, size, 4);  // uncompressed size
    writeUInt64LE(zip64Extra, size, 12); // compressed size

    // Local file header (30 bytes) — sizes set to 0xFFFFFFFF to signal ZIP64
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,  0); // local file header signature
    header.writeUInt16LE(45,          4); // version needed: 4.5 (ZIP64)
    header.writeUInt16LE(0x0800,      6); // flags: UTF-8 filename
    header.writeUInt16LE(0,           8); // compression: STORED
    header.writeUInt16LE(0,          10); // mod time
    header.writeUInt16LE(0x21,       12); // mod date
    header.writeUInt32LE(crc,        14); // CRC-32
    header.writeUInt32LE(0xFFFFFFFF, 18); // compressed size  → ZIP64 extra
    header.writeUInt32LE(0xFFFFFFFF, 22); // uncompressed size → ZIP64 extra
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

      // ZIP64 extra field for central directory (28 bytes)
      const zip64Extra = Buffer.alloc(28);
      zip64Extra.writeUInt16LE(0x0001, 0); // ZIP64 tag
      zip64Extra.writeUInt16LE(24,     2); // data size (three 8-byte fields)
      writeUInt64LE(zip64Extra, entry.size,   4); // uncompressed size
      writeUInt64LE(zip64Extra, entry.size,  12); // compressed size
      writeUInt64LE(zip64Extra, entry.offset, 20); // relative offset of local header

      // Central directory file header (46 bytes)
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50,  0); // central directory signature
      header.writeUInt16LE(45,          4); // version made by: 4.5
      header.writeUInt16LE(45,          6); // version needed: 4.5
      header.writeUInt16LE(0x0800,      8); // flags: UTF-8
      header.writeUInt16LE(0,          10); // compression: STORED
      header.writeUInt16LE(0,          12); // mod time
      header.writeUInt16LE(0x21,       14); // mod date
      header.writeUInt32LE(entry.crc,  16); // CRC-32
      header.writeUInt32LE(0xFFFFFFFF, 20); // compressed size  → ZIP64
      header.writeUInt32LE(0xFFFFFFFF, 24); // uncompressed size → ZIP64
      header.writeUInt16LE(nameBuf.length, 28);
      header.writeUInt16LE(zip64Extra.length, 30);
      header.writeUInt16LE(0,          32); // file comment length
      // Real value, not the ZIP64 0xFFFF sentinel — this archive is always a
      // single "disk", and the ZIP64 extra field above never actually
      // includes a disk-number entry. Claiming 0xFFFF here without one
      // promises data that isn't there; jszip tolerates it, but Windows'
      // native unzip (.NET ZipArchive) reads it as a spanned/split archive
      // and refuses to open the file entirely. Confirmed live 2026-08-25.
      header.writeUInt16LE(0,          34); // disk number start
      header.writeUInt16LE(0,          36); // internal attributes
      header.writeUInt32LE(0,          38); // external attributes
      header.writeUInt32LE(0xFFFFFFFF, 42); // local header offset → ZIP64

      await this.writeBuf(header);
      await this.writeBuf(nameBuf);
      await this.writeBuf(zip64Extra);
    }

    const centralDirSize: bigint = this.offset - centralDirStart;
    const entryCount = BigInt(this.entries.length);

    // ZIP64 end of central directory record (56 bytes total, per APPNOTE.TXT
    // 4.3.14). Every field after the signature was previously shifted 4 bytes
    // too far right — "size of zip64 EOCD" started at offset 8 instead of 4,
    // and every field after it inherited that same shift, until the final
    // 8-byte field (central dir offset) was told to start at byte 52 in a
    // 56-byte buffer — needing bytes 52-59, 4 bytes past the end. That threw
    // a RangeError on every single completed export (any job, pre-built ZIP
    // or streamed), always at this exact point since it only runs once the
    // entire archive body has already written successfully — which is why
    // this looked like a stall under load rather than what it actually was:
    // a guaranteed crash at the very last step of every full run.
    const zip64Eocd = Buffer.alloc(56);
    zip64Eocd.writeUInt32LE(0x06064b50, 0); // ZIP64 EOCD signature
    writeUInt64LE(zip64Eocd, 44n,             4);  // size of zip64 EOCD (56-12)
    zip64Eocd.writeUInt16LE(45,              12);  // version made by
    zip64Eocd.writeUInt16LE(45,              14);  // version needed
    zip64Eocd.writeUInt32LE(0,              16);   // disk number
    zip64Eocd.writeUInt32LE(0,              20);   // disk with start of central dir
    writeUInt64LE(zip64Eocd, entryCount,    24);   // entries on this disk
    writeUInt64LE(zip64Eocd, entryCount,    32);   // total entries
    writeUInt64LE(zip64Eocd, centralDirSize, 40);  // central dir size
    writeUInt64LE(zip64Eocd, centralDirStart, 48); // central dir offset
    await this.writeBuf(zip64Eocd);

    // ZIP64 end of central directory locator (20 bytes)
    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50, 0); // ZIP64 EOCD locator signature
    zip64Locator.writeUInt32LE(0,           4); // disk with start of zip64 EOCD
    writeUInt64LE(zip64Locator, centralDirStart + centralDirSize, 8); // offset of zip64 EOCD
    zip64Locator.writeUInt32LE(1,          16); // total disks
    await this.writeBuf(zip64Locator);

    // End of central directory record (22 bytes) — fields set to 0xFFFF/0xFFFFFFFF → ZIP64
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50,  0); // EOCD signature
    eocd.writeUInt16LE(0xFFFF,      4); // disk number → ZIP64
    eocd.writeUInt16LE(0xFFFF,      6); // disk with central dir → ZIP64
    eocd.writeUInt16LE(0xFFFF,      8); // entries on this disk → ZIP64
    eocd.writeUInt16LE(0xFFFF,     10); // total entries → ZIP64
    eocd.writeUInt32LE(0xFFFFFFFF, 12); // central dir size → ZIP64
    eocd.writeUInt32LE(0xFFFFFFFF, 16); // central dir offset → ZIP64
    eocd.writeUInt16LE(0,          20); // comment length
    await this.writeBuf(eocd);

    this.out.end();
  }
}
