/**
 * Flash Studio's presets, flattened. Its CLI does not walk a preset's `inherits` chain — given a vendor JSON it
 * applies that file's own keys and lets the rest fall to built-in defaults, or to whatever a project carries, so
 * walls ran at 60 mm/s instead of the preset's 200. Every chain is resolved here first, child over parent, and
 * the flattened file is what the slicer is handed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { BED_TYPE, LIBRARY, PROFILES, SYSTEM } from "./machine.js";

export type Preset = Record<string, unknown>;
export type PresetKind = "machine" | "process" | "filament";

export interface Flattened {
  flat: Preset;
  /** Child first, then each parent it inherits from — the line printed before a slice. */
  chain: string[];
}

/**
 * A vendor's index, `system/<Vendor>.json`: every preset of one kind it ships, and the file that holds it. The
 * library keeps its bases under filament/base/, which only the index says. Flashforge's own index is not to be
 * trusted alone — it lists `fdm_flashforge_common` at `fdm_adventurer3_common.json` — so a file named for the preset
 * wins, and an index entry counts only when the file it names carries that name.
 */
export function vendorIndex(vendorRoot: string, kind: PresetKind): Map<string, string> {
  const index = new Map<string, string>();
  const file = `${vendorRoot}.json`;
  if (!existsSync(file)) return index;
  const listed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const entries = listed[`${kind}_list`];
  if (!Array.isArray(entries)) return index;
  for (const entry of entries as Array<{ name?: string; sub_path?: string }>) {
    if (entry.name && entry.sub_path && !index.has(entry.name)) index.set(entry.name, join(vendorRoot, entry.sub_path));
  }
  return index;
}

function presetPath(root: string, kind: PresetKind, name: string, index: Map<string, string>): string | null {
  const named = join(root, kind, `${name}.json`);
  if (existsSync(named)) return named;
  const listed = index.get(name);
  if (!listed || !existsSync(listed)) return null;
  const own = (JSON.parse(readFileSync(listed, "utf8")) as Preset)["name"];
  return own === name ? listed : null;
}

/** The vendor folder a system preset sits in. */
function vendorRootOf(path: string): string {
  const rel = relative(SYSTEM, path);
  return rel.startsWith("..") ? dirname(dirname(path)) : join(SYSTEM, rel.split("/")[0] ?? "");
}

/**
 * A preset by the name Flash Studio shows: Flashforge's own first, then the filament library's. A name only: until
 * 2026-10-03 a path was taken as well, so any JSON file on disk could stand in as the filament.
 */
export function findPreset(kind: PresetKind, name: string): string | null {
  if (name.includes("/") || name.includes("\\")) return null;
  const bare = name.replace(/\.json$/, "");
  for (const root of kind === "filament" ? [PROFILES, LIBRARY] : [PROFILES]) {
    const found = presetPath(root, kind, bare, vendorIndex(root, kind));
    if (found) return found;
  }
  return null;
}

export function flattenPreset(path: string, kind: PresetKind): Flattened {
  // A parent is looked up in the same vendor's index: the library keeps its bases under filament/base/.
  const root = vendorRootOf(path);
  const index = vendorIndex(root, kind);
  const chain: Preset[] = [];
  const seen = new Set<string>();
  let current: string | null = path;

  while (current) {
    if (seen.has(current)) throw new Error(`inherits loop at ${current}`);
    seen.add(current);
    const preset = JSON.parse(readFileSync(current, "utf8")) as Preset;
    chain.push(preset);
    const parent = preset["inherits"];
    if (typeof parent !== "string" || !parent) break;
    const parentPath = presetPath(root, kind, parent, index);
    if (!parentPath) throw new Error(`${path}: parent preset '${parent}' is not in ${root}`);
    current = parentPath;
  }

  const flat: Preset = {};
  for (const preset of [...chain].reverse()) Object.assign(flat, preset);
  delete flat["inherits"];
  // The plate the GUI has selected; a filament preset maps each plate to its own bed temperature.
  if (kind === "process") flat["curr_bed_type"] = BED_TYPE;

  return { flat, chain: chain.map((p) => (typeof p["name"] === "string" ? p["name"] : "?")) };
}

export interface WrittenPreset extends Flattened {
  /** Where the flat copy landed, beside the output, so a header can be read back against it. */
  file: string;
}

export function writeFlatPreset(path: string, kind: PresetKind, outDir: string): WrittenPreset {
  const { flat, chain } = flattenPreset(path, kind);
  const file = join(outDir, `flat-${kind}-${basename(path)}`);
  writeFileSync(file, `${JSON.stringify(flat, null, 2)}\n`);
  return { flat, chain, file };
}

