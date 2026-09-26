/**
 * Two parts exported as one object are one piece to any slicer: they cannot be moved apart, oriented apart, or given
 * a setting apart. Bambu Studio calls such an object a combined body — 组合体 — and a project downloaded from a model
 * site arrives with one often enough: a base and its lid, a stand and the thing that stands on it, welded into a
 * single object by whoever exported it. Handing that on as one piece is not a conversion.
 *
 * So the pieces are put back on their own feet before the slicer ever sees the file. Each piece becomes its own
 * object in the copy the slicer reads, exactly where it sat, and nothing else about the project changes. What is
 * never taken apart is a figure printed in place: its pieces are nested or laid across each other, their boxes meet,
 * and `pieces()` keeps them one object. The test is the geometry, never the count of shells.
 *
 * Three things hold an object back, and each is said rather than done quietly: faces with paint on them (a colour,
 * a painted support, a seam — paint rides on the face and does not survive the mesh being rewritten), a volume that
 * is not a normal part (a modifier, a support blocker), and an object built from several volumes, which carry
 * settings of their own.
 */
import { itemMeshes, type Mesh, pieces, shells, size } from "./split.js";
import { modelSettings, objectSettings } from "./threemf.js";
import type { Zip } from "./zip.js";

const MODEL = "3D/3dmodel.model";
const SETTINGS = "Metadata/model_settings.config";
/** 3MF writes a transform as twelve numbers; model_settings.config writes a 4×4 as sixteen. */
const IDENTITY_12 = "1 0 0 0 1 0 0 0 1 0 0 0";
const IDENTITY_16 = "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1";

export interface SeparatedObject {
  objectId: string;
  name: string;
  /** How many pieces the object was really made of. */
  pieces: number;
  /** Each piece as it will stand on the plate. */
  sizes: Array<[number, number, number]>;
}

export interface HeldObject {
  objectId: string;
  name: string;
  pieces: number;
  why: string;
}

export interface Separation {
  /** Objects taken apart in the copy the slicer reads. */
  objects: SeparatedObject[];
  /** Objects whose parts sit apart but are left as they are, and why. */
  held: HeldObject[];
  /** The members that have to change, given the per-object settings as they stand after every other change. */
  members(zip: Zip, modelSettingsXml: string | null): Record<string, Buffer>;
}

/** A vertex as the 3MF writes one: enough decimals for a micron, and no trailing zeros. */
function fmt(v: number): string {
  return v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

/** Each `<object>` block of model_settings.config, whole, by id. */
function objectBlocks(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<object id="([^"]+)"\s*>[\s\S]*?<\/object>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.set(m[1] ?? "", m[0]);
  return out;
}

/** Why an object that is really several pieces is left as one, or "" when nothing holds it back. */
function holdReason(block: string | undefined, painted: boolean): string {
  if (painted) return "its faces carry painted regions, and paint does not survive the mesh being rewritten";
  if (!block) return "";
  const subtypes = [...block.matchAll(/subtype="([^"]+)"/g)].map((m) => m[1] ?? "");
  const odd = [...new Set(subtypes.filter((s) => s !== "normal_part"))];
  if (odd.length) return `it carries ${odd.join(", ")}`;
  if (subtypes.length > 1) return `it is one object of ${subtypes.length} volumes, which carry settings of their own`;
  return "";
}

/** Object ids no model file uses. */
function freshIds(model: Buffer, settings: string | null, count: number): string[] {
  const out: string[] = [];
  for (let n = 1000; out.length < count; n++) {
    if (model.indexOf(`<object id="${n}"`) >= 0) continue;
    if (settings && settings.includes(`id="${n}"`)) continue;
    out.push(String(n));
  }
  return out;
}

