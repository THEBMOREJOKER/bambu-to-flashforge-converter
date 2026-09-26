/**
 * Same size, just thicker — for a part that comes out flimsy at the size its designer drew it.
 *
 * Flash Studio's command line scales a model by one float in every direction (`--scale factor`) and has no per-axis
 * scale at all: `--rotate`, `--rotate-x`, `--rotate-y`, `--orient`, `--convert-unit`, and that one factor. Scaling the
 * whole part up is a different thing to ask for, and on a 220 mm bed there is not always room for it. So the factor
 * goes on the **world Z of every build item** in the copy the slicer reads: the part keeps its footprint to the micron
 * and becomes as many times as thick as it was.
 *
 * The matrix is scaled, never the mesh. A build item's transform is twelve numbers in the root model file — a few
 * kilobytes, while the meshes beside it can run to hundreds of megabytes — so the mesh is measured once and then
 * copied through untouched. Every object keeps the height it stood at: the item's own Z translation scales with the
 * mesh under it, and anything the project had floating above the bed is seated back where it was.
 *
 * What this does not do is combine with taking a welded object apart. `separate.ts` rewrites the same build items, and
 * the pieces it writes stand on placements this pass has no measurement for; rather than risk an object placed half
 * through the bed, the two refuse to run together and the way round is named.
 */
import {
  formatTransform, liftZ, parseTransform, placedObjects, scaleWorldZ,
} from "./geometry.js";
import { objectSettings } from "./threemf.js";
import type { Zip } from "./zip.js";

const MODEL = "3D/3dmodel.model";
const SETTINGS = "Metadata/model_settings.config";

export interface ThickenedObject {
  objectId: string;
  name: string;
  before: [number, number, number];
  after: [number, number, number];
}

export interface Thicken {
  factor: number;
  /** Every object on the plate, as it stood and as it will stand. */
  objects: ThickenedObject[];
  /** The tallest thing on the plate afterwards — the bed's Z is the machine's limit, not the project's. */
  maxZ: number;
  /** The members that have to change, given the per-object settings as they stand after every other change. */
  members(zip: Zip, modelSettingsXml: string | null): Record<string, Buffer>;
}

/**
 * Each `<item>` of a build, with world Z scaled and its base put back at the height it stood at. `minZ` is the
 * measured floor of the item of that index; a missing one is taken as the bed, which is where a plated project
 * puts every object anyway.
 */
export function thickenItems(buildXml: string, factor: number, minZ: number[]): string {
  let index = 0;
  return buildXml.replace(/<item\b[^>]*?\/>|<item\b[^>]*?>[\s\S]*?<\/item>/g, (item: string) => {
    const seat = minZ[index++] ?? 0;
    return item.replace(/(\btransform=")([^"]*)(")/, (whole: string, head: string, text: string, tail: string) => {
      if (!text.trim()) return whole;
      // The base of a scaled object rises by its own floor times the factor; put it back where it stood.
      const scaled = liftZ(scaleWorldZ(parseTransform(text), factor), seat - seat * factor);
      return `${head}${formatTransform(scaled)}${tail}`;
    });
  });
}

/** The assembly view's own copy of where an object sits. Bookkeeping, but it is kept in step rather than left wrong. */
export function thickenAssembly(settingsXml: string, factor: number): string {
  return settingsXml.replace(/<assemble_item\b[^>]*?\/>/g, (tag: string) =>
    tag.replace(/(\btransform=")([^"]*)(")/, (whole: string, head: string, text: string, tail: string) =>
      (text.trim() ? `${head}${formatTransform(scaleWorldZ(parseTransform(text), factor))}${tail}` : whole)));
}

export async function thicken(zip: Zip, factor: number): Promise<Thicken | null> {
  if (!zip.has(MODEL)) return null;
  const placed = await placedObjects(zip);
  if (!placed.length) return null;
  const names = new Map(objectSettings(zip).map((o) => [o.objectId, o.name]));

  const objects: ThickenedObject[] = placed.map((o) => ({
    objectId: o.objectId,
    name: names.get(o.objectId) || `object ${o.objectId}`,
    before: [o.size[0], o.size[1], o.size[2]],
    after: [o.size[0], o.size[1], o.size[2] * factor],
  }));
  const maxZ = Math.max(...placed.map((o) => o.min[2] + o.size[2] * factor));
  const floors = placed.map((o) => o.min[2]);

  const members = (source: Zip, current: string | null): Record<string, Buffer> => {
    // Only the build is decoded: the root model file may carry the meshes inline and run to hundreds of megabytes.
    const model = source.read(MODEL);
    const start = model.indexOf("<build");
    const end = start < 0 ? -1 : model.indexOf("</build>", start);
    if (start < 0 || end < 0) throw new Error(`${MODEL}: no <build> to scale`);
    const build = model.subarray(start, end + "</build>".length).toString("utf8");
    const out: Record<string, Buffer> = {
      [MODEL]: Buffer.concat([
        model.subarray(0, start),
        Buffer.from(thickenItems(build, factor, floors)),
        model.subarray(end + "</build>".length),
      ]),
    };
    const xml = current ?? (source.has(SETTINGS) ? source.readText(SETTINGS) : null);
    if (xml && xml.includes("<assemble_item")) out[SETTINGS] = Buffer.from(thickenAssembly(xml, factor));
    return out;
  };

  return { factor, objects, maxZ, members };
}
