/**
 * Reading a G-code file the way the printer will read it, and holding it to the machine before it moves.
 *
 * Every line is split the way the AD5M's firmware, Klipper, splits it (`_process_commands` and `_get_extended_params`
 * in klippy/gcode.py, upstream 461c4e3722c3): upper case, a comment cut at `;`, a line number skipped, a traditional
 * command's parameters split on letters, so `S290E-1` is S 290 and an exponent is never read, and Klipper's own
 * commands read as KEY=VALUE. A check that splits on spaces and reads exponents passes `M104S400`, `N10 M104 S400`
 * and `M104 S290E-1` clean.
 *
 * A line the check cannot read that way fails, and so does any command a 5M slice never carries: the firmware knows
 * commands (heaters, homing, steppers, its own macros) that the check does not hold a file to, and a file it cannot
 * read is not a file it can pass. Moves follow the modal state a firmware follows: G90/G91, G92's offsets, M220's
 * speed factor, and G2/G3 arcs by the extremes they sweep through rather than by their endpoints.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import {
  BAMBU_MARKERS, BED_MAX, BED_MIN, BED_TEMP_KEY, BED_TOLERANCE, BED_TYPE, BED_Z, BRIDGE_UNSUPPORTED_MM, HW, NOZZLE,
  PRINTER_MODEL, TEMP_RANGE,
} from "./machine.js";

/**
 * Klipper's split of a line (`args_r`): a run of letters and underscores, or one `*` or `/`. Upstream no longer splits
 * on `/`; the older split is kept, because it reads a value where the newer one refuses the line.
 */
const SPLIT = /([A-Z_]+|[A-Z*/])/;
/** A traditional command's value: Python's float() on text the letters have already been split from. */
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;
/** An extended command's value keeps its letters, so float() reads an exponent there: ACCEL=5e4 is 50 000. */
const NUMBER_EXTENDED = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Every command a slice for the AD5M carries, and nothing else. Flash Studio 1.7.15's own slice of a plate for the
 * AD5M carries sixteen: G0 G1 G2 G3 G17 G21 G90 G92 M73 M83 M104 M106 M109 M140 M190 SET_VELOCITY_LIMIT. The AD5M's
 * machine preset adds PAUSE (its pause G-code). The rest is what the slicer writes for a Klipper printer when a
 * process or filament preset turns a feature on (src/libslic3r/GCodeWriter.cpp and GCode.cpp): relative moves and
 * extrusion, dwell, the fan off, acceleration by M204, the speed and flow factors, pressure advance, object labels,
 * the one extruder. G28, M84, M600, timelapse and every heater command but the four below are not here.
 */
export const KNOWN_COMMANDS: ReadonlySet<string> = new Set([
  "G0", "G1", "G2", "G3", "G4", "G17", "G21", "G90", "G91", "G92", "M82", "M83", "M400",
  "M104", "M109", "M140", "M190",
  "M73", "M106", "M107", "M117",
  "M204", "M220", "M221", "SET_VELOCITY_LIMIT", "SET_PRESSURE_ADVANCE",
  "PAUSE", "EXCLUDE_OBJECT_DEFINE", "EXCLUDE_OBJECT_START", "EXCLUDE_OBJECT_END",
]);

/**
 * Commands that change what the printer believes about itself rather than moving it: the Z offset, the position it
 * thinks it is at, its saved configuration. Told by name; G92 on X, Y or Z is told with them. Checked against a
 * sliced file: a clean AD5M G-code carries none of these, and its one G92 is G92 E0.
 */
const STATE_COMMANDS: ReadonlySet<string> = new Set([
  "SET_GCODE_OFFSET", "SET_KINEMATIC_POSITION", "SET_HOME_OFFSET", "SAVE_CONFIG", "FIRMWARE_RESTART", "RESTART",
  "M500", "M502",
]);

/** One line as the 5M's firmware dispatches it. */
export interface Command {
  /** What the firmware looks the line up by: G1, M104, T0, SET_VELOCITY_LIMIT. Empty when nothing names one. */
  name: string;
  /** One of Klipper's own commands, whose parameters are KEY=VALUE, rather than a letter and a number. */
  extended: boolean;
  /** Each parameter's text, every time the line names it. The firmware keeps the last; the check refuses two. */
  params: Map<string, string[]>;
  /** Why the line cannot be read the firmware's way, when it cannot. */
  malformed?: string;
}

/**
 * One line, split the way Klipper splits it; null for a blank line or a comment. Where two Klipper releases read a
 * line differently, the reading that moves the machine is taken: older releases drop the space in `T 1` and `G 1`,
 * and run them as T1 and G1.
 */
