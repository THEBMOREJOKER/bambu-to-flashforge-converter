/**
 * What a 3MF says about itself: the designer's own instructions, the slicer settings the project carries,
 * and the per-object settings beside them. The instructions are the part nothing used to read — a project
 * can say "base 15% infill, figure 0%" in prose and encode none of it, so the plate comes out 15% throughout.
 */
import type { Zip } from "./zip.js";

export const NOTE_KEYS = ["Title", "Designer", "Description", "ProfileTitle", "ProfileDescription"] as const;
export type NoteKey = (typeof NOTE_KEYS)[number];
export type Notes = Partial<Record<NoteKey, string>>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  mdash: "—", ndash: "–", hellip: "…", deg: "°",
};

function unescapeOnce(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * A note out of 3MF metadata is HTML-escaped markup, and a MakerWorld export escapes the escaping more than
 * once — two passes still left a literal `&nbsp;` on screen. Unescape until it stops changing, then drop the
 * markup, keeping its line breaks as ' · '.
 */
export function cleanNote(text: string): string {
  let t = text ?? "";
  for (let i = 0; i < 4; i++) {
    const next = unescapeOnce(t);
    if (next === t) break;
    t = next;
  }
  t = t.replace(/<br\s*\/?>|<\/p>|<\/h\d>|<\/li>|<\/div>/gi, " · ");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/[ \t ]+/g, " ");
  return t.replace(/(\s*·\s*)+/g, " · ").replace(/^[\s·]+|[\s·]+$/g, "");
}

/**
 * What the designer wrote about printing this model, from the head of 3D/3dmodel.model. Reads a megabyte of
 * compressed bytes, not the whole model.
 */
export function notes(zip: Zip): Notes {
  if (!zip.has("3D/3dmodel.model")) return {};
  const head = zip.readPrefixText("3D/3dmodel.model");
  const found: Notes = {};
  for (const key of NOTE_KEYS) {
    const m = new RegExp(`<metadata name="${key}"\\s*>([^<]*)`).exec(head);
    if (!m) continue;
    const value = cleanNote(m[1] ?? "");
    if (value) found[key] = value;
  }
  return found;
}

/** Every value a 3MF settings file carries is a string, or one string per filament slot. */
export type ProjectSettings = Record<string, string | string[]>;

export function projectSettings(zip: Zip): ProjectSettings | null {
  return zip.has("Metadata/project_settings.config")
    ? zip.readJson<ProjectSettings>("Metadata/project_settings.config")
    : null;
}

export function modelSettings(zip: Zip): string | null {
  return zip.has("Metadata/model_settings.config") ? zip.readText("Metadata/model_settings.config") : null;
}

/** The first slot is the one that prints on a single-extruder machine. */
export function firstSlot(value: string | string[] | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

export interface ObjectSetting {
  objectId: string;
  name: string;
  extruder: string;
  /** How many parts the object is made of. Taken out as a mesh, they become one piece. */
  parts: number;
  /** Per-object overrides the GUI and the converter care about, e.g. sparse_infill_density. */
  settings: Record<string, string>;
}

/** Per-object metadata out of Metadata/model_settings.config — names, extruder slots, and any overrides. */
export function objectSettings(zip: Zip): ObjectSetting[] {
  const xml = modelSettings(zip);
  if (!xml) return [];
  const out: ObjectSetting[] = [];
  const objectRe = /<object id="([^"]+)"\s*>([\s\S]*?)<\/object>/g;
  for (let m = objectRe.exec(xml); m; m = objectRe.exec(xml)) {
    const id = m[1] ?? "";
    const body = m[2] ?? "";
    const head = body.split("<part", 1)[0] ?? "";
    const settings: Record<string, string> = {};
    const metaRe = /<metadata key="([^"]+)" value="([^"]*)"\s*\/>/g;
    for (let k = metaRe.exec(head); k; k = metaRe.exec(head)) {
      settings[k[1] ?? ""] = k[2] ?? "";
    }
    const { name = "", extruder = "", ...rest } = settings;
    out.push({ objectId: id, name, extruder, parts: body.match(/<part\b/g)?.length ?? 0, settings: rest });
  }
  return out;
}

export interface PlateNames { xml: string; names: string[]; }

/**
 * Flash Studio 1.7.9's command line dies on a plate that has a name: a segfault straight after the plate is
 * created, every time, and the same copy with only the name blanked slices clean. A name is a label and changes
 * nothing about the print, so it comes out of the copy the slicer reads — and is said, because a designer who names
 * plates is telling you which one is which.
 */
