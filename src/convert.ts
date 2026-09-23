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
  writeSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { APPIMAGE, DEFAULT_FILAMENT, MACHINE_JSON, OUTDIR, PROCESS, PROFILES, SSL_CERT } from "./machine.js";
import { applyOverrides, findPreset, type Replaced, selectableFor5M, settingsDiff, writeFlatPreset } from "./presets.js";
import { check, type CheckResult } from "./gcode.js";
import { plateMap, type PlateMap } from "./platemap.js";
import { split } from "./split.js";
import {
  blankPlateNames, type Collapse, collapseFilaments, extruderVariants, type Notes, notes, type ObjectSetting,
  objectSettings, outOfRangeKeys, modelSettings, oneSlot, type OneSlot, projectSettings, sliceWarnings,
  unslicedChanges, type Variants,
  type Broken, stripBreaks,
} from "./threemf.js";
import { copyZipWith } from "./zipwrite.js";
import { Zip } from "./zip.js";

export interface ConvertOptions {
  /** One project (.3mf), or several meshes that become separate objects on one plate. */
  inputs: string[];
  process?: keyof typeof PROCESS;
  filament?: string;
  /** "0" slices every plate. */
  plate?: string;
  scale?: number;
  arrange?: boolean;
  name?: string;
  /** Where the finished project goes. Default: the out folder. */
  out?: string;
  /** Keep the work folder (flattened presets, the slice, the log) instead of deleting it. */
  keep?: boolean;
  /** Slice the project's mesh, taken out whole, instead of the project file — the way round a slicer crash. */
  fromMesh?: boolean;
  /** KEY=VALUE decisions about the part, on top of the process preset. */
  overrides?: string[];
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
  delivered: boolean;
  /** The throwaway folder the slicer worked in; gone unless `workKept`. */
  work: string;
  workKept: boolean;
  /** Plate G-code names. The G-code itself is only the check's evidence and goes with the work folder. */
  plates: string[];
  checks: CheckResult[];
  /** First layer on the bed, drawn before the G-code goes. */
  maps: PlateMap[];
  /** What the slicer itself warned about. */
  slicerWarnings: string[];
  chains: { machine: string[]; process: string[]; filament: string[] };
  notes: Notes;
  replaced: Replaced[];
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
  // A throw after the work folder exists must not leave it behind.
  const before = new Set(existsSync(tmpdir()) ? readdirSync(tmpdir()).filter((f) => f.startsWith("b2f-work-")) : []);
  try {
    return await convertIn(options);
  } catch (err) {
    for (const f of readdirSync(tmpdir())) {
      if (f.startsWith("b2f-work-") && !before.has(f)) rmSync(join(tmpdir(), f), { recursive: true, force: true });
    }
    throw err;
  }
}