export function readCommand(raw: string): Command | null {
  const line = raw.trim();
  const cut = line.indexOf(";");
  const code = (cut >= 0 ? line.slice(0, cut) : line).trim();
  if (!code) return null;
  const parts = code.toUpperCase().split(SPLIT);
  const params = new Map<string, string[]>();
  if ((parts[0] ?? "").trim()) return { name: "", extended: false, params, malformed: "text before the command" };
  // A line number goes first and is skipped, the way the firmware skips it.
  const at = parts[1] === "N" && /^\s*\d+\s*$/.test(parts[2] ?? "") ? 3 : 1;
  const word = parts[at] ?? "";
  const name = word + (parts[at + 1] ?? "").trim();
  const extended = word.length > 1;
  if (!extended) {
    for (let k = at + 2; k < parts.length; k += 2) {
      const key = parts[k] ?? "";
      params.set(key, [...(params.get(key) ?? []), (parts[k + 1] ?? "").trim()]);
    }
    return { name, extended, params };
  }
  // Klipper's own commands: the text after the name, split on white space with `#` and `;` ending it, each piece
  // KEY=VALUE. Quoting there is shell quoting, and a quoted value is not one this reads.
  let rest = line.slice(line.toUpperCase().indexOf(name) + name.length);
  if (at === 3) rest = rest.replace(/\*\d+\s*$/, "");
  const end = rest.search(/[#;]/);
  if (end >= 0) rest = rest.slice(0, end);
  if (/["'\\]/.test(rest)) return { name, extended, params, malformed: "a quoted value" };
  for (const piece of rest.trim().split(/\s+/).filter(Boolean)) {
    const eq = piece.indexOf("=");
    if (eq <= 0) return { name, extended, params, malformed: `'${piece}' is not KEY=VALUE, and the firmware refuses the line` };
    const key = piece.slice(0, eq).toUpperCase();
    params.set(key, [...(params.get(key) ?? []), piece.slice(eq + 1)]);
  }
  return { name, extended, params };
}

/** The '; key = value' block a slicer writes, plus its totals lines. Stops at the end of the config block. */
export function header(path: string): Map<string, string> {
  return headerOf(readFileSync(path, "utf8"));
}

function headerOf(text: string): Map<string, string> {
  const h = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("; ")) continue;
    const body = line.slice(2).replace(/\r$/, "");
    if (body.startsWith("generated by ")) {
      h.set("generated by", body.slice("generated by ".length));
      continue;
    }
    if (body.includes("CONFIG_BLOCK_END")) break;
    const eq = body.indexOf(" = ");
    if (eq > 0) {
      h.set(body.slice(0, eq).trim(), body.slice(eq + 3).trim().replace(/^"|"$/g, ""));
      continue;
    }
    const colon = body.indexOf(": ");
    if (colon > 0 && !h.has(body.slice(0, colon).trim())) {
      h.set(body.slice(0, colon).trim(), body.slice(colon + 2).trim());
    }
  }
  return h;
}

/** A value a header writes once per filament slot, read for one slot. */
export function slotValue(value: string | undefined, slot: number): string {
  const values = (value ?? "").split(/[;,]/);
  return (values[slot] ?? values[0] ?? "").trim();
}

export function firstValue(value: string | undefined): string {
  return slotValue(value, 0);
}

/** A line of the file, by number, with its text cut short for a report. */
export interface At { line: number; text: string; }

export interface Scan {
  bambuHits: At[];
  maxZ: number | null;
  /** The lowest Z a move goes to. Below 0 the nozzle is in the bed. */
  minZ: number | null;
  x: [number, number] | [null, null];
  y: [number, number] | [null, null];
  hasNozzleHeat: boolean;
  hasBedHeat: boolean;
  arcs: number;
  relativeMoves: number;
  /** The highest the file asks for, whatever its header claims: F times M220's factor. */
  maxFeedXY: number;
  maxFeedZOnly: number;
  /** M204's S, P and T, and SET_VELOCITY_LIMIT's ACCEL and ACCEL_TO_DECEL: the highest of any. */
  maxAccel: number;
  /** SET_VELOCITY_LIMIT VELOCITY: the speed limit the file sets the machine to. */
  maxVelocityLimit: number;
  maxNozzleC: number;
  maxBedC: number;
  layers: number;
  /** Every T command, and every heater command aimed at a tool, in order. The 5M has one extruder: T0. */
  tools: Array<{ line: number; tool: number }>;
  /** The line "; EXECUTABLE_BLOCK_START" sits on, when the file has one. */
  executableStart: number | null;
  /** Commands before that marker. In a file the slicer wrote there are none: the first is the line after it. */
  beforeStart: At[];
  /** Commands that move the printer's own idea of where it is, or rewrite its configuration. */
  stateCommands: At[];
  /** Commands no 5M slice carries (KNOWN_COMMANDS). */
  unknown: At[];
  /** Lines the check cannot read the firmware's way, or that the firmware refuses: each says why. */
  unreadable: At[];
}

/** Every point an arc can reach: its end, plus each axis extreme the sweep passes through. */
export function arcPoints(
  x0: number, y0: number, x1: number, y1: number, i: number, j: number, clockwise: boolean,
): Array<[number, number]> {
  const cx = x0 + i;
  const cy = y0 + j;
  const r = Math.hypot(x0 - cx, y0 - cy);
  let a0 = Math.atan2(y0 - cy, x0 - cx);
  let a1 = Math.atan2(y1 - cy, x1 - cx);
  const full = Math.hypot(x1 - x0, y1 - y0) < 1e-9;
  if (clockwise) {
    if (full || a1 > a0) a1 -= 2 * Math.PI;
  } else {
    if (full || a1 < a0) a1 += 2 * Math.PI;
  }
  const lo = clockwise ? a1 : a0;
  const hi = clockwise ? a0 : a1;
  const points: Array<[number, number]> = [];
  points.push([x1, y1]);
  const quarter = Math.PI / 2;
  for (let k = Math.ceil(lo / quarter); k <= Math.floor(hi / quarter); k++) {
    points.push([cx + r * Math.cos(k * quarter), cy + r * Math.sin(k * quarter)]);
  }
  return points;
}

/**
 * A parameter as a number, the way the firmware reads it: undefined when the line does not name it, NaN when the
 * text is not one plain number or the line names it twice. The firmware keeps the last of two; the check keeps
 * neither and fails the line.
 */
export function numberParam(cmd: Command, key: string): number | undefined {
  const values = cmd.params.get(key);
  if (!values) return undefined;
  const text = values[values.length - 1] ?? "";
  return values.length === 1 && (cmd.extended ? NUMBER_EXTENDED : NUMBER).test(text) ? Number(text) : Number.NaN;
}

const short = (raw: string) => raw.trim().slice(0, 60);

/** One pass over the whole file. Everything the check needs, measured rather than believed. */
export function scan(path: string): Scan {
  return scanOf(readFileSync(path, "utf8"));
}

function scanOf(text: string): Scan {
  const s: Scan = {
    bambuHits: [], maxZ: null, minZ: null, x: [null, null], y: [null, null],
    hasNozzleHeat: false, hasBedHeat: false, arcs: 0, relativeMoves: 0,
    maxFeedXY: 0, maxFeedZOnly: 0, maxAccel: 0, maxVelocityLimit: 0, maxNozzleC: 0, maxBedC: 0, layers: 0, tools: [],
    executableStart: null, beforeStart: [], stateCommands: [], unknown: [], unreadable: [],
  };
  let minX: number | null = null, maxX: number | null = null, minY: number | null = null, maxY: number | null = null;
  const see = (x: number, y: number) => {
    minX = minX === null || x < minX ? x : minX;
    maxX = maxX === null || x > maxX ? x : maxX;
    minY = minY === null || y < minY ? y : minY;
    maxY = maxY === null || y > maxY ? y : maxY;
  };

  // Where the head is on the machine, and G92's offset from there to the coordinates the file writes.
  let px = 0, py = 0, pz = 0, bx = 0, by = 0, bz = 0;
  let feed = 0, speedFactor = 1;
  let absolute = true;
  let lineNo = 0;

  for (const raw of text.split("\n")) {
    lineNo++;
    if (raw.startsWith(";")) {
      if (raw.startsWith(";LAYER_CHANGE")) s.layers++;
      if (s.executableStart === null && raw.includes("EXECUTABLE_BLOCK_START")) s.executableStart = lineNo;
      continue;
    }
    const cmd = readCommand(raw);
    if (!cmd) continue;
    const at: At = { line: lineNo, text: short(raw) };
    if (s.executableStart === null) s.beforeStart.push(at);
    if (BAMBU_MARKERS.some((marker) => marker.test(raw.trim()))) { s.bambuHits.push(at); continue; }
    const why = (reason: string) => s.unreadable.push({ line: lineNo, text: `${short(raw)} (${reason})` });
    if (cmd.malformed) { why(cmd.malformed); continue; }
    const { name } = cmd;
    if (STATE_COMMANDS.has(name)) { s.stateCommands.push(at); continue; }

    const tool = /^T(\d+)$/.exec(name);
    if (tool) { s.tools.push({ line: lineNo, tool: Number(tool[1]) }); continue; }
    if (!KNOWN_COMMANDS.has(name)) { s.unknown.push(at); continue; }

    // Every parameter this reads is one plain number; anything else fails the line rather than being guessed at.
    const read = (key: string): number | undefined => {
      const value = numberParam(cmd, key);
      if (value !== undefined && Number.isNaN(value)) why(`${key} is not one plain number`);
      return value === undefined || Number.isNaN(value) ? undefined : value;
    };
    const most = (...values: Array<number | undefined>) => Math.max(0, ...values.filter((v): v is number => v !== undefined));

    if (name === "G90") { absolute = true; continue; }
    if (name === "G91") { absolute = false; continue; }

    if (name === "M104" || name === "M109") {
      s.hasNozzleHeat = true;
      s.maxNozzleC = Math.max(s.maxNozzleC, most(read("S"), read("R")));
      const index = read("T");
      if (index !== undefined) s.tools.push({ line: lineNo, tool: index });
      continue;
    }
    if (name === "M140" || name === "M190") {
      s.hasBedHeat = true;
      s.maxBedC = Math.max(s.maxBedC, most(read("S"), read("R")));
      continue;
    }
    if (name === "M204") { s.maxAccel = Math.max(s.maxAccel, most(read("S"), read("P"), read("T"))); continue; }
    if (name === "SET_VELOCITY_LIMIT") {
      s.maxAccel = Math.max(s.maxAccel, most(read("ACCEL"), read("ACCEL_TO_DECEL")));
      s.maxVelocityLimit = Math.max(s.maxVelocityLimit, most(read("VELOCITY")));
      read("SQUARE_CORNER_VELOCITY");
      read("MINIMUM_CRUISE_RATIO");
      continue;
    }
    if (name === "M220") {
      // The firmware multiplies every later feedrate by it: M220 S500 makes F36000 a 3000 mm/s move.
      const percent = read("S") ?? 100;
      if (percent > 0) speedFactor = percent / 100;
      else why("M220 S must be above 0");
      continue;
    }
    if (name !== "G0" && name !== "G1" && name !== "G2" && name !== "G3" && name !== "G92") continue;

    const X = read("X"), Y = read("Y"), Z = read("Z");
    if (name === "G92") {
      // G92 E0 resets the extruder and is ordinary. G92 on X, Y or Z, or bare, moves the machine's idea of where it is.
      const E = read("E");
      if (X !== undefined || Y !== undefined || Z !== undefined || E === undefined) s.stateCommands.push(at);
      const bare = X === undefined && Y === undefined && Z === undefined && E === undefined;
      if (X !== undefined || bare) bx = px - (X ?? 0);
      if (Y !== undefined || bare) by = py - (Y ?? 0);
      if (Z !== undefined || bare) bz = pz - (Z ?? 0);
      continue;
    }
    read("E");
    const F = read("F");
    if (F !== undefined) feed = F;
    const tx = X === undefined ? px : absolute ? X + bx : px + X;
    const ty = Y === undefined ? py : absolute ? Y + by : py + Y;
    const tz = Z === undefined ? pz : absolute ? Z + bz : pz + Z;
    if (!absolute && (X !== undefined || Y !== undefined || Z !== undefined)) s.relativeMoves++;

    const speed = (feed / 60) * speedFactor;
    if (name === "G2" || name === "G3") {
      s.arcs++;
      const I = read("I") ?? 0, J = read("J") ?? 0;
      // The firmware refuses all three and the print stops there (klippy/extras/gcode_arcs.py).
      if (cmd.params.has("R")) why("an arc written with R, which the firmware refuses");
      else if (!absolute) why("an arc in relative mode, which the firmware refuses");
      else if (!I && !J) why("an arc with no centre, which the firmware refuses");
      else for (const [ax, ay] of arcPoints(px, py, tx, ty, I, J, name === "G2")) see(ax, ay);
      see(tx, ty);
      s.maxFeedXY = Math.max(s.maxFeedXY, speed);
    } else if (X !== undefined || Y !== undefined) {
      see(tx, ty);
      s.maxFeedXY = Math.max(s.maxFeedXY, speed);
    } else if (Z !== undefined) {
      s.maxFeedZOnly = Math.max(s.maxFeedZOnly, speed);
    }
    if (Z !== undefined) {
      s.maxZ = s.maxZ === null || tz > s.maxZ ? tz : s.maxZ;
      s.minZ = s.minZ === null || tz < s.minZ ? tz : s.minZ;
    }
    px = tx; py = ty; pz = tz;
  }

  s.x = minX === null || maxX === null ? [null, null] : [minX, maxX];
  s.y = minY === null || maxY === null ? [null, null] : [minY, maxY];
  return s;
}

/** One object on a plate as the slicer's plate_N.json lists it: its name, and its box on the bed as X0 Y0 X1 Y1. */
export interface PlateObject { name: string; box: [number, number, number, number]; }

/** The objects of one plate, from the text of the slicer's plate_N.json. Text that does not parse names none. */
export function plateObjects(json: string): PlateObject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (parsed as { bbox_objects?: unknown } | null)?.bbox_objects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((o: { name?: unknown; bbox?: unknown }) => {
    const box = Array.isArray(o.bbox) ? o.bbox.map(Number) : [];
    return box.length === 4 && box.every(Number.isFinite)
      ? [{ name: String(o.name ?? "?"), box: box as [number, number, number, number] }]
      : [];
  });
}

/** The plate_N.json beside a plate_N.gcode, the way Flash Studio's own model folder keeps them. */
function besideObjects(path: string): PlateObject[] {
  const json = path.replace(/\.gcode$/i, ".json");
  return json !== path && existsSync(json) ? plateObjects(readFileSync(json, "utf8")) : [];
}

/** A bridge laid over air: the longest stretch of one strand with nothing printed under it, and where it is. */
export interface OpenBridge {
  /** mm of one strand with nothing under it. */
  span: number;
  /** The layer the bridge prints on. */
  z: number;
  x: [number, number];
  y: [number, number];
  /** The plate's object it belongs to, when the plate's objects are known. */
  object?: string;
}

/** The grid the layers below a bridge are read on, and the step taken along a strand, in mm. */
const CELL = 1;
const STEP = 0.5;
/**
 * How far under a bridge to look for what holds it up: the gap a support keeps below the part (0.18 mm on the 5M's
 * process preset) and a layer or two of the support's interface.
 */
const HOLD_BELOW = 1;
/** The slicer's mark for a bridge over air. `Internal Bridge` lies over the part's own infill and is not one. */
const BRIDGE = /^bridge( infill)?$/i;

/**
 * Every bridge in the file that crosses air, read from the slicer's own feature marks. A bridge strand is held
 * wherever anything was printed within HOLD_BELOW under it — the part's walls at its ends, a support's interface
 * along it — and crosses air everywhere else. One entry per object and layer, the longest first.
 */
export function openBridges(path: string, objects: PlateObject[] = []): OpenBridge[] {
  return openBridgesOf(readFileSync(path, "utf8"), objects);
}

function openBridgesOf(text: string, objects: PlateObject[]): OpenBridge[] {
  const below: Array<{ z: number; cells: Set<number> }> = [];
  let cells = new Set<number>();
  let z = 0;
  let type = "";
  let px = 0, py = 0, pe = 0;
  let absolute = true, relativeE = false;
  const found = new Map<string, OpenBridge>();
  const cellOf = (v: number) => Math.floor(v / CELL);
  const keyOf = (cx: number, cy: number) => (cx + 1000) * 4000 + (cy + 1000);
  const line = (x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / STEP));
    return Array.from({ length: n + 1 }, (_, i): [number, number] => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  };
  // An arc is walked along its curve. Read by its chord, the arcs of a round wall cut straight across the hollow
  // they ring and hold up the very bridge that spans it (a lid's 30 mm ceiling read as 4 mm).
  const arc = (x0: number, y0: number, x1: number, y1: number, i: number, j: number, clockwise: boolean) => {
    const cx = x0 + i;
    const cy = y0 + j;
    const r = Math.hypot(x0 - cx, y0 - cy);
    const a0 = Math.atan2(y0 - cy, x0 - cx);
    let a1 = Math.atan2(y1 - cy, x1 - cx);
    const full = Math.hypot(x1 - x0, y1 - y0) < 1e-9;
    if (clockwise) {
      if (full || a1 > a0) a1 -= 2 * Math.PI;
    } else if (full || a1 < a0) {
      a1 += 2 * Math.PI;
    }
    const n = Math.max(1, Math.ceil((Math.abs(a1 - a0) * r) / STEP));
    return Array.from({ length: n + 1 }, (_, k): [number, number] => {
      const a = a0 + ((a1 - a0) * k) / n;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
  };
  const held = (x: number, y: number, layers: Array<Set<number>>) => {
    const cx = cellOf(x), cy = cellOf(y);
    for (const layer of layers) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (layer.has(keyOf(cx + dx, cy + dy))) return true;
    }
    return false;
  };
  const objectAt = (x: number, y: number) => {
    let best: PlateObject | undefined;
    for (const o of objects) {
      const [x0, y0, x1, y1] = o.box;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (!best || (x1 - x0) * (y1 - y0) < (best.box[2] - best.box[0]) * (best.box[3] - best.box[1])) best = o;
    }
    return best?.name;
  };
  const strand = (along: Array<[number, number]>) => {
    const layers = below.filter((l) => l.z < z - 1e-6 && l.z >= z - HOLD_BELOW - 1e-6).map((l) => l.cells);
    // The longest stretch of points in a row with nothing under them, measured along the strand.
    let span = 0, from = -1, walked = 0;
    let last: [number, number] | undefined;
    for (const [x, y] of along) {
      walked += last ? Math.hypot(x - last[0], y - last[1]) : 0;
      last = [x, y];
      if (held(x, y, layers)) { from = -1; continue; }
      if (from < 0) from = walked;
      span = Math.max(span, walked - from);
    }
    if (span <= 0) return;
    const [x0, y0] = along[0] ?? [0, 0];
    const [x1, y1] = along[along.length - 1] ?? [0, 0];
    const object = objectAt((x0 + x1) / 2, (y0 + y1) / 2);
    const key = `${object ?? ""}\u0000${z}`;
    const was = found.get(key);
    found.set(key, {
      span: Math.max(span, was?.span ?? 0),
      z,
      x: [Math.min(x0, x1, was?.x[0] ?? Infinity), Math.max(x0, x1, was?.x[1] ?? -Infinity)],
      y: [Math.min(y0, y1, was?.y[0] ?? Infinity), Math.max(y0, y1, was?.y[1] ?? -Infinity)],
      ...(object ? { object } : {}),
    });
  };
  const endLayer = () => {
    if (cells.size) below.push({ z, cells });
    cells = new Set<number>();
    while (below.length && (below[0]?.z ?? 0) < z - 2 * HOLD_BELOW) below.shift();
  };

  for (const raw of text.split("\n")) {
    if (raw.startsWith(";")) {
      if (raw.startsWith(";LAYER_CHANGE") || raw.startsWith("; CHANGE_LAYER")) endLayer();
      const height = /^;\s*(?:Z:|Z_HEIGHT:)\s*([-\d.]+)/.exec(raw);
      if (height) z = Number.parseFloat(height[1] ?? "0");
      const feature = /^;\s*(?:TYPE:|FEATURE:)\s*(.+?)\s*$/.exec(raw);
      if (feature) type = feature[1] ?? "";
      continue;
    }
    // Read the way the scan reads a line; a value it cannot read is the scan's failure, and is skipped here.
    const cmd = readCommand(raw);
    if (!cmd || cmd.malformed) continue;
    const word = cmd.name;
    if (word === "G90") { absolute = true; continue; }
    if (word === "G91") { absolute = false; continue; }
    if (word === "M82") { relativeE = false; continue; }
    if (word === "M83") { relativeE = true; continue; }
    if (word !== "G0" && word !== "G1" && word !== "G2" && word !== "G3" && word !== "G92") continue;
    const get = (key: string) => {
      const value = numberParam(cmd, key);
      return value === undefined || Number.isNaN(value) ? undefined : value;
    };
    if (word === "G92") {
      const e = get("E");
      if (e !== undefined) pe = e;
      continue;
    }
    const X = get("X"), Y = get("Y"), I = get("I"), J = get("J");
    const tx = X === undefined ? px : absolute ? X : px + X;
    const ty = Y === undefined ? py : absolute ? Y : py + Y;
    const e = get("E");
    const extrudes = e !== undefined && (relativeE ? e > 0 : e > pe);
    if (e !== undefined && !relativeE) pe = e;
    const curved = (word === "G2" || word === "G3") && (I !== undefined || J !== undefined);
    if (extrudes && (curved || tx !== px || ty !== py)) {
      const along = curved
        ? arc(px, py, tx, ty, I ?? 0, J ?? 0, word === "G2")
        : line(px, py, tx, ty);
      if (BRIDGE.test(type)) strand(along);
      for (const [x, y] of along) cells.add(keyOf(cellOf(x), cellOf(y)));
    }
    px = tx; py = ty;
  }
  return [...found.values()].sort((a, b) => b.span - a.span || a.z - b.z);
}

export type CheckState = "ok" | "bad" | "warn";
export interface CheckLine { state: CheckState; text: string; }

export interface CheckResult {
  file: string;
  generatedBy: string;
  lines: CheckLine[];
  failures: string[];
  warnings: string[];
  /** The numbers worth showing beside the verdict. */
  facts: {
    layers: string; maxZ: number | null; timeEstimate: string; filamentMm: string;
    filamentType: string; nozzleC: string; bedC: string; bedType: string;
    arcs: number; relativeMoves: number; maxFeedXY: number; maxAccel: number;
    x: [number, number] | [null, null]; y: [number, number] | [null, null];
  };
  /** Exit 0 clean, 2 do not print it. */
  code: 0 | 2;
}

/**
 * Hold a file to the printer. Every temperature compared here comes out of the header the slicer wrote, and every
 * limit out of the machine's own preset — nothing is typed in. The plate's objects name a long bridge's part; without
 * them the plate_N.json beside the file is read, and without that the bridge is placed by X and Y.
 */
export function check(path: string, objects?: PlateObject[]): CheckResult {
  const text = readFileSync(path, "utf8");
  const h = headerOf(text);
  const s = scanOf(text);
  const lines: CheckLine[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  const verdict = (ok: boolean, good: string, bad: string) => {
    lines.push({ state: ok ? "ok" : "bad", text: ok ? good : bad });
    if (!ok) failures.push(bad);
  };
  const note = (text: string) => { lines.push({ state: "warn", text }); warnings.push(text); };

  const model = h.get("printer_model") ?? "?";
  verdict(model === PRINTER_MODEL, `printer_model = ${PRINTER_MODEL}`, `printer_model = ${model} (need ${PRINTER_MODEL})`);

  const nozzle = h.get("nozzle_diameter") ?? "?";
  verdict(nozzle.includes(NOZZLE), `nozzle ${nozzle}`, `nozzle_diameter = ${nozzle} (printer has ${NOZZLE})`);

  const flavor = h.get("gcode_flavor") ?? "?";
  verdict(flavor === "klipper", "gcode_flavor = klipper", `gcode_flavor = ${flavor} (AD5M is klipper)`);

  const area = h.get("printable_area") ?? "?";
  verdict(area.startsWith("-110x-110"), `printable_area ${area}`,
    `printable_area = ${area} (need -110x-110,110x-110,110x110,-110x110)`);

  const first = s.bambuHits[0];
  verdict(s.bambuHits.length === 0, "no Bambu-only commands",
    `${s.bambuHits.length} Bambu-only command(s), first at line ${first?.line ?? 0}: ${first?.text ?? ""}`);

  const unknown = s.unknown[0];
  verdict(!s.unknown.length, "every command is one a 5M slice carries",
    `${s.unknown.length} command(s) no 5M slice carries, first at line ${unknown?.line ?? 0}: ${unknown?.text ?? ""}`
    + ` — the firmware would run what the check does not hold to the machine`);
  const unread = s.unreadable[0];
  verdict(!s.unreadable.length, "every line reads the way the firmware reads it",
    `${s.unreadable.length} line(s) the check cannot read the firmware's way, first at line ${unread?.line ?? 0}: ${unread?.text ?? ""}`);

  // Which slots the plate draws from: the header lists one length per slot, and a Bambu project may print from slot 10.
  const perSlot = (h.get("filament used [mm]") ?? "0").split(/[;,]/).map((v) => Number.parseFloat(v.trim()));
  const usedSlots = perSlot.flatMap((v, i) => (v > 0 ? [i] : []));
  const slot = usedSlots[0] ?? 0;
  const changes = s.tools.filter((t) => t.tool !== 0);
  const changeText = changes.length
    ? `selects ${[...new Set(changes.map((t) => `T${t.tool}`))].join(", ")} (first at line ${changes[0]?.line ?? 0})`
    : "";
  const slotText = usedSlots.length > 1 ? `draws filament from slots ${usedSlots.map((i) => i + 1).join(", ")}` : "";
  verdict(!changes.length && usedSlots.length <= 1,
    `one extruder: ${s.tools.length ? "T0 only" : "no tool command"}`,
    `the 5M has one extruder and this file ${[changeText, slotText].filter(Boolean).join(" and ")} — re-convert it onto one slot`);

  // A project can put its own text where the slicer writes the file's metadata, and that text lands above the start
  // block, before the first heat and the first home. In a file the slicer wrote, nothing executes there.
  if (s.executableStart !== null) {
    const first = s.beforeStart[0];
    verdict(!s.beforeStart.length,
      `nothing executes before the start block (line ${s.executableStart})`,
      `${s.beforeStart.length} command(s) run before the start block at line ${s.executableStart} — first at line ${first?.line ?? 0}: ${first?.text ?? ""}`);
  }

  // Homing undoes a shifted origin; these are the commands it does not undo.
  const state = s.stateCommands[0];
  verdict(!s.stateCommands.length,
    "no command rewrites the printer's origin or its saved configuration",
    `${s.stateCommands.length} command(s) change the printer's own state — first at line ${state?.line ?? 0}: ${state?.text ?? ""}`);

  verdict(s.maxZ !== null && s.maxZ <= BED_Z, `max Z ${s.maxZ} mm`, `max Z ${s.maxZ} exceeds ${BED_Z} mm`);
  verdict(s.minZ === null || s.minZ >= 0, `lowest Z ${s.minZ ?? 0} mm`, `a move goes to Z ${s.minZ} mm, below the bed`);

  if (s.x[0] !== null && s.y[0] !== null) {
    const [x0, x1] = s.x as [number, number];
    const [y0, y1] = s.y as [number, number];
    const lo = BED_MIN - BED_TOLERANCE;
    const hi = BED_MAX + BED_TOLERANCE;
    const inside = x0 >= lo && x1 <= hi && y0 >= lo && y1 <= hi;
    const seen = s.arcs || s.relativeMoves
      ? ` (${s.arcs} arc(s) swept, ${s.relativeMoves} relative move(s) resolved)`
      : "";
    const range = `X ${x0.toFixed(1)}..${x1.toFixed(1)}  Y ${y0.toFixed(1)}..${y1.toFixed(1)}${seen}`;
    verdict(inside, `XY moves within the bed: ${range}`, `XY moves leave the bed: ${range}`);
  }

  verdict(s.hasNozzleHeat && s.hasBedHeat, "nozzle and bed heaters are set (M104/M109, M140/M190)",
    "a heater is never set — start gcode missing?");

  const bedType = h.get("curr_bed_type") ?? "?";
  const bedKey = BED_TEMP_KEY[bedType] ?? "hot_plate_temp";
  if (bedType in BED_TEMP_KEY) lines.push({ state: "ok", text: `bed type ${bedType} → ${bedKey}` });
  else note(`bed type '${bedType}' unknown; reading ${bedKey}`);

  // Temperatures for the slot that prints, not for slot 1 when the plate never touches it.
  const filamentType = slotValue(h.get("filament_type"), slot) || "?";
  const nozzleC = slotValue(h.get("nozzle_temperature") ?? h.get("nozzle_temperature_initial_layer"), slot);
  const bedC = slotValue(h.get(bedKey) ?? h.get(`${bedKey}_initial_layer`), slot);
  const range = TEMP_RANGE[filamentType.toUpperCase()];
  const nozzleValue = Number.parseFloat(nozzleC);
  const bedValue = Number.parseFloat(bedC);
  if (!Number.isFinite(nozzleValue) || !Number.isFinite(bedValue)) {
    verdict(false, "", `temperatures unreadable: nozzle '${nozzleC}', bed '${bedC}'`);
  } else if (range) {
    const [nLo, nHi] = range.nozzle;
    const [bLo, bHi] = range.bed;
    const limits = `nozzle ${nLo}–${nHi} °C, bed ${bLo}–${bHi} °C`;
    verdict(nozzleValue >= nLo && nozzleValue <= nHi && bedValue >= bLo && bedValue <= bHi,
      `${filamentType}: nozzle ${nozzleC} °C, bed ${bedC} °C, inside ${limits}`,
      `${filamentType}: nozzle ${nozzleC} °C, bed ${bedC} °C, outside ${limits} — wrong filament preset`);
  } else {
    note(`filament_type ${filamentType} has no range on file; nozzle ${nozzleC} °C, bed ${bedC} °C — read them`);
  }

  verdict(s.maxNozzleC <= HW.nozzleMaxC, `highest nozzle command ${s.maxNozzleC.toFixed(0)} °C ≤ hardware ${HW.nozzleMaxC}`,
    `nozzle commanded to ${s.maxNozzleC.toFixed(0)} °C, over the hardware ${HW.nozzleMaxC}`);
  // The bed command has to equal the preset (below); the nozzle may sit lower, to preheat or to stand by, never higher
  // than the filament takes. A PLA file commanding 270 °C is under the hardware cap and still wrong.
  if (range) {
    const nHi = range.nozzle[1];
    verdict(s.maxNozzleC <= nHi, `highest nozzle command ${s.maxNozzleC.toFixed(0)} °C within ${filamentType}'s ${nHi}`,
      `nozzle commanded to ${s.maxNozzleC.toFixed(0)} °C, over the ${nHi} °C ${filamentType} takes`);
  }
  verdict(s.maxBedC <= HW.bedMaxC, `highest bed command ${s.maxBedC.toFixed(0)} °C ≤ hardware ${HW.bedMaxC}`,
    `bed commanded to ${s.maxBedC.toFixed(0)} °C, over the hardware ${HW.bedMaxC}`);
  verdict(s.maxFeedXY <= HW.maxSpeedMmS, `highest XY feedrate ${s.maxFeedXY.toFixed(0)} mm/s ≤ hardware ${HW.maxSpeedMmS}`,
    `feedrate ${s.maxFeedXY.toFixed(0)} mm/s over the hardware ${HW.maxSpeedMmS}`);
  verdict(s.maxVelocityLimit <= HW.maxSpeedMmS,
    s.maxVelocityLimit ? `speed limit set to ${s.maxVelocityLimit.toFixed(0)} mm/s ≤ hardware ${HW.maxSpeedMmS}` : "the speed limit is the machine's own",
    `SET_VELOCITY_LIMIT raises the speed limit to ${s.maxVelocityLimit.toFixed(0)} mm/s, over the hardware ${HW.maxSpeedMmS}`);
  lines.push({
    state: "ok",
    text: `Z-only moves carry up to ${s.maxFeedZOnly.toFixed(0)} mm/s; Klipper clamps Z to its max_z_velocity (${HW.maxZSpeedMmS} on the 5M) itself`,
  });
  verdict(s.maxAccel <= HW.maxAccel, `highest acceleration ${s.maxAccel.toFixed(0)} mm/s² ≤ hardware ${HW.maxAccel}`,
    `acceleration ${s.maxAccel.toFixed(0)} over the hardware ${HW.maxAccel}`);

  if (Number.isFinite(bedValue)) {
    verdict(Math.abs(s.maxBedC - bedValue) <= 0.5,
      `bed command ${s.maxBedC.toFixed(0)} °C equals the preset's ${bedKey} ${bedC}`,
      `bed commanded ${s.maxBedC.toFixed(0)} °C but the preset's ${bedKey} is ${bedC}`);
  }

  // Every slot counts: a plate printed from slot 10 has 0 mm on slot 1 and is not empty.
  const used = perSlot.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0);
  const usedMm = perSlot.length === 1 ? firstValue(h.get("filament used [mm]")) : used.toFixed(2);
  const layers = h.get("total layer number") ?? String(s.layers);
  const time = h.get("estimated printing time (normal mode)") ?? "?";
  if (perSlot.some((v) => Number.isFinite(v))) {
    verdict(used > 0, `filament used ${usedMm} mm, ${layers} layers, ${time}`, "filament used = 0 — empty slice");
  } else {
    note("filament used unreadable");
  }
  if (["0", "0.00"].includes(firstValue(h.get("total filament used [g]") ?? "1"))) {
    note("filament weight 0 g: the preset has no density; the length is right, the grams are not");
  }

  // A bridge over air longer than the slicer's own limit is told, never failed: the part may still come out right.
  const bridges = openBridgesOf(text, objects ?? besideObjects(path));
  const long = new Map<string, OpenBridge[]>();
  for (const b of bridges) {
    if (b.span <= BRIDGE_UNSUPPORTED_MM) continue;
    const key = b.object ?? "";
    long.set(key, [...(long.get(key) ?? []), b]);
  }
  const place = (b: OpenBridge) => b.object
    ?? `the part at X ${((b.x[0] + b.x[1]) / 2).toFixed(0)} Y ${((b.y[0] + b.y[1]) / 2).toFixed(0)}`;
  const longest = bridges[0];
  if (!long.size) {
    lines.push({
      state: "ok",
      text: longest
        ? `bridges over air: longest ${longest.span.toFixed(1)} mm (${place(longest)}, Z ${longest.z} mm), within the slicer's ${BRIDGE_UNSUPPORTED_MM} mm`
        : "no bridge over air",
    });
  }
  for (const list of long.values()) {
    const worst = list[0];
    if (!worst) continue;
    const more = list.length > 1 ? `, and ${list.length - 1} more over ${BRIDGE_UNSUPPORTED_MM} mm on this part` : "";
    note(`${place(worst)}: a ${worst.span.toFixed(1)} mm bridge over air at Z ${worst.z} mm with nothing under it${more}`
      + ` — longer than the slicer's own ${BRIDGE_UNSUPPORTED_MM} mm for a bridge without support; it can sag or break.`
      + " Add supports under it (build plate only) or turn the part");
  }

  return {
    file: basename(path),
    generatedBy: h.get("generated by") ?? "?",
    lines,
    failures,
    warnings,
    facts: {
      layers, maxZ: s.maxZ, timeEstimate: time, filamentMm: usedMm, filamentType,
      nozzleC, bedC, bedType: bedType === "?" ? BED_TYPE : bedType,
      arcs: s.arcs, relativeMoves: s.relativeMoves, maxFeedXY: s.maxFeedXY, maxAccel: s.maxAccel,
      x: s.x, y: s.y,
    },
    code: failures.length ? 2 : 0,
  };
}