export function blankPlateNames(modelXml: string): PlateNames {
  const names: string[] = [];
  const xml = modelXml.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>/g, (plate: string) => {
    const id = /<metadata key="plater_id" value="([^"]*)"/.exec(plate)?.[1] || "?";
    return plate.replace(/(<metadata key="plater_name" value=")([^"]*)(")/, (whole: string, head: string, name: string, tail: string) => {
      if (!name) return whole;
      names.push(`plate ${id}: ${unescapeOnce(name)}`);
      return `${head}${tail}`;
    });
  });
  return { xml, names };
}

export interface Collapse {
  /** Members to write over the project's own (null drops one); empty when the project already prints from one slot. */
  members: Record<string, Buffer | null>;
  /** Objects and parts moved onto slot 1. */
  moved: string[];
  /** Tool and colour changes taken out of the layer list. */
  dropped: string[];
  /** Pauses and custom G-code left in place. */
  kept: string[];
}

const EXTRUDER = /(<metadata key="extruder" value=")(\d+)("\s*\/>)/g;
// Orca's CustomGCode::Type, in order: ColorChange, PausePrint, ToolChange, Template, Custom.
const LAYER_KIND: Record<string, string> = {
  "0": "colour change", "1": "pause", "2": "tool change", "3": "template", "4": "custom G-code",
};

function attr(tag: string, name: string): string {
  // Bambu writes `error_code ="…"` with a space before the equals sign.
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1] ?? "";
}

/**
 * The 5M has one extruder. A Bambu project can put an object on AMS slot 10 and switch to slot 2 at a layer;
 * the slicer writes both as T commands the printer cannot follow. Every object and part goes onto slot 1, and
 * every tool or colour change comes out of the layer list — a pause at a layer is for the person printing to add.
 * Painted colour regions live in the mesh and are not touched here; the check fails a file that still has them.
 */
export function collapseFilaments(zip: Zip): Collapse {
  const out: Collapse = { members: {}, moved: [], dropped: [], kept: [] };

  const xml = modelSettings(zip);
  if (xml) {
    const next = xml.replace(/<object id="([^"]+)"\s*>([\s\S]*?)<\/object>/g, (whole: string, id: string, body: string) => {
      const name = /<metadata key="name" value="([^"]*)"/.exec(body)?.[1] || `object ${id}`;
      const slots = new Set<string>();
      const fixed = body.replace(EXTRUDER, (tag: string, head: string, slot: string, tail: string) => {
        // 0 is "follow the object"; 1 is already the only slot there is.
        if (slot === "0" || slot === "1") return tag;
        slots.add(slot);
        return `${head}1${tail}`;
      });
      if (!slots.size) return whole;
      out.moved.push(`${name}: slot ${[...slots].join(", ")} → slot 1`);
      return `${whole.slice(0, whole.length - body.length - "</object>".length)}${fixed}</object>`;
    });
    if (next !== xml) out.members["Metadata/model_settings.config"] = Buffer.from(next);
  }

  const layersName = "Metadata/custom_gcode_per_layer.xml";
  if (zip.has(layersName)) {
    const layers = zip.readText(layersName);
    const next = layers.replace(/[ \t]*<layer\b[^>]*\/>[ \t]*\r?\n?/g, (tag: string) => {
      const type = attr(tag, "type");
      const kind = LAYER_KIND[type] ?? (attr(tag, "gcode") || `type ${type}`);
      const z = Number.parseFloat(attr(tag, "top_z"));
      const where = Number.isFinite(z) ? `at ${z.toFixed(2)} mm` : "at an unknown height";
      if (type === "0" || type === "2") {
        const slot = attr(tag, "extruder");
        const colour = attr(tag, "color");
        out.dropped.push(`${kind}${slot ? ` to slot ${slot}` : ""}${colour ? ` (${colour})` : ""} ${where}`);
        return "";
      }
      out.kept.push(`${kind} ${where}`);
      return tag;
    });
    // With nothing left in it, the file goes, as it is absent from a project Flash Studio saves itself.
    if (next !== layers) out.members[layersName] = /<layer\b/.test(next) ? Buffer.from(next) : null;
  }
  return out;
}

