/**
 * A design laid out for a 256 mm Bambu bed can need two plates on the 5M's 220 mm one, and Flash Studio flags a
 * crowded second plate as laid over the boundary. So every plate becomes its own file: pt1-NAME, pt2-NAME.
 *
 * A project the slicer lays out over several plates is cut into one project per plate: the build keeps only that
 * plate's items, model_settings keeps only that plate (renumbered 1) and its objects, and every slice result goes, so
 * the slicer arranges and slices each copy afresh on one bed.
 */
import type { Zip } from "./zip.js";

const MODEL = "3D/3dmodel.model";
const SETTINGS = "Metadata/model_settings.config";
const LAYERS = "Metadata/custom_gcode_per_layer.xml";

/** Each plate's number and the object ids placed on it, in plate order. */
export function platesOf(settingsXml: string): Array<{ plate: number; objects: string[] }> {
  return [...settingsXml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => {
    const body = m[1] ?? "";
    const plate = Number(/key="plater_id" value="(\d+)"/.exec(body)?.[1] ?? 0);
    const objects = [...body.matchAll(/key="object_id" value="(\d+)"/g)].map((o) => o[1] ?? "");
    return { plate, objects };
  });
}

/** The build with only the items of these objects. */
export function keepItems(buildXml: string, keep: ReadonlySet<string>): string {
  return buildXml.replace(/\s*(<item\b[^>]*?\/>|<item\b[^>]*?>[\s\S]*?<\/item>)/g, (whole: string, item: string) => {
    const id = /\bobjectid="(\d+)"/.exec(item)?.[1] ?? "";
    return keep.has(id) ? whole : "";
  });
}

/** model_settings with one plate, renumbered 1, and only its objects. */
export function keepPlate(settingsXml: string, plate: number, keep: ReadonlySet<string>): string {
  return settingsXml
    .replace(/\s*<plate>[\s\S]*?<\/plate>/g, (whole: string) => {
      if (Number(/key="plater_id" value="(\d+)"/.exec(whole)?.[1] ?? 0) !== plate) return "";
      return whole
        .replace(/(key="plater_id" value=")\d+(")/, "$11$2")
        .replace(/\s*<metadata key="(gcode_file|thumbnail_file|thumbnail_no_light_file|top_file|pick_file|pattern_bbox_file)"[^>]*\/>/g, "");
    })
    .replace(/\s*<object id="(\d+)">[\s\S]*?<\/object>/g, (whole: string, id: string) => (keep.has(id) ? whole : ""))
    .replace(/\s*<assemble_item\b[^>]*?object_id="(\d+)"[^>]*?\/>/g, (whole: string, id: string) => (keep.has(id) ? whole : ""));
}

/**
 * The layer list with only this plate's pauses and G-code, renumbered 1, or null when that plate has none. The slicer
 * files them by plate id (bbs_3mf.cpp), so a pt2 left with the whole list got plate 1's pauses and lost its own.
 */
export function keepPlateLayers(layersXml: string, plate: number): string | null {
  let kept = false;
  const next = layersXml.replace(/\s*<plate>[\s\S]*?<\/plate>/g, (whole: string) => {
    if (Number(/<plate_info\s+id="(\d+)"/.exec(whole)?.[1] ?? 0) !== plate) return "";
    kept = /<layer\b/.test(whole);
    return whole.replace(/(<plate_info\s+id=")\d+(")/, "$11$2");
  });
  return kept ? next : null;
}

/** The members to change so a copy of this project holds one plate and no slice results. */
export function onePlateChanges(zip: Zip, plate: number, objects: readonly string[]): Record<string, Buffer | null> {
  const keep = new Set(objects);
  const changes: Record<string, Buffer | null> = {};
  // Only the build is decoded: the root model file may carry the meshes inline and run to hundreds of megabytes.
  const model = zip.read(MODEL);
  const start = model.indexOf("<build");
  const end = start < 0 ? -1 : model.indexOf("</build>", start);
  if (start < 0 || end < 0) throw new Error(`${MODEL}: no <build> to cut by plate`);
  const build = model.subarray(start, end + "</build>".length).toString("utf8");
  changes[MODEL] = Buffer.concat([
    model.subarray(0, start), Buffer.from(keepItems(build, keep)), model.subarray(end + "</build>".length),
  ]);
  if (zip.has(SETTINGS)) changes[SETTINGS] = Buffer.from(keepPlate(zip.readText(SETTINGS), plate, keep));
  if (zip.has(LAYERS)) {
    const layers = keepPlateLayers(zip.readText(LAYERS), plate);
    changes[LAYERS] = layers === null ? null : Buffer.from(layers);
  }
  for (const name of zip.names()) {
    if (/^Metadata\/(plate_\d+\.(gcode|gcode\.md5|json|png)|plate_no_light_\d+\.png|top_\d+\.png|pick_\d+\.png|slice_info\.config)$/.test(name)) {
      changes[name] = null;
    }
  }
  const rels = "Metadata/_rels/model_settings.config.rels";
  if (zip.has(rels)) changes[rels] = null;
  return changes;
}
