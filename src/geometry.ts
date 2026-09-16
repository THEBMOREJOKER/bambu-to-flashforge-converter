/**
 * How big each object on the plate really is, after the transforms the project puts on it — the only question
 * that matters before a slice is whether it fits a 220 mm bed, and at what size it will come out.
 *
 * Every vertex is transformed, not the eight corners of a local box: a 3MF item may carry any rotation, and a
 * rotated box's corners overstate the extents. Two streaming passes: the first learns the structure (a build's
 * items, the objects they reference, the components inside them), the second measures.
 */
import type { Zip } from "./zip.js";
import { streamMemberText } from "./stream.js";

/** 3MF writes a transform as twelve numbers: a 3×3 rotation/scale in row-major order, then a translation. */
export interface Matrix {
  r: [[number, number, number], [number, number, number], [number, number, number]];
  t: [number, number, number];
}

export const IDENTITY: Matrix = { r: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };

export function parseTransform(text: string | undefined): Matrix {
  if (!text) return IDENTITY;
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length < 12 || v.some((n) => !Number.isFinite(n))) return IDENTITY;
  return {
    r: [[v[0] ?? 1, v[1] ?? 0, v[2] ?? 0], [v[3] ?? 0, v[4] ?? 1, v[5] ?? 0], [v[6] ?? 0, v[7] ?? 0, v[8] ?? 1]],
    t: [v[9] ?? 0, v[10] ?? 0, v[11] ?? 0],
  };
}

/** 3MF is a row-vector convention: p' = p · M + t. */
export function apply(m: Matrix, x: number, y: number, z: number): [number, number, number] {
  return [
    x * m.r[0][0] + y * m.r[1][0] + z * m.r[2][0] + m.t[0],
    x * m.r[0][1] + y * m.r[1][1] + z * m.r[2][1] + m.t[1],
    x * m.r[0][2] + y * m.r[1][2] + z * m.r[2][2] + m.t[2],
  ];
}

export function compose(outer: Matrix, inner: Matrix): Matrix {
  const r = [0, 1, 2].map((a) => [0, 1, 2].map((b) =>
    inner.r[a]![0]! * outer.r[0]![b]! + inner.r[a]![1]! * outer.r[1]![b]! + inner.r[a]![2]! * outer.r[2]![b]!,
  )) as Matrix["r"];
  return { r, t: apply(outer, inner.t[0], inner.t[1], inner.t[2]) };
}

export interface ObjectRef { path: string; id: string; }
interface ComponentRef extends ObjectRef { transform: Matrix; }

export interface ObjectShape {
  /** Components this object is built from, each with its own transform. */
  components: ComponentRef[];
  /** Whether the object carries a mesh of its own. */
  hasMesh: boolean;
  name: string;
}