// Lists shaped by the slot count rather than one entry per slot: n × n flush volumes, a load/unload pair per slot,
// and [process, one per slot, printer].
const SLOT_SHAPED: Record<string, (n: number) => number> = {
  flush_volumes_matrix: (n) => n * n,
  flush_volumes_vector: (n) => 2 * n,
  different_settings_to_system: (n) => n + 2,
  inherits_group: (n) => n + 2,
};

/**
 * Keys a project carries that the slicer copies into the G-code it writes, as the text of the file's own metadata.
 * Flash Studio escapes those values for XML but not for the end of a line, and it moves that metadata above the start
 * block, so a line break inside one of them becomes a command that runs before the first heat and the first home
 * (read in the 1.7.15 source, 2026-09-23). Homing undoes a shifted origin; SET_GCODE_OFFSET it does not.
 */
const HEADER_KEYS = new Set([
  "filament_colour", "filament_color", "filament_type", "filament_ids", "filament_settings_id", "filament_vendor",
  "print_settings_id", "printer_settings_id", "printer_model", "printer_variant",
]);

export interface Broken { key: string; slot: number | null; text: string; }

/**
 * Takes the line breaks and other control characters out of those values, in the copy the slicer reads. What is left
 * is the value a person meant — a colour, a name — and what is gone could not have been printed anyway. Everything
 * removed is reported: this is a defect in the file, not a detail to swallow.
 */
export function stripBreaks(settings: ProjectSettings): { settings: ProjectSettings; found: Broken[] } {
  const found: Broken[] = [];
  const out: ProjectSettings = {};
  const clean = (value: string, key: string, slot: number | null): string => {
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u001f\u007f]/.test(value)) return value;
    found.push({ key, slot, text: value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60) });
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  };
  for (const [key, value] of Object.entries(settings)) {
    if (!HEADER_KEYS.has(key)) { out[key] = value; continue; }
    if (typeof value === "string") out[key] = clean(value, key, null);
    else if (Array.isArray(value)) {
      out[key] = value.map((v, i) => (typeof v === "string" ? clean(v, key, i + 1) : v));
    } else out[key] = value;
  }
  return { settings: out, found };
}

export interface OneSlot { settings: ProjectSettings; modelXml: string | null; from: number; }

/**
 * A single-extruder project has one filament slot. A Bambu project arrives with one per AMS slot — often eleven or
 * sixteen — and Flash Studio lists every one. With every object already on slot 1, a list that holds one entry per
 * slot keeps its first. With only two slots that length is too common to trust, so only filament keys are cut then.
 * Keys the flattened machine and process presets carry are left alone: the slicer replaces those anyway.
 */
export function oneSlot(
  settings: ProjectSettings, modelXml: string | null, filamentKeys: Set<string>, presetKeys: Set<string>,
): OneSlot {
  const ids = settings["filament_settings_id"];
  const n = Array.isArray(ids) ? ids.length : 1;
  if (n <= 1) return { settings, modelXml, from: n };
  const out: ProjectSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    const shaped = SLOT_SHAPED[key];
    const filamentKey = filamentKeys.has(key) || key.startsWith("filament_");
    if (!Array.isArray(value)) {
      out[key] = value;
    } else if (shaped && value.length === shaped(n)) {
      out[key] = key === "flush_volumes_matrix" ? value.slice(0, 1)
        : key === "flush_volumes_vector" ? value.slice(0, 2)
          : [value[0] ?? "", value[1] ?? "", value[n + 1] ?? ""];
    } else if (value.length === n && (filamentKey || (n > 2 && !presetKeys.has(key)))) {
      out[key] = value.slice(0, 1);
    } else {
      out[key] = value;
    }
  }
  const xml = modelXml?.replace(
    /(<metadata key="filament_maps" value=")([^"]*)(")/g,
    (_whole: string, head: string, maps: string, tail: string) => `${head}${maps.trim().split(/\s+/)[0] || "1"}${tail}`,
  ) ?? null;
  return { settings: out, modelXml: xml, from: n };
}

// Bambu's bookkeeping for a machine that takes more than one kind of nozzle: the kinds, and entries per slot per kind.
const VARIANT_KEYS = [
  "extruder_ams_count", "extruder_variant_list", "filament_extruder_variant", "filament_nozzle_map",
  "filament_self_index", "filament_volume_map", "print_extruder_id", "print_extruder_variant", "printer_extruder_id",
  "printer_extruder_variant",
];

export interface Variants {
  /** The kinds of nozzle the project names (Bambu's "extruder variants"). */
  kinds: string[];
  /** The keys that come out of the copy the slicer reads. */
  keys: string[];
}