/**
 * Settings a designer chooses for the model itself. Temperatures, speeds and machine limits are replaced on
 * purpose — they belong to the printer — but these say how the part is built, and a swap deserves naming.
 */
export const MODEL_FACING = [
  "layer_height", "initial_layer_print_height", "wall_loops", "top_shell_layers", "bottom_shell_layers",
  "sparse_infill_density", "sparse_infill_pattern", "enable_support", "support_type", "support_style",
  "support_threshold_angle", "support_on_build_plate_only", "brim_type", "brim_width", "brim_object_gap",
  "raft_layers", "elefant_foot_compensation", "xy_hole_compensation", "xy_contour_compensation",
  "seam_position", "ironing_type", "print_sequence", "enable_prime_tower", "detect_thin_wall",
  "wall_generator", "spiral_mode",
] as const;

export interface Replaced { key: string; was: string; now: string; }

const firstOf = (value: unknown): string => {
  if (Array.isArray(value)) return value.length ? String(value[0]) : "";
  return value === undefined || value === null ? "" : String(value);
};

/** Which of the project's own model-facing settings the AD5M preset replaces. */
export function settingsDiff(project: Preset, flat: Preset, keys: readonly string[] = MODEL_FACING): Replaced[] {
  const out: Replaced[] = [];
  for (const key of keys) {
    if (!(key in project) || !(key in flat)) continue;
    const was = firstOf(project[key]);
    const now = firstOf(flat[key]);
    if (was !== now) out.push({ key, was, now });
  }
  return out;
}

/** Numbers that belong to the machine or the filament and come from the preset, never from a command line. */
export const PRESET_ONLY = /temperature|_temp|speed|accel|flow|volumetric|machine_|_fan|retract|pressure/i;

/**
 * Model-facing keys the 5M's preset still owns: the layer height is the process you picked, the
 * compensations are this printer's calibration, and the prime tower and print sequence follow its one extruder and
 * its gantry.
 */
export const PRINTER_KEEPS: ReadonlySet<string> = new Set([
  "layer_height", "initial_layer_print_height", "elefant_foot_compensation", "xy_hole_compensation",
  "xy_contour_compensation", "enable_prime_tower", "print_sequence",
]);

/**
 * How the supports are built, past on or off and their type: the gap they keep from the part, their interface, a
 * tree's branches, a raft, whether a bridge is held up. Without them a designer's 1 mm gap between the supports and
 * the part goes back to the 5M preset's 0.3.
 */
export const SUPPORT_KEYS = /^(support_|tree_support_|raft_)|^(enforce_support_layers|bridge_no_support|max_bridge_length)$/;

/** Support keys that are not the designer's to set here: line widths, the filament slots, the machine's air. */
const SUPPORT_NOT_CARRIED = /_line_width$|_filament$|air_filtration|chamber/;

/**
 * The process settings the designer changed from the preset they started on, as the project records them: the
 * first entry of `different_settings_to_system`, a list joined by semicolons (the filaments and the printer follow).
 */
export function designerChanged(project: Preset): Set<string> {
  const diff = project["different_settings_to_system"];
  const first = Array.isArray(diff) ? String(diff[0] ?? "") : String(diff ?? "");
  return new Set(first.split(";").map((key) => key.trim()).filter(Boolean));
}

/**
 * The designer's decisions about how the part is built — supports, brim, infill, walls — carried from the project
 * onto the flattened process, so the preset no longer replaces them. The slicer is handed the preset on its command
 * line, which outranks what the project carries; without this a part that needs supports is sliced without them.
 * Every support setting the designer changed travels too; one they left alone stays the 5M's own.
 */
export function carryDesigner(flatPath: string, project: Preset): Replaced[] {
  const flat = JSON.parse(readFileSync(flatPath, "utf8")) as Preset;
  const kept: Replaced[] = [];
  const facing: readonly string[] = MODEL_FACING;
  const support = [...designerChanged(project)]
    .filter((key) => SUPPORT_KEYS.test(key) && !SUPPORT_NOT_CARRIED.test(key) && !facing.includes(key))
    .sort();
  for (const key of [...facing, ...support]) {
    if (PRINTER_KEEPS.has(key) || PRESET_ONLY.test(key) || !(key in project) || !(key in flat)) continue;
    const was = firstOf(flat[key]);
    const now = firstOf(project[key]);
    if (was === now || now === "") continue;
    kept.push({ key, was, now });
    flat[key] = Array.isArray(flat[key]) ? [now] : now;
  }
  writeFileSync(flatPath, `${JSON.stringify(flat, null, 2)}\n`);
  return kept;
}

