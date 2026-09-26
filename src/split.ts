/**
 * Two parts exported as one mesh are one object to any slicer and cannot be oriented apart. This reads each build
 * object's mesh as it sits on the plate, counts its disconnected shells, and on request writes one binary STL per
 * shell of the named objects and every other object whole. Writing every object whole (`--split none`) is also the
 * way round a project file the slicer crashes on. A print-in-place figure is many shells by design: read the count
 * before splitting anything.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { apply, type Matrix, placements, structure } from "./geometry.js";
import { WORKDIR } from "./machine.js";
import { streamMemberText } from "./stream.js";
import { objectSettings } from "./threemf.js";
import { Zip } from "./zip.js";

/** Growable typed arrays: a million-triangle mesh does not sit comfortably in arrays of arrays. */
class Floats {
  data = new Float64Array(1 << 15);
  length = 0;
  push(x: number, y: number, z: number): void {
    if (this.length + 3 > this.data.length) this.grow();
    this.data[this.length++] = x;
    this.data[this.length++] = y;
    this.data[this.length++] = z;
  }
  private grow(): void {
    const next = new Float64Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }
}

class Ints {
  data = new Uint32Array(1 << 15);
  length = 0;
  push(v: number): void {
    if (this.length + 1 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

export interface Mesh {
  /** x, y, z per vertex, already placed on the plate. */
  verts: Float64Array;
  /** Three vertex indices per triangle. */
  tris: Uint32Array;
}

/** A face with nothing on it but its three corners. Anything more is paint: a colour, a support, a seam. */
const PLAIN_FACE = /^\s*v1="\d+"\s+v2="\d+"\s+v3="\d+"\s*\/?\s*$/;

const num = (attrs: string, name: string) => Number(new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1]);

/**
 * Every build item's mesh, vertices transformed the way the project places them — and whether its faces carry
 * anything painted on them, because paint rides on the face and does not survive a mesh being rewritten.
 */
export async function itemMeshes(zip: Zip): Promise<Array<{ objectId: string; mesh: Mesh; painted: boolean }>> {
  const { items, objects } = await structure(zip);
  const places = placements(items, objects);
  const verts = items.map(() => new Floats());
  const tris = items.map(() => new Ints());
  const painted = items.map(() => false);

  const modelFiles = [...new Set([...places.keys()].map((k) => k.split("#")[0] ?? ""))];
  for (const path of modelFiles) {
    let active: Array<{ item: number; matrix: Matrix }> = [];
    const local = new Floats();
    const faces = new Ints();
    // An object's vertices and triangles are held until the object ends, then laid down once per placement,
    // so an object placed twice in one item keeps its indices contiguous.
    const flush = () => {
      for (const { item, matrix } of active) {
        const v = verts[item]!;
        const t = tris[item]!;
        const base = v.length / 3;
        for (let k = 0; k < local.length; k += 3) {
          const p = apply(matrix, local.data[k]!, local.data[k + 1]!, local.data[k + 2]!);
          v.push(p[0], p[1], p[2]);
        }
        for (let k = 0; k < faces.length; k++) t.push(base + faces.data[k]!);
      }
      local.length = 0;
      faces.length = 0;
    };
    await streamMemberText(zip, path, (text) => {
      const re = /<(object|vertex|triangle)\b([^>]*)>/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const attrs = m[2] ?? "";
        if (m[1] === "object") {
          flush();
          const id = /(?:^|\s)id="([^"]*)"/.exec(attrs)?.[1];
          active = id ? places.get(`${path}#${id}`) ?? [] : [];
          continue;
        }
        if (!active.length) continue;
        if (m[1] === "vertex") {
          local.push(num(attrs, "x"), num(attrs, "y"), num(attrs, "z"));
        } else {
          if (!PLAIN_FACE.test(attrs)) for (const { item } of active) painted[item] = true;
          faces.push(num(attrs, "v1"));
          faces.push(num(attrs, "v2"));
          faces.push(num(attrs, "v3"));
        }
      }
    });
    flush();
  }

  return items.map((item, i) => ({
    objectId: item.id,
    mesh: {
      verts: verts[i]!.data.subarray(0, verts[i]!.length),
      tris: tris[i]!.data.subarray(0, tris[i]!.length),
    },
    painted: painted[i] ?? false,
  }));
}

