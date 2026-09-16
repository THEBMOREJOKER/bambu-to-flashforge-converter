/**
 * Writing a zip, for the two jobs that need one: a cleaned copy of a project whose settings Orca refuses, and a
 * project with a per-object setting put in. Members that did not change are passed through as stored bytes, so
 * copying a 43 MB project does not re-compress the 200 MB model inside it.
 */
import { writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

import type { Zip } from "./zip.js";

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A member to write: either bytes to compress, or bytes already compressed that we hand through untouched. */
export type ZipSource =
  | { name: string; data: Buffer }
  | { name: string; raw: Buffer; method: number; crc: number; size: number };

function dosStamp(when = new Date()): { time: number; date: number } {
  const time = ((when.getHours() & 0x1f) << 11) | ((when.getMinutes() & 0x3f) << 5) | ((when.getSeconds() / 2) & 0x1f);
  const date = (((when.getFullYear() - 1980) & 0x7f) << 9) | (((when.getMonth() + 1) & 0x0f) << 5) | (when.getDate() & 0x1f);
  return { time, date };
}

export function writeZip(path: string, sources: ZipSource[]): void {
  const { time, date } = dosStamp();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const source of sources) {
    const name = Buffer.from(source.name, "utf8");
    let method: number;
    let payload: Buffer;
    let crc: number;
    let size: number;

    if ("data" in source) {
      size = source.data.length;
      crc = crc32(source.data);
      const deflated = deflateRawSync(source.data, { level: 6 });
      if (deflated.length < size) {
        method = 8;
        payload = deflated;
      } else {
        method = 0;
        payload = source.data;
      }
    } else {
      method = source.method;
      payload = source.raw;
      crc = source.crc;
      size = source.size;
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags: no data descriptor, sizes are known here
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, payload);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(CD_SIG, 0);
    entry.writeUInt16LE(20, 4);          // version made by
    entry.writeUInt16LE(20, 6);          // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + payload.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(sources.length, 8);
  eocd.writeUInt16LE(sources.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  writeFileSync(path, Buffer.concat([...parts, cd, eocd]));
}

/**
 * The same archive with named members replaced or dropped, everything else handed through as-is. This is how a
 * project gets a per-object setting put into it, or the keys Orca refuses taken out of it, without disturbing
 * a single triangle of the model.
 */
export function copyZipWith(zip: Zip, destination: string, changes: Record<string, Buffer | null>): void {
  const sources: ZipSource[] = [];
  for (const name of zip.names()) {
    if (name in changes) {
      const replacement = changes[name];
      if (replacement === null || replacement === undefined) continue; // dropped
      sources.push({ name, data: replacement });
      continue;
    }
    const entry = zip.entry(name);
    sources.push({ name, raw: zip.rawData(entry), method: entry.method, crc: entry.crc, size: entry.size });
  }
  for (const [name, data] of Object.entries(changes)) {
    if (data && !zip.has(name)) sources.push({ name, data });
  }
  writeZip(destination, sources);
}
