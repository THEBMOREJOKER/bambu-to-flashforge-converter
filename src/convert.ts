/**
 * Driving Flash Studio's own command line, with the things it needs done for it: presets flattened (its CLI does not
 * walk an `inherits` chain), the keys a newer Bambu Studio writes out of range taken out of a cleaned copy, every
 * filament slot loaded over, and the project collapsed onto the 5M's one extruder and its one kind of nozzle.
 *
 * The slicer works in a throwaway folder. What comes out is one file: the project for Flash Studio, without G-code,
 * in the out folder — and only when the slice made from it passed the check. Flash Studio slices it again and
 * sends it; the slice here exists to prove the conversion, and goes with the folder.
 *
 * Nothing is typed into a command here. Machine, process and filament are the vendor's files; the only values
 * that come from you are the ones passed as `--set`, and those are refused for anything the machine owns.
 */
import {
  closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  writeFileSync, writeSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import { APPIMAGE, BED_Z, DATADIR, DEFAULT_FILAMENT, MACHINE_JSON, OUTDIR, PROCESS, PROFILES, SSL_CERT } from "./machine.js";
import {
  applyOverrides, carryDesigner, findPreset, PRESET_ONLY, type Replaced, restorePreset, selectableFor5M, settable,
  SETTABLE_HINT, settingsDiff, writeFlatPreset,
} from "./presets.js";
import { check, type CheckResult, plateObjects, type PlateObject } from "./gcode.js";
import { plateMap, type PlateMap } from "./platemap.js";
import { onePlateChanges, platesOf } from "./plates.js";
import { type HeldObject, separation, type SeparatedObject } from "./separate.js";
import { split } from "./split.js";
import { thicken, type ThickenedObject } from "./thicken.js";
import {
  blankPlateNames, type Collapse, collapseFilaments, extruderVariants, type Notes, notes, type ObjectSetting,
  objectSettings, outOfRangeKeys, modelSettings, oneSlot, type OneSlot, type ObjectSet, projectSettings, setObjectSettings,
  sliceWarnings, unslicedChanges, type Variants,
  type Broken, stripBreaks,
} from "./threemf.js";
import { copyZipWith } from "./zipwrite.js";
import { type CustomItem, customItems, LAYERS, placeInSlice, placementsFor, withCustomItems } from "./customgcode.js";
import { Zip } from "./zip.js";

export interface ConvertOptions {
  /** One project (.3mf), or several meshes that become separate objects on one plate. */
  inputs: string[];
  process?: keyof typeof PROCESS;
  filament?: string;
  scale?: number;
  /**
   * Same footprint, this many times as thick — the world Z of every object on the plate. The slicer's own `--scale`
   * is one factor in every direction and cannot do it. Needs a project: a mesh has no placement to scale.
   */
  scaleZ?: number;
  arrange?: boolean;
  name?: string;
  /** Where the finished project goes. Default: the out folder. */
  out?: string;
  /** Keep the work folder (flattened presets, the slice, the log) instead of deleting it. */
  keep?: boolean;
  /** Slice the project's mesh, taken out whole, instead of the project file — the way round a slicer crash. */
  fromMesh?: boolean;
  /** Leave an object that is really several parts merged into one. Off by default: the parts are put back on their own feet. */
  keepMerged?: boolean;
  /** KEY=VALUE decisions about the part, on top of the process preset. */
  overrides?: string[];
  /** NAME:KEY=VALUE — a setting for one object alone, as Flash Studio's "Add settings" makes it: supports under the one part that needs them. */
  objectSets?: string[];
  /**
   * Keep the designer's own G-code at a layer: it goes back into the saved project, and into the proof slice at the
   * layer Flash Studio writes it at, where the check reads it. Off by default: it is taken out, and its text is shown.
   */
  keepCustomGcode?: boolean;
  dryRun?: boolean;
  /** Every line the slicer prints, as it prints it — the GUI shows these live. */
  onLine?: (line: string) => void;
  /** Where the job is, for a progress bar: every stage, and every step the slicer reports. */
  onProgress?: (progress: Progress) => void;
}

/** Where a conversion is: the whole job as one percentage, and what is happening now. */
export interface Progress {
  /** prepare → slice → check → save → done; retry when Flash Studio refused the project's values and slices again. */
  stage: "prepare" | "slice" | "retry" | "check" | "save" | "done";
  /** 0–100 over the whole job. The slicer's own report fills 3–93. */
  percent: number;
  /** What is happening now — while it slices, in the slicer's own words. */
  text: string;
  /** The plate being sliced, and how many there are, while the slicer says. */
  plate?: number;
  plates?: number;
}

/** One step the slicer reports on its progress pipe (`--pipe`): a JSON object per line. */
export interface SlicerReport { message: string; percent: number; plate: number; plates: number; }

export interface ConvertResult {
  /** The folder the finished project goes to. */
  out: string;
  /** The finished project: the one file to open in Flash Studio. Written only when every plate passed the check. */
  project3mf: string;
  /** A project that needs more than one plate is one file per plate — pt1-, pt2- — and project3mf is the first. */
  parts?: string[];
  /** Files an earlier run of this job left beside the one just written, taken away: one file per job. */
  removed?: string[];
  delivered: boolean;
  /** The throwaway folder the slicer worked in; gone unless `workKept`. */
  work: string;
  workKept: boolean;
  /** Plate G-code names. The G-code itself is only the check's evidence and goes with the work folder. */
  plates: string[];
  /** The checks that decide: the plate's own, or with more than one plate, each pt file's. */
  checks: CheckResult[];
  /**
   * With more than one plate, the check of the layout the slicer laid out first. It never prints: each plate is sliced
   * and checked again on a bed of its own, and those checks decide.
   */
  layoutChecks?: CheckResult[];
  /** First layer on the bed, drawn before the G-code goes: each pt file's own when the job is more than one plate. */
  maps: PlateMap[];
  /** What the slicer itself warned about. */
  slicerWarnings: string[];
  chains: { machine: string[]; process: string[]; filament: string[] };
  notes: Notes;
  replaced: Replaced[];
  /** The designer's own supports, brim, infill and walls, carried over the preset's. */
  kept: Replaced[];
  /** Settings given to one object alone (--object-set), and what that object carried before. */
  objectSets?: Array<ObjectSet & { was: string }>;
  overrides: Replaced[];
  command: string[];
  cliExit: number | null;
  cliSignal: NodeJS.Signals | null;
  errorString: string;
  droppedKeys?: string[];
  /** What was changed so the project prints from the 5M's one extruder. */
  collapsed?: Omit<Collapse, "members">;
  /** Plate names taken out of the copy the slicer read: its command line crashes on a named plate. */
  plateNames?: string[];
  /** Nozzle kinds taken out of the copy the slicer read: it dies on a project that names two for the 5M's one. */
  variants?: Variants;
  /** What did not travel when the mesh was taken out whole: an object's own settings, and its separate parts. */
  notCarried?: string[];
  /** Objects that were several parts merged into one, taken apart in the copy the slicer read — and any left as they are. */
  separated?: { objects: SeparatedObject[]; held: HeldObject[] };
  /** Every object made thicker in the copy the slicer read, as it stood and as it stands. */
  thickened?: { factor: number; objects: ThickenedObject[] };
  /** What to do next when this did not work. */
  advice?: string;
  /** The slicer crashed on the project file: the mesh taken out whole is the way through. */
  meshRetry?: boolean;
  code: 0 | 1 | 2;
}

const HEADLESS_NOISE = /FF_CRASH_TRACE|glfwInit|glew library|init opengl failed|skip thumbnail/;

interface CliRun { exit: number | null; signal: NodeJS.Signals | null; result: Record<string, unknown>; }

/**
 * The slicer reports each step on a named pipe when asked (`--pipe`): "Generating walls" at 16 %, "Generating G-code"
 * at 75 %, "All done, Success" at 100 %. The pipe is opened read-write, so the open never waits for the slicer and a
 * slicer that dies before it writes leaves nothing hanging. Without mkfifo the slice runs as before, with no percentage.
 */
function progressPipe(dir: string, onReport: (report: SlicerReport) => void): { path: string; close: () => Promise<void> } | null {
  const path = join(dir, "progress.fifo");
  try {
    rmSync(path, { force: true });
    execFileSync("mkfifo", [path]);
  } catch {
    return null;
  }
  const END = "-- end of reports --";
  const pipe = new Socket({ fd: openSync(path, constants.O_RDWR | constants.O_NONBLOCK) });
  let drained = (): void => undefined;
  let carry = "";
  pipe.on("data", (chunk: Buffer) => {
    const lines = (carry + chunk.toString("utf8")).split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      if (line === END) {
        drained();
        continue;
      }
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        onReport({
          message: String(r["message"] ?? ""), percent: Number(r["total_percent"] ?? 0),
          plate: Number(r["plate_index"] ?? 0), plates: Number(r["plate_count"] ?? 0),
        });
      } catch {
        // a torn or foreign line: the next report carries the state
      }
    }
  });
  // Progress is a courtesy; a pipe that fails never stops the slice.
  pipe.on("error", () => drained());
  // Once the slicer is gone, a line of our own goes into the pipe behind everything it wrote: when that line comes
  // back out, every report has been read — the last one too.
  const close = (): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(() => drained(), 2000);
    drained = () => {
      drained = () => undefined;
      clearTimeout(timer);
      pipe.destroy();
      rmSync(path, { force: true });
      resolve();
    };
    pipe.write(`\n${END}\n`);
  });
  return { path, close };
}