/** Put the preset's own values back on keys the slicer refused from the project. */
export function restorePreset(flatPath: string, preset: Preset, keys: readonly string[]): void {
  const flat = JSON.parse(readFileSync(flatPath, "utf8")) as Preset;
  for (const key of keys) if (key in preset) flat[key] = preset[key];
  writeFileSync(flatPath, `${JSON.stringify(flat, null, 2)}\n`);
}

/**
 * Settings about the part that are not on the model-facing list: how its shells, infill, surfaces and skin are laid
 * down, a skirt, ironing's pattern. Each exists on the 5M's process preset.
 */
const PART_KEYS: ReadonlySet<string> = new Set([
  "top_shell_thickness", "bottom_shell_thickness", "top_surface_pattern", "bottom_surface_pattern",
  "internal_solid_infill_pattern", "infill_direction", "sparse_infill_anchor", "sparse_infill_anchor_max",
  "infill_combination", "infill_wall_overlap", "minimum_sparse_infill_area", "only_one_wall_top",
  "only_one_wall_first_layer", "wall_sequence", "is_infill_first", "ensure_vertical_shell_thickness", "interface_shells",
  "fuzzy_skin", "fuzzy_skin_thickness", "fuzzy_skin_point_distance", "ironing_pattern", "ironing_spacing",
  "skirt_loops", "skirt_distance", "skirt_height", "draft_shield", "bridge_angle", "thick_bridges",
  "precise_outer_wall", "slice_closing_radius",
]);

/**
 * Whether `--set` or `--object-set` may change a key: the model-facing settings the 5M's preset does not keep, every
 * support setting the designer's own may carry, and the part's other settings above. Nothing else (since 2026-10-03:
 * a denylist let 91 of the process preset's 124 keys through, `post_process` among them, a command Flash Studio's
 * window runs on every export, and `filename_format`).
 */
export function settable(key: string): boolean {
  if (PRESET_ONLY.test(key) || PRINTER_KEEPS.has(key)) return false;
  return (MODEL_FACING as readonly string[]).includes(key) || PART_KEYS.has(key)
    || (SUPPORT_KEYS.test(key) && !SUPPORT_NOT_CARRIED.test(key));
}

export const SETTABLE_HINT = "the part's own settings (walls, shells, infill, surfaces, seam, brim, skirt, supports, "
  + "ironing, fuzzy skin), never the machine's, the filament's or the file's";

/**
 * Your own decisions about the part — brim, infill, walls — on top of a flattened preset, recorded in
 * the file the slicer is handed so the G-code header reads back what was asked for.
 */
export function applyOverrides(flatPath: string, pairs: string[]): Replaced[] {
  const flat = JSON.parse(readFileSync(flatPath, "utf8")) as Preset;
  const applied: Replaced[] = [];
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 0) throw new Error(`--set wants KEY=VALUE, got '${pair}'`);
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (PRESET_ONLY.test(key)) {
      throw new Error(
        `--set refuses '${key}': temperatures, speeds, accelerations, flow and fan come from the preset, never from a command line`,
      );
    }
    if (!settable(key)) throw new Error(`--set refuses '${key}': it takes ${SETTABLE_HINT}`);
    if (!(key in flat)) throw new Error(`--set refuses '${key}': the process preset has no such setting`);
    applied.push({ key, was: JSON.stringify(flat[key]), now: value });
    flat[key] = Array.isArray(flat[key]) ? [value] : value;
  }
  writeFileSync(flatPath, `${JSON.stringify(flat, null, 2)}\n`);
  return applied;
}

/** Whether Flash Studio lets a person pick this preset, and whether it may be used on the 5M 0.4. */
export function selectableFor5M(path: string): { ok: boolean; why?: string } {
  const own = JSON.parse(readFileSync(path, "utf8")) as Preset;
  if (own["instantiation"] === "false") {
    return { ok: false, why: "a base preset Flash Studio does not offer; pick one it lists, e.g. Generic PLA @System" };
  }
  const compatible = flattenPreset(path, "filament").flat["compatible_printers"];
  if (Array.isArray(compatible) && compatible.length && !compatible.some((c) => String(c).includes("Adventurer 5M 0.4"))) {
    return { ok: false, why: "not for the Adventurer 5M 0.4 Nozzle" };
  }
  return { ok: true };
}

/**
 * The filament presets to offer for the 5M 0.4: every one Flash Studio lets a person pick that is not for another
 * printer — Flashforge's own, then the library's "@System" ones.
 */
export function filamentChoices(): string[] {
  const names: string[] = [];
  for (const root of [PROFILES, LIBRARY]) {
    for (const [name, path] of vendorIndex(root, "filament")) {
      if (!existsSync(path)) continue;
      try {
        if (selectableFor5M(path).ok && !names.includes(name)) names.push(name);
      } catch {
        /* a preset whose chain will not resolve is not one to offer */
      }
    }
  }
  return names;
}
