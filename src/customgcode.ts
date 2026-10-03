/**
 * A designer's own G-code at a layer — a Custom item in the project's layer list — kept on `--keep-custom-gcode`.
 *
 * A designer types it for a reason: a temperature tower steps the nozzle every few layers, a magnet or a nut goes in
 * at a height, a fan changes part way up. The slicer's command line erases every Custom item when it runs with
 * `--skip-modified-gcodes` (Orca-Flashforge.cpp, 1.7.15, "skip_modified_gcodes: remove custom gcodes"), and convert
 * needs that switch: it is what keeps a Bambu project's own start and end G-code off the 5M. So the items are put back
 * here, into every project convert saves, where Flash Studio writes them when it slices; and they are placed into every
 * proof slice the way Flash Studio places them, so the check reads each line of them before anything is saved.
 */
import { attr, unescapeOnce } from "./threemf.js";

export const LAYERS = "Metadata/custom_gcode_per_layer.xml";

export interface CustomItem {
  /** The plate the item belongs to, as the layer list numbers it. */
  plate: number;
  /** The height the designer put it at, mm. */
  z: number;
  /** What runs, as the slicer writes it. */
  text: string;
  /** The designer's own `<layer …/>` tag, written back as it was. */
  tag: string;
}

/** An item and the layer of a slice that carries it; `layer` is null when Flash Studio writes nothing for it. */
export interface Placement { item: CustomItem; layer: number | null; why?: string; }

// Orca's CustomGCode::Type, in order: ColorChange, PausePrint, ToolChange, Template, Custom. A list from PrusaSlicer 2.2
// or older has no type, and the slicer reads one from its G-code (bbs_3mf.cpp).
function typeOf(tag: string): string {
  if (/\btype\s*=/.test(tag)) return attr(tag, "type");
  const old = attr(tag, "gcode");
  return old === "M600" ? "0" : old === "M601" ? "1" : old === "tool_change" ? "2" : "4";
}

function blocks(xml: string): Array<{ whole: string; plate: number }> {
  return [...xml.matchAll(/<plate>[\s\S]*?<\/plate>/g)].map((m) => ({
    whole: m[0],
    plate: Number(/<plate_info\s+id\s*=\s*"(\d+)"/.exec(m[0])?.[1] ?? 0),
  }));
}

/** Every Custom item in a layer list, by plate, in the order the list holds them. */
export function customItems(xml: string): CustomItem[] {
  const out: CustomItem[] = [];
  for (const { whole, plate } of blocks(xml)) {
    for (const [tag] of whole.matchAll(/<layer\b[^>]*\/>/g)) {
      if (typeOf(tag) !== "4") continue;
      const typed = /\btype\s*=/.test(tag);
      out.push({ plate, z: Number.parseFloat(attr(tag, "top_z")), text: unescapeOnce(attr(tag, typed ? "extra" : "gcode")), tag });
    }
  }
  return out;
}

/** The heights of every pause and Custom item of a plate: they share the one slot Flash Studio gives each layer. */
function layerEvents(xml: string | null, plate: number): Array<{ z: number; custom: boolean; tag: string }> {
  const out: Array<{ z: number; custom: boolean; tag: string }> = [];
  for (const block of xml ? blocks(xml) : []) {
    if (block.plate !== plate) continue;
    for (const [tag] of block.whole.matchAll(/<layer\b[^>]*\/>/g)) {
      const type = typeOf(tag);
      if (type === "2") continue; // a tool change never takes a layer's slot (ToolOrdering.cpp)
      out.push({ z: Number.parseFloat(attr(tag, "top_z")), custom: type === "4", tag });
    }
  }
  return out;
}

/**
 * The layer list with these items in the plate given, sorted by height with what the plate already holds, as the
 * slicer expects them. A plate with no list gets one, and a project with no list file gets one. An item already there
 * is not written twice.
 */
export function withCustomItems(xml: string | null, plate: number, items: readonly CustomItem[]): string {
  const base = xml ?? '<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n</custom_gcodes_per_layer>\n';
  const sortLayers = (tags: string[]) =>
    [...tags].sort((a, b) => Number.parseFloat(attr(a, "top_z")) - Number.parseFloat(attr(b, "top_z")));
  const existing = blocks(base).find((b) => b.plate === plate);
  if (!existing) {
    const body = sortLayers(items.map((i) => i.tag)).join("\n");
    const block = `<plate>\n<plate_info id="${plate}"/>\n${body}\n<mode value="SingleExtruder"/>\n</plate>\n`;
    return base.replace(/<\/custom_gcodes_per_layer>/, () => `${block}</custom_gcodes_per_layer>`);
  }
  const present = [...existing.whole.matchAll(/<layer\b[^>]*\/>/g)].map((m) => m[0]);
  const all = sortLayers([...present, ...items.map((i) => i.tag).filter((t) => !present.includes(t))]);
  const stripped = existing.whole.replace(/[ \t]*<layer\b[^>]*\/>[ \t]*\r?\n?/g, "");
  const at = stripped.search(/<mode\b|<\/plate>/);
  const next = `${stripped.slice(0, at)}${all.join("\n")}\n${stripped.slice(at)}`;
  return base.replace(existing.whole, () => next); // a function: the designer's text may hold a "$"
}