export async function runCli(
  command: string[], out: string, onLine?: (line: string) => void, onReport?: (report: SlicerReport) => void,
): Promise<CliRun> {
  const logPath = join(out, "cli.log");
  // A run that crashes writes no result.json; the retry must not read the first run's refusal as its own.
  rmSync(join(out, "result.json"), { force: true });
  const log = openSync(logPath, "w");
  const [bin, ...args] = command;
  const reports = onReport ? progressPipe(out, onReport) : null;
  const child = spawn(bin ?? "", reports ? ["--pipe", reports.path, ...args] : args, {
    env: { ...process.env, SSL_CERT_FILE: SSL_CERT },
  });

  let carry = "";
  const consume = (chunk: Buffer) => {
    writeSync(log, chunk);
    if (!onLine) return;
    const text = carry + chunk.toString("utf8");
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) {
      // FF_CRASH_TRACE lines are trace noise tagged [error], and a slicer with no display says so about its
      // thumbnails; neither is an error.
      if (line.trim() && !HEADLESS_NOISE.test(line)) onLine(line);
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  const { exit, signal } = await new Promise<{ exit: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, sig) => resolve({ exit: code, signal: sig }));
  });
  closeSync(log);
  await reports?.close();

  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(readFileSync(join(out, "result.json"), "utf8")) as Record<string, unknown>;
  } catch {
    result = {};
  }
  return { exit, signal, result };
}

export async function convert(options: ConvertOptions): Promise<ConvertResult> {
  // A throw after the work folder exists must not leave it behind — this job's folder, by its name: the app runs
  // jobs side by side, and a sweep of every new folder took another job's work with it.
  const job: { work?: string } = {};
  try {
    return await convertIn(options, job);
  } catch (err) {
    if (job.work) rmSync(job.work, { recursive: true, force: true });
    throw err;
  }
}