export interface PlacedObject {
  objectId: string;
  name: string;
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

const key = (ref: ObjectRef) => `${ref.path}#${ref.id}`;

/** Pass one: the shape of the project — its build items, and what each object is made of. */
export async function structure(zip: Zip): Promise<{ items: Array<ObjectRef & { transform: Matrix }>; objects: Map<string, ObjectShape> }> {
  const objects = new Map<string, ObjectShape>();
  const items: Array<ObjectRef & { transform: Matrix }> = [];
  const modelFiles = zip.names().filter((n) => n.endsWith(".model"));

  for (const path of modelFiles) {
    let current: string | null = null;
    await streamMemberText(zip, path, (text) => {
      const tagRe = /<(object|component|item|mesh)\b([^>]*)>/g;
      for (let m = tagRe.exec(text); m; m = tagRe.exec(text)) {
        const tag = m[1];
        const attrs = m[2] ?? "";
        const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1];
        if (tag === "object") {
          current = attr("id") ?? null;
          if (current) objects.set(key({ path, id: current }), { components: [], hasMesh: false, name: attr("name") ?? "" });
        } else if (tag === "mesh" && current) {
          const shape = objects.get(key({ path, id: current }));
          if (shape) shape.hasMesh = true;
        } else if (tag === "component" && current) {
          const shape = objects.get(key({ path, id: current }));
          const childPath = (attr("p:path") ?? path).replace(/^\//, "");
          if (shape) {
            shape.components.push({ path: childPath, id: attr("objectid") ?? "", transform: parseTransform(attr("transform")) });
          }
        } else if (tag === "item") {
          items.push({
            path: (attr("p:path") ?? "3D/3dmodel.model").replace(/^\//, ""),
            id: attr("objectid") ?? "",
            transform: parseTransform(attr("transform")),
          });
        }
      }
    });
  }
  return { items, objects };
}

/** Every world transform each mesh-bearing object appears under, and which build item it belongs to. */
export function placements(
  items: Array<ObjectRef & { transform: Matrix }>,
  objects: Map<string, ObjectShape>,
): Map<string, Array<{ item: number; matrix: Matrix }>> {
  const out = new Map<string, Array<{ item: number; matrix: Matrix }>>();
  const walk = (ref: ObjectRef, matrix: Matrix, item: number, depth: number): void => {
    if (depth > 8) return;
    const shape = objects.get(key(ref));
    if (!shape) return;
    if (shape.hasMesh) {
      const list = out.get(key(ref)) ?? [];
      list.push({ item, matrix });
      out.set(key(ref), list);
    }
    for (const child of shape.components) {
      walk(child, compose(matrix, child.transform), item, depth + 1);
    }
  };
  items.forEach((item, index) => walk(item, item.transform, index, 0));
  return out;
}

/** Pass two: measure. Vertices stream past; each one lands in the box of every item that places it. */
export async function placedObjects(zip: Zip): Promise<PlacedObject[]> {
  const { items, objects } = await structure(zip);
  const places = placements(items, objects);
  if (!items.length) return [];

  const min: Array<[number, number, number]> = items.map(() => [Infinity, Infinity, Infinity]);
  const max: Array<[number, number, number]> = items.map(() => [-Infinity, -Infinity, -Infinity]);
  const triangles = items.map(() => 0);

  const modelFiles = [...new Set([...places.keys()].map((k) => k.split("#")[0] ?? ""))];
  for (const path of modelFiles) {
    let current: string | null = null;
    let active: Array<{ item: number; matrix: Matrix }> = [];
    await streamMemberText(zip, path, (text) => {
      const re = /<(object|vertex|triangle)\b([^>]*)>/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const tag = m[1];
        const attrs = m[2] ?? "";
        if (tag === "object") {
          current = /id="([^"]*)"/.exec(attrs)?.[1] ?? null;
          active = current ? places.get(`${path}#${current}`) ?? [] : [];
          continue;
        }
        if (!active.length) continue;
        if (tag === "triangle") {
          for (const { item } of active) triangles[item] = (triangles[item] ?? 0) + 1;
          continue;
        }
        const x = Number(/x="([^"]*)"/.exec(attrs)?.[1]);
        const y = Number(/y="([^"]*)"/.exec(attrs)?.[1]);
        const z = Number(/z="([^"]*)"/.exec(attrs)?.[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        for (const { item, matrix } of active) {
          const p = apply(matrix, x, y, z);
          const lo = min[item]!;
          const hi = max[item]!;
          for (let a = 0; a < 3; a++) {
            if (p[a]! < lo[a]!) lo[a] = p[a]!;
            if (p[a]! > hi[a]!) hi[a] = p[a]!;
          }
        }
      }
    });
  }

  return items.map((item, index) => {
    const lo = min[index]!;
    const hi = max[index]!;
    const shape = objects.get(key(item));
    return {
      objectId: item.id,
      name: shape?.name ?? "",
      triangles: triangles[index] ?? 0,
      min: lo,
      max: hi,
      size: [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!],
    };
  });
}
