/**
 * An STL's extents, for the one question that matters before a slice: does it fit on a 220 mm bed. Read in
 * chunks rather than whole — a 2.4 M triangle mesh is 120 MB, and nothing here needs it all at once.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export interface StlInfo {
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  ascii: boolean;
}

const RECORD = 50; // 12 floats of normal and vertices, plus a 2-byte attribute count

export function stlInfo(path: string): StlInfo {
  const fd = openSync(path, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(1024, fileSize));
    readSync(fd, head, 0, head.length, 0);
    const looksAscii = head.subarray(0, 5).toString("ascii") === "solid" && head.includes(Buffer.from("facet"));

    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const see = (x: number, y: number, z: number) => {
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    };

    let triangles = 0;
    if (looksAscii) {
      const text = Buffer.alloc(fileSize);
      readSync(fd, text, 0, fileSize, 0);
      for (const line of text.toString("utf8").split("\n")) {
        const t = line.trim();
        if (t.startsWith("vertex")) {
          const p = t.split(/\s+/);
          see(Number.parseFloat(p[1] ?? "0"), Number.parseFloat(p[2] ?? "0"), Number.parseFloat(p[3] ?? "0"));
        } else if (t.startsWith("facet")) {
          triangles++;
        }
      }
    } else {
      const count = Buffer.alloc(4);
      readSync(fd, count, 0, 4, 80);
      triangles = count.readUInt32LE(0);
      const expect = 84 + RECORD * triangles;
      if (expect !== fileSize) {
        throw new Error(`${path}: not a binary STL (header says ${triangles} triangles, that needs ${expect} bytes, file is ${fileSize})`);
      }
      const perChunk = 20000;
      const buf = Buffer.alloc(RECORD * perChunk);
      let done = 0;
      while (done < triangles) {
        const batch = Math.min(perChunk, triangles - done);
        readSync(fd, buf, 0, RECORD * batch, 84 + RECORD * done);
        for (let i = 0; i < batch; i++) {
          const base = i * RECORD + 12; // past the normal
          for (let v = 0; v < 3; v++) {
            const o = base + v * 12;
            see(buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8));
          }
        }
        done += batch;
      }
    }

    return {
      triangles,
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      ascii: looksAscii,
    };
  } finally {
    closeSync(fd);
  }
}

/** The bed is 220 × 220 × 220 and arrange re-centres, so only extents matter — a flat rotation is allowed. */
export function fitsBed(size: [number, number, number], bedXY = 220, bedZ = 220): boolean {
  return Math.max(size[0], size[1]) <= bedXY && Math.min(size[0], size[1]) <= bedXY && size[2] <= bedZ;
}