async function convertIn(options: ConvertOptions, job: { work?: string }): Promise<ConvertResult> {
  const inputs = options.inputs.map((p) => (p.startsWith("/") ? p : join(process.cwd(), p)));
  const first = inputs[0] ?? "";
  const low = first.toLowerCase();
  const fail = (advice: string, code: 1 | 2 = 1): ConvertResult => ({
    out: "", project3mf: "", delivered: false, work: "", workKept: false, plates: [], checks: [], maps: [],
    slicerWarnings: [], chains: { machine: [], process: [], filament: [] }, notes: {}, replaced: [], kept: [], overrides: [],
    command: [], cliExit: null, cliSignal: null, errorString: advice, advice, code,
  });

  for (const input of inputs) if (!existsSync(input)) return fail(`no such file: ${input}`);
  if (inputs.length > 1 && inputs.some((p) => p.toLowerCase().endsWith(".3mf"))) {
    return fail("several inputs must all be geometry (.stl/.step/.obj); a .3mf goes alone");
  }
  if (low.endsWith(".gcode")) {
    return fail("a .gcode has no model to re-slice — check it instead, or find the .3mf or .stl", 2);
  }
  if (![".3mf", ".stl", ".step", ".stp", ".obj"].some((ext) => low.endsWith(ext))) {
    return fail("input must be .3mf, .stl, .step or .obj");
  }
  const isProject = low.endsWith(".3mf");
  const fromMesh = Boolean(options.fromMesh) && isProject;
  const thicker = options.scaleZ ?? 1;
  if (!Number.isFinite(thicker) || thicker <= 0) return fail("--scale-z must be a number greater than 0");
  if (thicker !== 1 && !isProject) {
    return fail("--scale-z needs a project (.3mf): a mesh carries no placement to scale — convert it first, then thicken that");
  }
  if (thicker !== 1 && fromMesh) {
    return fail("--scale-z and --from-mesh do not go together: the mesh is sliced on its own, and the placement --scale-z scales is the project's");
  }
  const objectSets: ObjectSet[] = [];
  for (const pair of options.objectSets ?? []) {
    const eq = pair.indexOf("=");
    const colon = eq < 0 ? -1 : pair.lastIndexOf(":", eq);
    if (colon <= 0) return fail(`--object-set wants NAME:KEY=VALUE, got '${pair}'`);
    const set = { object: pair.slice(0, colon).trim(), key: pair.slice(colon + 1, eq).trim(), value: pair.slice(eq + 1).trim() };
    if (PRESET_ONLY.test(set.key)) {
      return fail(`--object-set refuses '${set.key}': temperatures, speeds, accelerations, flow and fan come from the preset, never from a command line`);
    }
    if (!settable(set.key)) return fail(`--object-set refuses '${set.key}': it takes ${SETTABLE_HINT}`);
    objectSets.push(set);
  }
  if (objectSets.length && !isProject) {
    return fail("--object-set needs a project (.3mf): a mesh has no objects of its own to give a setting to");
  }
  if (objectSets.length && fromMesh) {
    return fail("--object-set and --from-mesh do not go together: the mesh is sliced without the project's objects");
  }
  let last = 0;
  const progress = (stage: Progress["stage"], percent: number, text: string, extra: Partial<Progress> = {}): void => {
    last = Math.max(0, Math.min(100, Math.round(percent)));
    options.onProgress?.({ stage, percent: last, text, ...extra });
  };
  progress("prepare", 0, isProject ? "reading the project" : "reading the model");

  const processKey = options.process ?? "0.20";
  const processPath = join(PROFILES, "process", PROCESS[processKey] ?? "");
  const filamentName = options.filament ?? DEFAULT_FILAMENT;
  const filamentPath = findPreset("filament", filamentName);
  if (!filamentPath) return fail(`no filament preset named '${filamentName}' in Flash Studio's system presets`);
  for (const needed of [APPIMAGE, MACHINE_JSON, processPath]) {
    if (!existsSync(needed)) return fail(`missing: ${needed}`);
  }
  // The project has to name a preset Flash Studio can select, or it opens as an unknown, self-defined one.
  const usable = selectableFor5M(filamentPath);
  if (!usable.ok) return fail(`filament preset '${filamentName}': ${usable.why}`);

  const baseStem = basename(first).replace(/\.[^.]+$/, "");
  const stem = options.name ?? (fromMesh ? `${baseStem}-mesh` : baseStem);
  const out = resolve(options.out ?? OUTDIR);
  // The name is a file name and nothing more: Node's join keeps a "..", and the finished file would land wherever it
  // pointed.
  if (!stem.trim() || /[/\\\0]/.test(stem) || stem === "." || stem === "..") {
    return fail(`the name '${stem}' must be a plain file name: no folder in it, no ".."`);
  }
  const project3mf = join(out, `${stem}-ad5m.3mf`);
  if (!project3mf.startsWith(out + sep)) return fail(`the name '${stem}' leaves ${out}`);
  // Everything the slicer needs and leaves behind lives here, and goes when the job is done.
  const work = mkdtempSync(join(tmpdir(), "b2f-work-"));
  job.work = work;

  // A project carries the designer's instructions and its own settings; both matter before a slice.
  let slots = 1;
  let projectNotes: Notes = {};
  let replaced: Replaced[] = [];
  let project: Record<string, string | string[]> | null = null;
  let broken: Broken[] = [];
  let collapse: Collapse | null = null;
  // The designer's own G-code at a layer, when it is kept: the slicer's command line erases it (--skip-modified-gcodes),
  // so it is carried here, by plate, to every proof slice and every project saved.
  let keptCustom: CustomItem[] = [];
  let modelXml: string | null = null;
  let carried: ObjectSetting[] = [];
  let merged: ObjectSetting[] = [];
  let apart: Awaited<ReturnType<typeof separation>> = null;
  let thick: Awaited<ReturnType<typeof thicken>> = null;
  if (isProject) {
    const zip = new Zip(first);
    try {
      projectNotes = notes(zip);
      if (fromMesh) {
        const objects = objectSettings(zip);
        carried = objects.filter((o) => Object.keys(o.settings).length);
        merged = objects.filter((o) => o.parts > 1);
      } else {
        project = projectSettings(zip);
        if (project) {
          const stripped = stripBreaks(project);
          broken = stripped.found;
          if (broken.length) project = stripped.settings;
        }
        collapse = collapseFilaments(zip, Boolean(options.keepCustomGcode));
        if (options.keepCustomGcode && zip.has(LAYERS)) keptCustom = customItems(zip.readText(LAYERS));
        modelXml = modelSettings(zip);
        const ids = project?.["filament_settings_id"];
        if (Array.isArray(ids) && ids.length) slots = ids.length;
        if (!options.keepMerged) {
          progress("prepare", 1, "reading the model to see what each object is really made of");
          apart = await separation(zip);
        }
        if (thicker !== 1) {
          progress("prepare", 2, `measuring every object, to make it ${thicker}× as thick`);
          thick = await thicken(zip, thicker);
        }
      }
    } finally {
      zip.close();
    }
  }

  // A refusal after the work folder exists takes the folder with it.
  const stop = (advice: string): ConvertResult => {
    rmSync(work, { recursive: true, force: true });
    return { ...fail(advice, 2), notes: projectNotes };
  };
  if (thick && apart?.objects.length) {
    return stop(
      "--scale-z and taking a welded object apart rewrite the same build items, and the pieces stand on placements this "
      + "pass has not measured. Convert once as it is, then thicken that file — or add --keep-merged to leave the object welded.",
    );
  }
  if (thick && thick.maxZ > BED_Z) {
    const tallest = [...thick.objects].sort((a, b) => b.after[2] - a.after[2])[0];
    return stop(
      `${thicker}× as thick puts '${tallest?.name}' ${thick.maxZ.toFixed(1)} mm tall, over the ${BED_Z} mm the bed has: `
      + `${(BED_Z / (thick.maxZ / thicker)).toFixed(2)}× is as thick as this plate goes.`,
    );
  }

  // The way round a project file the slicer crashes on: every object written whole as an STL, and those sliced.
  let sliceInputs = inputs;
  const notCarried = [
    ...carried.map((o) => `${o.name || `object ${o.objectId}`}: ${Object.keys(o.settings).join(", ")}`),
    // One mesh per object: parts the project kept apart are one piece in Flash Studio, where they sat.
    ...merged.map((o) => `${o.name || `object ${o.objectId}`}: its ${o.parts} parts become one piece`),
  ];
  if (fromMesh) {
    progress("prepare", 1, "taking the mesh out of the project whole");
    options.onLine?.("taking the mesh out of the project whole — the slicer crashed on the project file, not on its geometry");
    for (const n of notCarried) options.onLine?.(`not carried: ${n}`);
    options.onLine?.("not carried either: modifiers, painted supports and the designer's layer changes, if the project had any");
    sliceInputs = (await split(first, { ids: ["none"], out: join(work, "mesh") })).written;
  }

  const machine = writeFlatPreset(MACHINE_JSON, "machine", work);
  const flatProcess = writeFlatPreset(processPath, "process", work);
  const filament = writeFlatPreset(filamentPath, "filament", work);
  // The designer's decisions first, then your own --set on top of them.
  let kept = project ? carryDesigner(flatProcess.file, project) : [];
  const applied = options.overrides?.length ? applyOverrides(flatProcess.file, options.overrides) : [];
  if (project) replaced = settingsDiff(project, JSON.parse(readFileSync(flatProcess.file, "utf8")) as Record<string, unknown>);

  const keysOf = (file: string) => new Set(Object.keys(JSON.parse(readFileSync(file, "utf8")) as object));
  const presetKeys = new Set([...keysOf(machine.file), ...keysOf(flatProcess.file)]);
  const filamentKeys = keysOf(filament.file);

  // One extruder, one slot: every per-slot list cut to the slot everything now prints from.
  let single: OneSlot | null = null;
  if (project && slots > 1) {
    const movedXml = collapse?.members["Metadata/model_settings.config"]?.toString("utf8") ?? modelXml;
    single = oneSlot(project, movedXml, filamentKeys, presetKeys);
    options.onLine?.(`one extruder: the project's ${single.from} filament slots become one`);
    slots = 1;
  }

  // One extruder, one kind of nozzle: the slicer dies on a project that names two for the 5M.
  const variants: Variants = project
    ? extruderVariants(project, new Set([...presetKeys, ...filamentKeys]))
    : { kinds: [], keys: [] };

  // The slicer's command line crashes on a plate that has a name, so the names come out of the copy it reads.
  const plateNames = modelXml ? blankPlateNames(modelXml).names : [];

  // One object's own settings — supports under the one part that needs them — go into the copy the slicer reads, as
  // Flash Studio's "Add settings" writes them, so the check holds the slice that carries them.
  let objectApplied: Array<ObjectSet & { was: string }> = [];
  if (objectSets.length) {
    const processKeys = keysOf(flatProcess.file);
    for (const s of objectSets) {
      if (!processKeys.has(s.key)) throw new Error(`--object-set refuses '${s.key}': the process preset has no such setting`);
    }
    const tried = setObjectSettings(modelXml ?? "", objectSets);
    if (tried.unknown.length) {
      throw new Error(`--object-set: no object named ${tried.unknown.map((n) => `'${n}'`).join(", ")} — the project has ${tried.names.map((n) => `'${n}'`).join(", ")}`);
    }
    objectApplied = tried.applied;
  }

  // The slicer is handed a copy whenever the project has to change: slots collapsed, plate names, nozzle kinds and
  // refused keys taken out.
  const cleanedPath = join(work, `${stem}-cleaned-input.3mf`);
  const writeCleaned = (dropKeys: string[]): string => {
    const changes: Record<string, Buffer | null> = { ...(collapse?.members ?? {}) };
    if (single?.modelXml) changes["Metadata/model_settings.config"] = Buffer.from(single.modelXml);
    if (plateNames.length) {
      const current = changes["Metadata/model_settings.config"]?.toString("utf8") ?? modelXml ?? "";
      changes["Metadata/model_settings.config"] = Buffer.from(blankPlateNames(current).xml);
    }
    if (objectSets.length) {
      const current = changes["Metadata/model_settings.config"]?.toString("utf8") ?? modelXml ?? "";
      changes["Metadata/model_settings.config"] = Buffer.from(setObjectSettings(current, objectSets).xml);
    }
    const drop = [...dropKeys, ...variants.keys];
    if ((drop.length || single || broken.length) && project) {
      const settings = { ...(single?.settings ?? project) };
      for (const key of drop) delete settings[key];
      changes["Metadata/project_settings.config"] = Buffer.from(JSON.stringify(settings, null, 4));
    }
    const zip = new Zip(first);
    try {
      if (apart?.objects.length) {
        const current = changes["Metadata/model_settings.config"]?.toString("utf8") ?? modelXml;
        Object.assign(changes, apart.members(zip, current));
      }
      if (thick) {
        const current = changes["Metadata/model_settings.config"]?.toString("utf8") ?? modelXml;
        Object.assign(changes, thick.members(zip, current));
      }
      copyZipWith(zip, cleanedPath, changes);
    } finally {
      zip.close();
    }
    return cleanedPath;
  };
  const collapsed = collapse && (collapse.moved.length || collapse.dropped.length || collapse.kept.length || collapse.custom.length)
    ? { moved: collapse.moved, dropped: collapse.dropped, kept: collapse.kept, custom: collapse.custom }
    : undefined;
  if (single || broken.length || plateNames.length || variants.keys.length || apart?.objects.length || thick
    || objectSets.length || (collapse && Object.keys(collapse.members).length)) {
    sliceInputs = [writeCleaned([])];
    for (const m of collapse?.moved ?? []) options.onLine?.(`one extruder: ${m}`);
    for (const d of collapse?.dropped ?? []) options.onLine?.(`one extruder: the project's ${d} is taken out — add a pause there in Flash Studio if you want the colour change`);
  }
  for (const k of collapse?.kept ?? []) options.onLine?.(`the project's ${k} is kept`);
  for (const c of collapse?.custom ?? []) {
    options.onLine?.(`the designer's own G-code ${c.at}, ${c.kept ? "kept: it goes back into the saved project and into the proof slice at its layer, where the check reads it" : "taken out (--keep-custom-gcode keeps it)"}: ${oneLine(c.text)}`);
  }
  for (const b of broken) {
    options.onLine?.(`line break taken out of ${b.key}${b.slot ? ` slot ${b.slot}` : ""} in the copy the slicer reads — it would have become a command above the start block: ${b.text}`);
  }
  for (const n of plateNames) options.onLine?.(`plate name taken out of the copy the slicer reads, its command line crashes on one — ${n}`);
  for (const a of objectApplied) {
    options.onLine?.(`'${a.object}' alone: ${a.key} = ${a.value}${a.was ? ` (it had ${a.was})` : ""}`);
  }
  if (variants.keys.length) {
    options.onLine?.(`one kind of nozzle: the project names ${variants.kinds.join(" and ")}, the 5M has one — their lists come out of the copy the slicer reads: ${variants.keys.join(", ")}`);
  }
  for (const o of thick?.objects ?? []) {
    const mm = (v: [number, number, number]) => v.map((n) => n.toFixed(1)).join(" × ");
    options.onLine?.(`${thicker}× as thick, same footprint: '${o.name}' ${mm(o.before)} → ${mm(o.after)} mm`);
  }
  for (const o of apart?.objects ?? []) {
    const sizes = o.sizes.map((s) => s.map((v) => v.toFixed(1)).join(" × ")).join(", ");
    options.onLine?.(`'${o.name}' is ${o.pieces} parts merged into one object — each is its own object now, where it sat: ${sizes} mm`);
  }
  for (const h of apart?.held ?? []) {
    options.onLine?.(`'${h.name}' is ${h.pieces} parts merged into one object and is left that way — ${h.why}`);
  }

  const exported = `${stem}-ad5m.3mf`;
  const command = [
    APPIMAGE, "--debug", "1",
    "--datadir", DATADIR,          // the settings folder the presets were read from, and no other
    "--load-settings", `${machine.file};${flatProcess.file}`,
    "--load-filaments", Array.from({ length: slots }, () => filament.file).join(";"),
    "--allow-newer-file",          // bare switches: a 1 after them is read as a file name
    "--skip-modified-gcodes",
    "--arrange", options.arrange === false ? "0" : "1",
    "--slice", "0",
    "--export-3mf", exported,
    "--outputdir", work,
  ];
  if (options.scale) command.push("--scale", String(options.scale));
  command.push(...sliceInputs);

  const base = {
    out, project3mf, work,
    chains: { machine: machine.chain, process: flatProcess.chain, filament: filament.chain },
    notes: projectNotes,
    replaced,
    kept,
    overrides: applied,
    ...(objectApplied.length ? { objectSets: objectApplied } : {}),
    command,
    ...(collapsed ? { collapsed } : {}),
    ...(plateNames.length ? { plateNames } : {}),
    ...(variants.keys.length ? { variants } : {}),
    ...(notCarried.length ? { notCarried } : {}),
    ...(apart ? { separated: { objects: apart.objects, held: apart.held } } : {}),
    ...(thick ? { thickened: { factor: thick.factor, objects: thick.objects } } : {}),
  };
  const finish = (keep: boolean): boolean => {
    if (keep) return true;
    rmSync(work, { recursive: true, force: true });
    return false;
  };
  if (options.dryRun) {
    return {
      ...base, delivered: false, workKept: finish(Boolean(options.keep)), plates: [], checks: [], maps: [],
      slicerWarnings: [], cliExit: null, cliSignal: null, errorString: "", code: 0,
    };
  }

  // The slicer's own report fills 3–93 of the bar; the check and the save take the rest.
  const report = (r: SlicerReport): void =>
    progress("slice", 3 + r.percent * 0.9, r.message, r.plate > 0 ? { plate: r.plate, plates: r.plates } : {});
  progress("prepare", 3, "handing it to Flash Studio's slicer");
  let run = await runCli(command, work, options.onLine, report);
  let droppedKeys: string[] | undefined;

  // A newer Bambu Studio writes values this Orca refuses outright. Take exactly those keys out of a copy and retry.
  if (String(run.result["error_string"] ?? "").includes("Invalid parameter") && isProject && project) {
    const named = new Set(
      [...readFileSync(join(work, "cli.log"), "utf8").matchAll(/^\s*(\w+): \S+ not in range/gm)].map((m) => m[1] ?? ""),
    );
    for (const key of outOfRangeKeys(project)) named.add(key);
    droppedKeys = [...named].filter(Boolean).sort();
    if (droppedKeys.length) {
      // A value carried onto the preset is refused there too: the preset's own goes back.
      const refused = kept.filter((k) => droppedKeys?.includes(k.key)).map((k) => k.key);
      if (refused.length) {
        restorePreset(flatProcess.file, flatProcess.flat, refused);
        kept = kept.filter((k) => !refused.includes(k.key));
        base.kept = kept;
      }
      const cleaned = writeCleaned(droppedKeys);
      options.onLine?.(`the project carries values Flash Studio refuses: ${droppedKeys.join(", ")} — dropped from a cleaned copy, re-running once`);
      progress("retry", 3, `Flash Studio refused ${droppedKeys.length} of the project's values — dropped them, slicing again`);
      command.splice(command.length - 1, 1, cleaned);   // a .3mf goes alone
      run = await runCli(command, work, options.onLine, report);
    }
  }

  const segfault = run.signal === "SIGSEGV" || run.exit === null;
  const plates = readdirSync(work).filter((f) => f.startsWith("plate_") && f.endsWith(".gcode")).sort();
  const errorString = String(run.result["error_string"] ?? (segfault ? "the slicer crashed (segfault)" : "(no result.json)"));
  // What the slicer says about each plate — "floating regions", an empty layer — is in result.json, not the project.
  const plateWarnings = plateWarningsOf(run.result);

  if (!plates.length) {
    const retry = segfault && isProject && !fromMesh;
    const advice = retry
      ? "Flash Studio's CLI crashes on this project file, not on its geometry — convert the mesh taken out whole instead"
      : `the slicer wrote no plate: ${errorString}`;
    progress("done", last, segfault ? "the slicer crashed" : "the slicer wrote no plate");
    return {
      ...base, delivered: false, workKept: finish(true), plates: [], checks: [], maps: [], slicerWarnings: plateWarnings,
      cliExit: run.exit, cliSignal: run.signal, errorString,
      ...(droppedKeys ? { droppedKeys } : {}), advice, ...(retry ? { meshRetry: true } : {}), code: 2,
    };
  }

  progress("check", 94, plates.length > 1 ? `checking ${plates.length} plates against the 5M` : "checking the plate against the 5M");
  const exportedLayers = layersOf(join(work, exported));
  // A kept item whose plate is gone after arranging has nothing to run on, and it was asked for: the job stops.
  const lost = [...new Set(keptCustom.map((i) => i.plate))].filter((plate) => !plates.includes(`plate_${plate}.gcode`));
  const customFailure = lost.length
    ? `the designer's own G-code on plate ${lost.join(", ")} has no plate after arranging (the slicer laid the job out on `
      + `${plates.length} plate(s)): ${keptCustom.filter((i) => lost.includes(i.plate)).map((i) => `${i.z} mm, ${oneLine(i.text)}`).join("; ")}`
      + ` — convert again without --keep-custom-gcode, and add it by hand in Flash Studio at that height on the plate that`
      + ` holds the parts it was meant for (--no-arrange keeps the designer's plates only when they already sit on the 5M's`
      + ` bed, and a Bambu project's do not)`
    : "";
  if (customFailure) options.onLine?.(customFailure);
  const firstChecks = plates.map((p) =>
    check(withDesignerGcode(join(work, p), exportedLayers, keptCustom, options.onLine), exportedObjects(join(work, exported), p)));
  const maps = plates.map((p) => plateMap(join(work, p)));
  const next = afterFirstSlice(plates.length, firstChecks.some((c) => c.code === 2), Boolean(customFailure));
  // One plate: its check decides. More than one: the layout the slicer laid out first never prints; each pt file is
  // sliced and checked on a bed of its own below, and those checks decide.
  const checks = plates.length > 1 ? [] : firstChecks;
  const layoutChecks = plates.length > 1 ? firstChecks : [];
  for (const [n, c] of layoutChecks.entries()) {
    if (c.code === 2) {
      options.onLine?.(`the layout the slicer laid out first fails the check on plate ${n + 1} (${c.failures[0] ?? ""}); it never prints — each plate is sliced and checked on a bed of its own`);
    }
  }
  let worst = next === "stop" ? 2 : 0;

  // More than one plate: one project per plate (pt1-, pt2-, …), each arranged and sliced again on a bed of its own, so
  // no file carries a second plate and every part is checked as the file that prints it.
  const parts: string[] = [];
  let partFailure = "";
  const partWarnings: string[] = [];
  /** Each pt file's own first layer: it prints, and the first layout's never does. */
  const partMaps: PlateMap[] = [];
  if (next === "split" && existsSync(join(work, exported))) {
    progress("save", 95, `${plates.length} plates: one file per plate`);
    let layout: ReturnType<typeof platesOf> = [];
    const zip = new Zip(join(work, exported));
    try {
      if (zip.has("Metadata/model_settings.config")) layout = platesOf(zip.readText("Metadata/model_settings.config"));
      for (const p of layout) {
        const changes = onePlateChanges(zip, p.plate, p.objects);
        const mine = partItems(keptCustom, p.plate);
        if (mine.length) changes[LAYERS] = Buffer.from(withCustomItems(changes[LAYERS]?.toString("utf8") ?? null, 1, mine));
        copyZipWith(zip, join(work, `pt${p.plate}-input.3mf`), changes);
      }
    } finally {
      zip.close();
    }
    if (layout.length !== plates.length) partFailure = `the project names ${layout.length} plate(s) for ${plates.length} sliced`;
    const at = command.indexOf("--outputdir");
    const staged: Array<{ dir: string; name: string; plate: number }> = [];
    for (const p of partFailure ? [] : layout) {
      const name = `pt${p.plate}-${stem}-ad5m.3mf`;
      const dir = join(work, `pt${p.plate}`);
      mkdirSync(dir);
      const partCommand = [...command.slice(0, at), "--outputdir", dir, join(work, `pt${p.plate}-input.3mf`)];
      partCommand[partCommand.indexOf("--arrange") + 1] = "1";
      partCommand[partCommand.indexOf("--export-3mf") + 1] = name;
      options.onLine?.(`plate ${p.plate}: ${p.objects.length} object(s) → ${name}, arranged and sliced on a bed of its own`);
      const partRun = await runCli(partCommand, dir, options.onLine);
      for (const w of plateWarningsOf(partRun.result)) partWarnings.push(`pt${p.plate}: ${w}`);
      const gcodes = readdirSync(dir).filter((f) => f.startsWith("plate_") && f.endsWith(".gcode"));
      if (gcodes.length !== 1 || !existsSync(join(dir, name))) {
        partFailure = `plate ${p.plate} does not slice onto one bed by itself (${gcodes.length} plates): `
          + String(partRun.result["error_string"] ?? "no result");
        break;
      }
      const partGcode = withDesignerGcode(join(dir, gcodes[0] ?? ""), layersOf(join(dir, name)), partItems(keptCustom, p.plate), options.onLine);
      const partCheck = check(partGcode, exportedObjects(join(dir, name), gcodes[0] ?? ""));
      checks.push(partCheck);
      partMaps.push(plateMap(join(dir, gcodes[0] ?? "")));
      if (partCheck.code === 2) {
        partFailure = `${name} failed the check`;
        break;
      }
      staged.push({ dir, name, plate: p.plate });
    }
    if (partFailure) {
      worst = 2;
    } else {
      mkdirSync(out, { recursive: true });
      for (const { dir, name, plate } of staged) {
        const part = join(out, `${name}.part`);
        const from = new Zip(join(dir, name));
        try {
          copyZipWith(from, part, withKeptCustom(from, unslicedChanges(from), [1], partItems(keptCustom, plate)));
        } finally {
          from.close();
        }
        renameSync(part, join(out, name));
        parts.push(join(out, name));
      }
    }
  }

  // Only a project whose every plate passed goes to the out folder, and without the G-code: Flash Studio slices
  // it again when it opens it, and the file matches what Flash Studio itself saves.
  let slicerWarnings: string[] = [];
  let delivered = false;
  if (existsSync(join(work, exported))) {
    const zip = new Zip(join(work, exported));
    try {
      slicerWarnings = sliceWarnings(zip);
      if (worst === 0 && !parts.length) {
        progress("save", 97, "writing the project for Flash Studio");
        mkdirSync(out, { recursive: true });
        const part = `${project3mf}.part`;
        const sliced = plates.map((p) => Number(/^plate_(\d+)\.gcode$/.exec(p)?.[1] ?? 0));
        copyZipWith(zip, part, withKeptCustom(zip, unslicedChanges(zip), sliced, keptCustom));
        renameSync(part, project3mf);
        delivered = true;
      }
    } finally {
      zip.close();
    }
  }
  slicerWarnings = [...new Set([...plateWarnings, ...slicerWarnings, ...partWarnings])];
  if (parts.length) delivered = true;
  // One file per job: what an earlier run of this job left beside the file just written goes — a single file when
  // the job is now pt-files, pt-files when it is now one file, a pt3 when it is now two plates.
  const removed = delivered ? staleOutputs(out, stem, parts.length ? parts : [project3mf]) : [];
  for (const r of removed) {
    rmSync(r, { force: true });
    options.onLine?.(`an earlier file of this job is gone: ${basename(r)}`);
  }
  for (const w of slicerWarnings) options.onLine?.(`Flash Studio warns: ${w}`);
  progress("done", delivered ? 100 : last, delivered ? "saved for Flash Studio" : worst === 2 ? "a plate failed the check" : "no project was written");

  const advice = customFailure
    ? `${customFailure}. Nothing was written to ${out}; the slice is in ${work}`
    : partFailure
    ? `${partFailure} — nothing was written to ${out}; the slices are in ${work}`
    : worst === 2
    ? `a plate failed the check — nothing was written to ${out}; the slice is in ${work}`
    : delivered ? undefined : `the slicer wrote no project file; the slice is in ${work}`;
  return {
    ...base, ...(parts.length ? { project3mf: parts[0] ?? project3mf, parts } : {}),
    ...(removed.length ? { removed } : {}),
    delivered, workKept: finish(Boolean(options.keep) || !delivered),
    plates, checks, ...(layoutChecks.length ? { layoutChecks } : {}), maps: partMaps.length ? partMaps : maps, slicerWarnings,
    cliExit: run.exit, cliSignal: run.signal, errorString,
    ...(droppedKeys ? { droppedKeys } : {}),
    ...(advice ? { advice } : {}),
    code: worst === 2 || !delivered ? 2 : 0,
  };
}