/**
 * From Bambu Studio 2.04 a P1S project names two kinds of nozzle, Standard and High Flow, and keeps its filament
 * lists one entry per slot per kind: eight for four slots. The 5M's presets name no kinds at all, so the project's
 * lists reach the slicer as they are; Flash Studio 1.7.9's command line takes the 5M for a machine with two kinds of
 * extruder and dies pairing them with the one filament left after the collapse — a segfault in
 * update_values_to_printer_extruders_for_multiple_filaments, or earlier, before the filament presets load, on a
 * project with many slots. A project that names one kind (Bambu Studio 2.00, 2.02) or none (1.10) converts as it is
 * and is left alone. With two or more, these keys come out of the copy the slicer reads, the slicer writes its own
 * one-kind values in their place, and what came out is said. Keys a flattened preset carries stay: the slicer
 * replaces those anyway.
 */
export function extruderVariants(settings: ProjectSettings, presetKeys: Set<string>): Variants {
  const kinds = new Set<string>();
  for (const key of ["printer_extruder_variant", "print_extruder_variant", "filament_extruder_variant", "extruder_variant_list"]) {
    const value = settings[key];
    for (const entry of Array.isArray(value) ? value : value ? [value] : []) {
      for (const kind of entry.split(",")) if (kind.trim()) kinds.add(kind.trim());
    }
  }
  const keys = kinds.size > 1 ? VARIANT_KEYS.filter((key) => key in settings && !presetKeys.has(key)) : [];
  return { kinds: [...kinds], keys };
}

/** What the slicer said about the plates it sliced, out of Metadata/slice_info.config. */
export function sliceWarnings(zip: Zip): string[] {
  const name = "Metadata/slice_info.config";
  if (!zip.has(name)) return [];
  return [...zip.readText(name).matchAll(/<warning\b([^>]*)>/g)]
    .map((m) => {
      const msg = attr(m[1] ?? "", "msg");
      const code = attr(m[1] ?? "", "error_code");
      return msg && code ? `${msg} (${code})` : msg;
    })
    .filter(Boolean);
}

/**
 * The members that make a project "already sliced": each plate's G-code and its checksum, the relationship that
 * points at them, and the plate's slice results. Flash Studio slices again when it opens a project, so the copy to
 * hand over is the one without them — the shape Flash Studio itself saves.
 */
export function unslicedChanges(zip: Zip): Record<string, Buffer | null> {
  const changes: Record<string, Buffer | null> = {};
  for (const name of zip.names()) {
    if (/^Metadata\/plate_\d+\.gcode(\.md5)?$/.test(name)) changes[name] = null;
  }
  const rels = "Metadata/_rels/model_settings.config.rels";
  if (zip.has(rels)) {
    const xml = zip.readText(rels);
    const kept = xml.replace(/\s*<Relationship\b[^>]*Target="\/Metadata\/plate_\d+\.gcode"[^>]*\/>/g, "");
    if (kept !== xml) changes[rels] = /<Relationship\b/.test(kept) ? Buffer.from(kept) : null;
  }
  // The headless slicer cannot draw the plate thumbnails its package relationships name; a link to a missing
  // member is an error in Flash Studio's log, so it goes.
  const root = "_rels/.rels";
  if (zip.has(root)) {
    const xml = zip.readText(root);
    const kept = xml.replace(/\s*<Relationship\b[^>]*Target="\/([^"]+)"[^>]*\/>/g, (tag: string, target: string) =>
      zip.has(target) ? tag : "");
    if (kept !== xml) changes[root] = Buffer.from(kept);
  }
  const info = "Metadata/slice_info.config";
  if (zip.has(info)) {
    const xml = zip.readText(info);
    const kept = xml.replace(/\s*<plate>[\s\S]*?<\/plate>/g, "");
    if (kept !== xml) changes[info] = Buffer.from(kept);
  }
  return changes;
}

/** Bambu writes filament indices as 0 and a couple of counts as -1; Orca 2.3.2 refuses the file outright. */
export function outOfRangeKeys(settings: ProjectSettings): string[] {
  return Object.entries(settings)
    .filter(([key, value]) => {
      const v = firstSlot(value);
      return (key.endsWith("_filament") && v === "0") ||
        ((key === "tree_support_wall_count" || key === "raft_first_layer_expansion") && v === "-1");
    })
    .map(([key]) => key)
    .sort();
}
