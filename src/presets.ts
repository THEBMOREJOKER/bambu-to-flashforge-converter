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

/** A preset by the name Flash Studio shows: Flashforge's own first, then the filament library's. */
export function findPreset(kind: PresetKind, name: string): string | null {
  if (name.startsWith("/")) return existsSync(name) ? name : null;
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