/** Text on one line for a log: line breaks shown, cut short. */
const oneLine = (text: string) => {
  const flat = text.replace(/\r?\n/g, " ⏎ ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)} …` : flat;
};

/**
 * What follows the first slice: one plate goes on to be saved if its check passed; more than one is cut into pt files
 * whatever the first layout's check said, because that layout never prints; a kept G-code with no plate stops the job.
 */
export function afterFirstSlice(plates: number, firstFailed: boolean, customFailure: boolean): "single" | "split" | "stop" {
  if (customFailure) return "stop";
  if (plates > 1) return "split";
  return firstFailed ? "stop" : "single";
}

/** The layer list a project carries, or null. */
function layersOf(project: string): string | null {
  if (!existsSync(project)) return null;
  const zip = new Zip(project);
  try {
    return zip.has(LAYERS) ? zip.readText(LAYERS) : null;
  } finally {
    zip.close();
  }
}

/** The kept items of one plate, as the project cut to that plate numbers them: plate 1. */
function partItems(items: readonly CustomItem[], plate: number): CustomItem[] {
  return items.filter((i) => i.plate === plate).map((i) => ({ ...i, plate: 1 }));
}

/**
 * The slice to check: the slice itself, or, when the designer's own G-code is kept for its plate, a copy beside it
 * with that G-code written where Flash Studio writes it, so the check reads every line of it. Each item's place is
 * said, and so is an item Flash Studio would not write.
 */
function withDesignerGcode(path: string, layersXml: string | null, items: readonly CustomItem[],
  onLine?: (line: string) => void): string {
  const plate = Number(/plate_(\d+)\.gcode$/.exec(basename(path))?.[1] ?? 0);
  if (!items.some((i) => i.plate === plate)) return path;
  const gcode = readFileSync(path, "utf8");
  const placements = placementsFor(gcode, layersXml, plate, items);
  const part = basename(dirname(path));
  const where = /^pt\d+$/.test(part) ? `${part}'s slice` : basename(path);
  for (const p of placements) {
    onLine?.(p.layer === null
      ? `the designer's own G-code at ${p.item.z} mm is not placed: ${p.why}: ${oneLine(p.item.text)}`
      : `the designer's own G-code at ${p.item.z} mm runs at the start of layer Z ${p.layer} in ${where}, and the check reads it there: ${oneLine(p.item.text)}`);
  }
  const dir = join(dirname(path), "with-designer-gcode");
  mkdirSync(dir, { recursive: true });
  const placed = join(dir, basename(path));
  writeFileSync(placed, placeInSlice(gcode, placements));
  return placed;
}

/** A saved project's changes, with the designer's kept G-code written back into the plates given. */
function withKeptCustom(zip: Zip, changes: Record<string, Buffer | null>, plates: readonly number[],
  items: readonly CustomItem[]): Record<string, Buffer | null> {
  let xml = zip.has(LAYERS) ? zip.readText(LAYERS) : null;
  let changed = false;
  for (const plate of plates) {
    const mine = items.filter((i) => i.plate === plate);
    if (!mine.length) continue;
    xml = withCustomItems(xml, plate, mine);
    changed = true;
  }
  return changed && xml !== null ? { ...changes, [LAYERS]: Buffer.from(xml) } : changes;
}

/**
 * The files of this job in `out` other than the ones just written: `<stem>-ad5m.3mf` and `pt<N>-<stem>-ad5m.3mf`, by
 * exact name. A job is its stem; no other file is touched.
 */
export function staleOutputs(out: string, stem: string, written: readonly string[]): string[] {
  if (!existsSync(out)) return [];
  const keep = new Set(written.map((p) => basename(p)));
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mine = new RegExp(`^(pt\\d+-)?${escaped}-ad5m\\.3mf$`);
  return readdirSync(out).filter((f) => mine.test(f) && !keep.has(f)).sort().map((f) => join(out, f));
}

/** The objects the slicer placed on a plate, from the plate_N.json in the project it exported beside the G-code. */
export function exportedObjects(project: string, gcode: string): PlateObject[] {
  if (!existsSync(project)) return [];
  const zip = new Zip(project);
  try {
    const json = `Metadata/${gcode.replace(/\.gcode$/i, ".json")}`;
    return zip.has(json) ? plateObjects(zip.readText(json)) : [];
  } finally {
    zip.close();
  }
}

/** Each plate's warning in result.json, one line per warning, with the plate named when there are several. */
export function plateWarningsOf(result: Record<string, unknown>): string[] {
  const plates = Array.isArray(result["sliced_plates"]) ? result["sliced_plates"] as Record<string, unknown>[] : [];
  return plates.flatMap((p) => {
    const text = String(p["warning_message"] ?? "").trim().replace(/\s*\n\s*/g, " — ");
    if (!text) return [];
    return [plates.length > 1 ? `plate ${String(p["id"] ?? "?")}: ${text}` : text];
  });
}