/** Triangle indices grouped by connected vertices, largest shell first. */
export function shells(mesh: Mesh): number[][] {
  const parent = new Int32Array(mesh.verts.length / 3);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (start: number): number => {
    let x = start;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const count = mesh.tris.length / 3;
  for (let i = 0; i < count; i++) {
    const ra = find(mesh.tris[3 * i]!);
    const rb = find(mesh.tris[3 * i + 1]!);
    if (rb !== ra) parent[rb] = ra;
    const rc = find(mesh.tris[3 * i + 2]!);
    if (rc !== ra) parent[rc] = ra;
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(mesh.tris[3 * i]!);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** Where a set of faces sits on the plate. */
export interface Box { lo: [number, number, number]; hi: [number, number, number]; }

export function box(mesh: Mesh, idx: Iterable<number>): Box {
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const i of idx) {
    for (let c = 0; c < 3; c++) {
      const v = mesh.tris[3 * i + c]!;
      for (let d = 0; d < 3; d++) {
        const x = mesh.verts[3 * v + d]!;
        if (x < lo[d]!) lo[d] = x;
        if (x > hi[d]!) hi[d] = x;
      }
    }
  }
  return { lo, hi };
}

export function size(mesh: Mesh, idx: Iterable<number>): [number, number, number] {
  const { lo, hi } = box(mesh, idx);
  return [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!];
}

/**
 * Two boxes closer than this are the same piece. A nozzle is 0.4 mm wide: nothing nearer than that was meant to be
 * pulled apart, and a print-in-place joint — a pin in its socket, a bone laid across the next one — is nearer still.
 */
export const TOGETHER = 0.4;

/** Whether two boxes meet, allowing for that width. */
function meet(a: Box, b: Box): boolean {
  for (let d = 0; d < 3; d++) {
    if (Math.min(a.hi[d]!, b.hi[d]!) - Math.max(a.lo[d]!, b.lo[d]!) < -TOGETHER) return false;
  }
  return true;
}

/**
 * The pieces an object really is. Shells whose boxes meet belong to one piece — that is what holds a figure printed
 * in place together, bones laid across each other and joints inside their sockets alike. Shells that sit clear of
 * each other are separate pieces, which is what a Bambu "combined body" (组合体) is: two parts exported as one
 * object, one piece to any slicer, impossible to move, orient or set apart.
 *
 * A fragment too small to be a part of its own — a stray shard of a bad mesh — joins the piece it lies nearest,
 * because geometry is never dropped here.
 */
export function pieces(mesh: Mesh, groups: number[][], minTris = 20): number[][] {
  if (groups.length < 2) return groups;
  const boxes = groups.map((g) => box(mesh, g));
  const parent = groups.map((_, i) => i);
  const find = (i: number): number => {
    let x = i;
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      if (!meet(boxes[i]!, boxes[j]!)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    }
  }
  const order: number[] = [];
  const members = new Map<number, number[]>();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    const list = members.get(root);
    if (list) list.push(i);
    else {
      members.set(root, [i]);
      order.push(root);
    }
  }
  const parts = order.map((root) => {
    const shellsOf = members.get(root)!;
    return {
      tris: shellsOf.flatMap((i) => groups[i]!).sort((a, b) => a - b),
      box: shellsOf.map((i) => boxes[i]!).reduce((a, b) => ({
        lo: [Math.min(a.lo[0]!, b.lo[0]!), Math.min(a.lo[1]!, b.lo[1]!), Math.min(a.lo[2]!, b.lo[2]!)],
        hi: [Math.max(a.hi[0]!, b.hi[0]!), Math.max(a.hi[1]!, b.hi[1]!), Math.max(a.hi[2]!, b.hi[2]!)],
      })),
    };
  });

  // A shard joins its nearest neighbour rather than standing on the plate as an object of its own.
  const centre = (b: Box) => [0, 1, 2].map((d) => (b.lo[d]! + b.hi[d]!) / 2);
  const keep = parts.filter((p) => p.tris.length >= minTris);
  if (!keep.length) return parts.map((p) => p.tris);
  for (const shard of parts) {
    if (shard.tris.length >= minTris) continue;
    const c = centre(shard.box);
    let best = keep[0]!;
    let bestAway = Infinity;
    for (const part of keep) {
      const k = centre(part.box);
      const away = (k[0]! - c[0]!) ** 2 + (k[1]! - c[1]!) ** 2 + (k[2]! - c[2]!) ** 2;
      if (away < bestAway) { bestAway = away; best = part; }
    }
    best.tris = [...best.tris, ...shard.tris].sort((a, b) => a - b);
  }
  return keep.map((p) => p.tris);
}

function* every(n: number): Generator<number> {
  for (let i = 0; i < n; i++) yield i;
}

/** A binary STL: an 80-byte header, a count, then 50 bytes a triangle with the normal left for the slicer. */
export function writeStl(path: string, mesh: Mesh, idx: number[] | null): number {
  const n = idx ? idx.length : mesh.tris.length / 3;
  const buf = Buffer.alloc(84 + 50 * n);
  buf.write("split_mesh", 0, "ascii");
  buf.writeUInt32LE(n, 80);
  let o = 84;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k]! : k;
    for (let c = 0; c < 3; c++) {
      const v = mesh.tris[3 * i + c]!;
      for (let d = 0; d < 3; d++) buf.writeFloatLE(mesh.verts[3 * v + d]!, o + 12 + 12 * c + 4 * d);
    }
    o += 50;
  }
  writeFileSync(path, buf);
  return n;
}