/** One piece as a mesh object of its own, in the coordinates the project already placed it at. */
function meshObject(id: string, mesh: Mesh, tris: number[]): string {
  const index = new Map<number, number>();
  const verts: string[] = [];
  const faces: string[] = [];
  const vertex = (v: number): number => {
    const seen = index.get(v);
    if (seen !== undefined) return seen;
    const n = index.size;
    index.set(v, n);
    verts.push(`     <vertex x="${fmt(mesh.verts[3 * v]!)}" y="${fmt(mesh.verts[3 * v + 1]!)}" z="${fmt(mesh.verts[3 * v + 2]!)}"/>`);
    return n;
  };
  for (const t of tris) {
    const a = vertex(mesh.tris[3 * t]!);
    const b = vertex(mesh.tris[3 * t + 1]!);
    const c = vertex(mesh.tris[3 * t + 2]!);
    faces.push(`     <triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  }
  return [
    `  <object id="${id}" type="model">`, "   <mesh>", "    <vertices>", ...verts, "    </vertices>",
    "    <triangles>", ...faces, "    </triangles>", "   </mesh>", "  </object>", "",
  ].join("\n");
}

/** The object a build item points at: a wrapper around the piece's mesh, the shape a project already has. */
function wrapperObject(id: string, meshId: string): string {
  return [
    `  <object id="${id}" type="model">`, "   <components>",
    `    <component objectid="${meshId}" transform="${IDENTITY_12}"/>`, "   </components>", "  </object>", "",
  ].join("\n");
}

interface Piece { meshId: string; wrapperId: string; tris: number[]; faces: number; size: [number, number, number]; }
interface Apart { objectId: string; name: string; mesh: Mesh; parts: number[][]; }

export async function separation(zip: Zip): Promise<Separation | null> {
  if (!zip.has(MODEL)) return null;
  const settingsXml = modelSettings(zip);
  const blocks = settingsXml ? objectBlocks(settingsXml) : new Map<string, string>();
  const names = new Map(objectSettings(zip).map((o) => [o.objectId, o.name]));

  const apart: Apart[] = [];
  const held: HeldObject[] = [];
  for (const { objectId, mesh, painted } of await itemMeshes(zip)) {
    const parts = pieces(mesh, shells(mesh));
    if (parts.length < 2) continue;
    const name = names.get(objectId) || `object ${objectId}`;
    const why = holdReason(blocks.get(objectId), painted);
    if (why) held.push({ objectId, name, pieces: parts.length, why });
    else apart.push({ objectId, name, mesh, parts });
  }
  if (!apart.length && !held.length) return null;

  const objects: SeparatedObject[] = apart.map((a) => ({
    objectId: a.objectId, name: a.name, pieces: a.parts.length,
    sizes: a.parts.map((p) => size(a.mesh, p)),
  }));

  const members = (source: Zip, current: string | null): Record<string, Buffer> => {
    if (!apart.length) return {};
    const model = source.read(MODEL);
    const xml = current ?? settingsXml;
    const ids = freshIds(model, xml, apart.reduce((n, a) => n + a.parts.length * 2, 0));
    let next = 0;
    const plan = new Map<string, Piece[]>();
    for (const a of apart) {
      plan.set(a.objectId, a.parts.map((tris) => ({
        meshId: ids[next++]!, wrapperId: ids[next++]!, tris, faces: tris.length, size: size(a.mesh, tris),
      })));
    }

    const added = apart.flatMap((a) =>
      plan.get(a.objectId)!.map((piece) => meshObject(piece.meshId, a.mesh, piece.tris) + wrapperObject(piece.wrapperId, piece.meshId)),
    ).join("");

    const out: Record<string, Buffer> = { [MODEL]: rewriteModel(model, added, plan) };
    if (xml) out[SETTINGS] = Buffer.from(rewriteSettings(xml, plan, names));
    return out;
  };

  return { objects, held, members };
}

/** The pieces added to the resources, and every build item that placed a taken-apart object replaced by its pieces. */
function rewriteModel(model: Buffer, added: string, plan: Map<string, Piece[]>): Buffer {
  const resourcesEnd = model.lastIndexOf("</resources>");
  const buildStart = model.indexOf("<build", resourcesEnd < 0 ? 0 : resourcesEnd);
  const buildEnd = buildStart < 0 ? -1 : model.indexOf("</build>", buildStart);
  if (resourcesEnd < 0 || buildStart < 0 || buildEnd < 0) {
    throw new Error(`${MODEL}: no <resources>/<build> to put the pieces in`);
  }
  const build = model.subarray(buildStart, buildEnd + "</build>".length).toString("utf8");
  const rewritten = build.replace(/<item\b[^>]*?\/>|<item\b[^>]*?>[\s\S]*?<\/item>/g, (item: string) => {
    const id = /objectid="([^"]+)"/.exec(item)?.[1] ?? "";
    const pieces = plan.get(id);
    if (!pieces) return item;
    const printable = /printable="([^"]*)"/.exec(item)?.[1] ?? "1";
    return pieces
      .map((p) => `<item objectid="${p.wrapperId}" transform="${IDENTITY_12}" printable="${printable}" />`)
      .join("\n  ");
  });
  return Buffer.concat([
    model.subarray(0, resourcesEnd), Buffer.from(added), model.subarray(resourcesEnd, buildStart),
    Buffer.from(rewritten), model.subarray(buildEnd + "</build>".length),
  ]);
}

/** The same per-object settings, with each taken-apart object standing as its pieces: one entry, one instance each. */
function rewriteSettings(xml: string, plan: Map<string, Piece[]>, names: Map<string, string>): string {
  let out = xml;
  let identify = Math.max(0, ...[...xml.matchAll(/key="identify_id" value="(\d+)"/g)].map((m) => Number(m[1])));

  for (const [objectId, pieces] of plan) {
    const block = objectBlocks(out).get(objectId);
    if (block) {
      const head = block.slice(0, block.indexOf("<part") < 0 ? block.length : block.indexOf("<part"));
      const name = names.get(objectId) || `object ${objectId}`;
      const replacement = pieces.map((piece, i) => {
        const label = `${name} (part ${i + 1} of ${pieces.length})`;
        const start = head
          .replace(/<object id="[^"]+"\s*>/, `<object id="${piece.wrapperId}">`)
          .replace(/(<metadata key="name" value=")[^"]*(")/, `$1${label}$2`)
          .replace(/<metadata face_count="\d+"\/>/, `<metadata face_count="${piece.faces}"/>`)
          .trimEnd();
        return [
          start,
          `    <part id="${piece.meshId}" subtype="normal_part">`,
          `      <metadata key="name" value="${label}"/>`,
          `      <metadata key="matrix" value="${IDENTITY_16}"/>`,
          `      <mesh_stat face_count="${piece.faces}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>`,
          "    </part>",
          "  </object>",
        ].join("\n");
      }).join("\n  ");
      out = out.replace(block, replacement);
    }

    // The plate places one instance of each piece, where the one it came from stood.
    const instance = new RegExp(`<model_instance>\\s*<metadata key="object_id" value="${objectId}"\\s*/>[\\s\\S]*?</model_instance>`);
    const found = instance.exec(out);
    if (found) {
      out = out.replace(found[0], pieces.map((piece) => [
        "<model_instance>",
        `      <metadata key="object_id" value="${piece.wrapperId}"/>`,
        '      <metadata key="instance_id" value="0"/>',
        `      <metadata key="identify_id" value="${++identify}"/>`,
        "    </model_instance>",
      ].join("\n")).join("\n    "));
    }

    const assembled = new RegExp(`<assemble_item object_id="${objectId}"[^>]*/>`);
    if (assembled.test(out)) {
      out = out.replace(assembled, pieces.map((piece) =>
        `<assemble_item object_id="${piece.wrapperId}" instance_id="0" transform="${IDENTITY_12}" offset="0 0 0" />`,
      ).join("\n   "));
    }
  }
  return out;
}