/** The print height of every layer of a slice, from its `;Z:` lines, in order. */
export function layerHeights(gcode: string): number[] {
  const out: number[] = [];
  for (const m of gcode.matchAll(/^;Z:([0-9.]+)\s*$/gm)) {
    const z = Number.parseFloat(m[1] ?? "");
    if (Number.isFinite(z) && z !== out.at(-1)) out.push(z);
  }
  return out;
}

/**
 * Which layer Flash Studio writes each Custom item at, by the slicer's own rule (ToolOrdering::assign_custom_gcodes,
 * 1.7.15): walking down from the top layer, an event goes to the layer nearest its height; above the top it goes to
 * the top layer, under half the first layer it goes nowhere, and a layer takes one event — a pause or a Custom item —
 * so a second one at the same layer is not written. Pauses are counted because they share that slot.
 */
export function placeItems(heights: readonly number[], events: ReadonlyArray<{ z: number; custom: boolean; tag: string }>,
  items: readonly CustomItem[]): Placement[] {
  const sorted = [...events].sort((a, b) => a.z - b.z);
  const layerOf = new Map<string, number>();
  let next = sorted.length - 1;
  let above = Number.NEGATIVE_INFINITY;
  for (let i = heights.length - 1; i >= 0 && next >= 0; i--) {
    const z = heights[i] ?? 0;
    while (next >= 0 && above > z && (sorted[next]?.z ?? 0) > 0.5 * (z + above)) next--;
    above = z;
    if (next < 0) break;
    const below = i > 0 ? heights[i - 1] ?? 0 : 0;
    const event = sorted[next];
    if (event && event.z > 0.5 * (below + z)) {
      layerOf.set(event.tag, z);
      next--;
    }
  }
  return items.map((item) => {
    const layer = layerOf.get(item.tag);
    if (layer !== undefined) return { item, layer };
    const why = !heights.length ? "the slice has no layer marks to place it by"
      : item.z <= 0.5 * (heights[0] ?? 0)
      ? "it sits under the first layer, so Flash Studio writes nothing for it"
      : "another pause or G-code of the designer's takes that layer, and Flash Studio writes one per layer";
    return { item, layer: null, why };
  });
}

/**
 * The slice with each placed item written where Flash Studio writes it: after the layer change, at the fan-speed mark
 * the slicer leaves in every layer, under its own `;CUSTOM_GCODE` tag (GCode.cpp, process_layer, 1.7.15). A slice
 * without that mark gets it after the layer's `;Z:` and `;HEIGHT:` lines. This copy exists for the check only; it is
 * never sent and never saved.
 */
export function placeInSlice(gcode: string, placements: readonly Placement[]): string {
  const texts = new Map<number, string[]>();
  for (const p of placements) {
    if (p.layer !== null) texts.set(p.layer, [...(texts.get(p.layer) ?? []), ...p.item.text.split(/\r?\n/)]);
  }
  if (!texts.size) return gcode;
  const lines = gcode.split("\n");
  const after = new Map<number, string[]>();
  for (let i = 0; i < lines.length && texts.size; i++) {
    const z = /^;Z:([0-9.]+)\s*$/.exec(lines[i] ?? "");
    if (!z) continue;
    const key = Number.parseFloat(z[1] ?? "");
    const text = texts.get(key);
    if (!text) continue;
    texts.delete(key);
    let at = /^;HEIGHT:/.test(lines[i + 1] ?? "") ? i + 1 : i;
    for (let j = i + 1; j < lines.length && !/^;LAYER_CHANGE\b/.test(lines[j] ?? ""); j++) {
      if (/^;_SET_FAN_SPEED_CHANGING_LAYER\b/.test(lines[j] ?? "")) {
        at = j;
        break;
      }
    }
    after.set(at, [";CUSTOM_GCODE", ...text]);
  }
  const out: string[] = [];
  lines.forEach((line, i) => {
    out.push(line);
    const add = after.get(i);
    if (add) out.push(...add);
  });
  return out.join("\n");
}

/** Where each item lands in this slice, given the plate's whole layer list (pauses included). */
export function placementsFor(gcode: string, layersXml: string | null, plate: number, items: readonly CustomItem[]): Placement[] {
  const mine = items.filter((i) => i.plate === plate);
  if (!mine.length) return [];
  const events = [...layerEvents(layersXml, plate).filter((e) => !e.custom), ...mine.map((i) => ({ z: i.z, custom: true, tag: i.tag }))];
  return placeItems(layerHeights(gcode), events, mine);
}
