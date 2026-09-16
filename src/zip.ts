/**
 * A 3MF is a zip, and Node has no zip reader in its standard library — so here is one, on top of
 * node:zlib's raw inflate. Random access by design: these archives carry a 200 MB model member, and
 * the notes a designer wrote sit in its first few kilobytes. Nothing here loads a member it is not asked for.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { constants as Z, inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARK = 0xffffffff;

export interface ZipEntry {
  /** Path inside the archive, e.g. "Metadata/project_settings.config". */
  name: string;
  /** 0 = stored, 8 = deflate. Nothing else appears in a 3MF. */
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  /** Offset of the local file header, not of the data: the header's own lengths move the data. */
  headerOffset: number;
}

export class Zip {
  private readonly fd: number;
  private readonly fileSize: number;
  readonly entries = new Map<string, ZipEntry>();

  constructor(readonly path: string) {
    this.fd = openSync(path, "r");
    try {
      this.fileSize = fstatSync(this.fd).size;
      this.readCentralDirectory();
    } catch (err) {
      closeSync(this.fd);
      throw err;
    }
  }

  private slice(length: number, position: number): Buffer {
    if (length <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(length);
    const got = readSync(this.fd, buf, 0, length, position);
    return got === length ? buf : buf.subarray(0, got);
  }

  private readCentralDirectory(): void {
    // The end-of-central-directory record is last, after a comment of up to 64 KB.
    const tailLength = Math.min(this.fileSize, 66 * 1024);
    const tail = this.slice(tailLength, this.fileSize - tailLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${this.path}: not a zip (no end-of-central-directory record)`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === ZIP64_MARK || cdSize === ZIP64_MARK || count === 0xffff) {
      throw new Error(`${this.path}: zip64 archive — not supported here (no 3MF this tool has seen needs it)`);
    }

    const cd = this.slice(cdSize, cdOffset);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) {
        throw new Error(`${this.path}: central directory entry ${i} is malformed`);
      }
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const headerOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLength);
      if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || headerOffset === ZIP64_MARK) {
        throw new Error(`${this.path}: '${name}' needs zip64 fields — not supported here`);
      }
      this.entries.set(name, { name, method, compressedSize, size, crc, headerOffset });
      p += 46 + nameLength + extraLength + commentLength;
    }
  }

  /** Where the member's bytes actually start: past its local header, whose name and extra fields vary. */
  private dataOffset(entry: ZipEntry): number {
    const header = this.slice(30, entry.headerOffset);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIG) {
      throw new Error(`${this.path}: '${entry.name}' has no local header`);
    }
    return entry.headerOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  entry(name: string): ZipEntry {
    const e = this.entries.get(name);
    if (!e) throw new Error(`${this.path}: no member '${name}'`);
    return e;
  }

  /** One whole member. Costs its uncompressed size in memory, so ask only for what you need. */
  read(name: string): Buffer {
    const e = this.entry(name);
    const raw = this.slice(e.compressedSize, this.dataOffset(e));
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new Error(`${this.path}: '${name}' uses compression method ${e.method}`);
    return inflateRawSync(raw, { maxOutputLength: e.size + 1024 });
  }

  readText(name: string): string {
    return this.read(name).toString("utf8");
  }

  readJson<T = unknown>(name: string): T {
    return JSON.parse(this.readText(name)) as T;
  }

  /**
   * The first part of a member, without inflating the rest. Feeds the deflate stream a slice of its
   * compressed bytes and flushes what that yields: enough for the metadata at the head of a 200 MB model,
   * for the price of reading a megabyte.
   */
  readPrefix(name: string, compressedBytes = 1 << 20): Buffer {
    const e = this.entry(name);
    const want = Math.min(compressedBytes, e.compressedSize);
    const raw = this.slice(want, this.dataOffset(e));
    if (e.method === 0) return raw;
    return inflateRawSync(raw, { finishFlush: Z.Z_SYNC_FLUSH });
  }

  readPrefixText(name: string, compressedBytes?: number): string {
    return this.readPrefix(name, compressedBytes).toString("utf8");
  }

  /**
   * A member's bytes exactly as stored. Copying an archive this way costs no compression at all — the 200 MB
   * model in a project is handed straight through, and only the settings file that changed is written afresh.
   */
  rawData(entry: ZipEntry): Buffer {
    return this.slice(entry.compressedSize, this.dataOffset(entry));
  }

  /** Where a member's bytes live in the file, for a reader that wants to stream them. */
  byteRange(name: string): { start: number; end: number; method: number } {
    const e = this.entry(name);
    const start = this.dataOffset(e);
    return { start, end: start + e.compressedSize - 1, method: e.method };
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Open, use, close — the shape almost every caller wants. */
export function withZip<T>(path: string, fn: (zip: Zip) => T): T {
  const zip = new Zip(path);
  try {
    return fn(zip);
  } finally {
    zip.close();
  }
}