export interface SplitShell { triangles: number; size: [number, number, number]; }
export interface SplitWritten { path: string; triangles: number; size: [number, number, number]; whole: boolean; }

export interface SplitObject {
  objectId: string;
  name: string;
  triangles: number;
  shellCount: number;
  /** How many pieces those shells really make: shells that meet are one piece. */
  pieceCount: number;
  /** The six largest shells, as they would be written. */
  shells: SplitShell[];
  written: SplitWritten[];
  /** Fragments under the minimum, not written. */
  skipped: number[];
}

export interface SplitResult { project: string; out: string; objects: SplitObject[]; written: string[]; }

export interface SplitOptions {
  /** Object ids to split into shells; any id that matches none (e.g. "none") writes every object whole. Empty: report only. */
  ids?: string[];
  out?: string;
  minTris?: number;
}

function safeName(name: string, objectId: string): string {
  const stem = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
  return [...stem].map((ch) => (/[\p{L}\p{N}_-]/u.test(ch) ? ch : "_")).join("") || `object${objectId}`;
}

export async function split(project: string, options: SplitOptions = {}): Promise<SplitResult> {
  const ids = options.ids ?? [];
  const minTris = options.minTris ?? 20;
  const stem = basename(project).replace(/\.[^.]+$/, "");
  const out = options.out ?? join(WORKDIR, "in", `${stem}-split`);
  const zip = new Zip(project);
  try {
    const names = new Map(objectSettings(zip).map((o) => [o.objectId, o.name]));
    const result: SplitResult = { project, out, objects: [], written: [] };
    for (const { objectId, mesh } of await itemMeshes(zip)) {
      const name = names.get(objectId) || `object${objectId}`;
      const groups = shells(mesh);
      const parts = pieces(mesh, groups, minTris);
      const object: SplitObject = {
        objectId, name, triangles: mesh.tris.length / 3, shellCount: groups.length, pieceCount: parts.length,
        shells: groups.slice(0, 6).map((g) => ({ triangles: g.length, size: size(mesh, g) })),
        written: [], skipped: [],
      };
      result.objects.push(object);
      if (!ids.length) continue;

      mkdirSync(out, { recursive: true });
      const safe = safeName(name, objectId);
      if (ids.includes(objectId)) {
        let n = 0;
        for (const g of groups) {
          if (g.length < minTris) { object.skipped.push(g.length); continue; }
          n++;
          const path = join(out, `${safe}-${n}.stl`);
          writeStl(path, mesh, g);
          object.written.push({ path, triangles: g.length, size: size(mesh, g), whole: false });
          result.written.push(path);
        }
      } else if (parts.length < 2) {
        const path = join(out, `${safe}.stl`);
        const triangles = writeStl(path, mesh, null);
        object.written.push({ path, triangles, size: size(mesh, every(triangles)), whole: true });
        result.written.push(path);
      } else {
        // Whole, but not welded: the pieces an object is really made of are written one STL each, or the parts a
        // project kept apart come back from the mesh as one lump.
        parts.forEach((part, i) => {
          const path = join(out, `${safe}-piece${i + 1}.stl`);
          writeStl(path, mesh, part);
          object.written.push({ path, triangles: part.length, size: size(mesh, part), whole: true });
          result.written.push(path);
        });
      }
    }
    return result;
  } finally {
    zip.close();
  }
}