async function convertIn(options: ConvertOptions): Promise<ConvertResult> {
  const inputs = options.inputs.map((p) => (p.startsWith("/") ? p : join(process.cwd(), p)));
  const first = inputs[0] ?? "";
  const low = first.toLowerCase();
  const fail = (advice: string, code: 1 | 2 = 1): ConvertResult => ({
    out: "", project3mf: "", delivered: false, work: "", workKept: false, plates: [], checks: [], maps: [],
    slicerWarnings: [], chains: { machine: [], process: [], filament: [] }, notes: {}, replaced: [], overrides: [],
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
  const out = options.out ?? OUTDIR;
  const project3mf = join(out, `${stem}-ad5m.3mf`);
  // Everything the slicer needs and leaves behind lives here, and goes when the job is done.
  const work = mkdtempSync(join(tmpdir(), "b2f-work-"));

  // A project carries the designer's instructions and its own settings; both matter before a slice.
  let slots = 1;
  let projectNotes: Notes = {};
  let replaced: Replaced[] = [];
  let project: Record<string, string | string[]> | null = null;
  let broken: Broken[] = [];
  let collapse: Collapse | null = null;
  let modelXml: string | null = null;
  let carried: ObjectSetting[] = [];
  let merged: ObjectSetting[] = [];
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
        collapse = collapseFilaments(zip);
        modelXml = modelSettings(zip);
        const ids = project?.["filament_settings_id"];
        if (Array.isArray(ids) && ids.length) slots = ids.length;
      }
    } finally {
      zip.close();
    }
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
    const drop = [...dropKeys, ...variants.keys];
    if ((drop.length || single || broken.length) && project) {
      const settings = { ...(single?.settings ?? project) };
      for (const key of drop) delete settings[key];
      changes["Metadata/project_settings.config"] = Buffer.from(JSON.stringify(settings, null, 4));
    }
    const zip = new Zip(first);
    try {
      copyZipWith(zip, cleanedPath, changes);
    } finally {
      zip.close();
    }
    return cleanedPath;
  };
  const collapsed = collapse && (collapse.moved.length || collapse.dropped.length || collapse.kept.length)
    ? { moved: collapse.moved, dropped: collapse.dropped, kept: collapse.kept }
    : undefined;
  if (single || broken.length || plateNames.length || variants.keys.length || (collapse && Object.keys(collapse.members).length)) {
    sliceInputs = [writeCleaned([])];
    for (const m of collapse?.moved ?? []) options.onLine?.(`one extruder: ${m}`);
    for (const d of collapse?.dropped ?? []) options.onLine?.(`one extruder: the project's ${d} is taken out — add a pause there in Flash Studio if you want the colour change`);
  }
  for (const k of collapse?.kept ?? []) options.onLine?.(`the project's ${k} is kept`);
  for (const b of broken) {
    options.onLine?.(`line break taken out of ${b.key}${b.slot ? ` slot ${b.slot}` : ""} in the copy the slicer reads — it would have become a command above the start block: ${b.text}`);
  }
  for (const n of plateNames) options.onLine?.(`plate name taken out of the copy the slicer reads, its command line crashes on one — ${n}`);
  if (variants.keys.length) {
    options.onLine?.(`one kind of nozzle: the project names ${variants.kinds.join(" and ")}, the 5M has one — their lists come out of the copy the slicer reads: ${variants.keys.join(", ")}`);
  }

  const exported = `${stem}-ad5m.3mf`;
  const command = [
    APPIMAGE, "--debug", "1",
    "--load-settings", `${machine.file};${flatProcess.file}`,
    "--load-filaments", Array.from({ length: slots }, () => filament.file).join(";"),
    "--allow-newer-file",          // bare switches: a 1 after them is read as a file name
    "--skip-modified-gcodes",
    "--arrange", options.arrange === false ? "0" : "1",
    "--slice", options.plate ?? "0",
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
    overrides: applied,
    command,
    ...(collapsed ? { collapsed } : {}),
    ...(plateNames.length ? { plateNames } : {}),
    ...(variants.keys.length ? { variants } : {}),
    ...(notCarried.length ? { notCarried } : {}),
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

  if (!plates.length) {
    const retry = segfault && isProject && !fromMesh;
    const advice = retry
      ? "Flash Studio's CLI crashes on this project file, not on its geometry — convert the mesh taken out whole instead"
      : `the slicer wrote no plate: ${errorString}`;
    progress("done", last, segfault ? "the slicer crashed" : "the slicer wrote no plate");
    return {
      ...base, delivered: false, workKept: finish(true), plates: [], checks: [], maps: [], slicerWarnings: [],
      cliExit: run.exit, cliSignal: run.signal, errorString,
      ...(droppedKeys ? { droppedKeys } : {}), advice, ...(retry ? { meshRetry: true } : {}), code: 2,
    };
  }

  progress("check", 94, plates.length > 1 ? `checking ${plates.length} plates against the 5M` : "checking the plate against the 5M");
  const checks = plates.map((p) => check(join(work, p)));
  const maps = plates.map((p) => plateMap(join(work, p)));
  const worst = checks.some((c) => c.code === 2) ? 2 : 0;

  // Only a project whose every plate passed goes to the out folder, and without the G-code: Flash Studio slices
  // it again when it opens it, and the file matches what Flash Studio itself saves.
  let slicerWarnings: string[] = [];
  let delivered = false;
  if (existsSync(join(work, exported))) {
    const zip = new Zip(join(work, exported));
    try {
      slicerWarnings = sliceWarnings(zip);
      if (worst === 0) {
        progress("save", 97, "writing the project for Flash Studio");
        mkdirSync(out, { recursive: true });
        const part = `${project3mf}.part`;
        copyZipWith(zip, part, unslicedChanges(zip));
        renameSync(part, project3mf);
        delivered = true;
      }
    } finally {
      zip.close();
    }
  }
  for (const w of slicerWarnings) options.onLine?.(`Flash Studio warns: ${w}`);
  progress("done", delivered ? 100 : last, delivered ? "saved for Flash Studio" : worst === 2 ? "a plate failed the check" : "no project was written");

  const advice = worst === 2
    ? `a plate failed the check — nothing was written to ${out}; the slice is in ${work}`
    : delivered ? undefined : `the slicer wrote no project file; the slice is in ${work}`;
  return {
    ...base, delivered, workKept: finish(Boolean(options.keep) || !delivered),
    plates, checks, maps, slicerWarnings,
    cliExit: run.exit, cliSignal: run.signal, errorString,
    ...(droppedKeys ? { droppedKeys } : {}),
    ...(advice ? { advice } : {}),
    code: worst === 2 || !delivered ? 2 : 0,
  };
}
