#!/usr/bin/env node
/**
 * b2f <command> [args] — Bambu to Flashforge Converter
 *
 *   state              what is true right now: Flash Studio, its presets, the work folder (read-only)
 *   inspect FILE       what a file is, and what its designer said; SLICE / CONVERT / CHECK / REFUSE
 *   check FILE.gcode   hold a G-code to the printer's ratings; exit 2 = do not print it (read-only)
 *   split PROJECT.3mf  shells and pieces per object; --split ID… one STL per shell, every other object whole
 *   convert INPUT…     turn a Bambu project (or meshes) into a Flash Studio project for the AD5M 0.4, checked
 *   open FILE.3mf      open a finished project in Flash Studio, to slice and print from there
 */
import { basename } from "node:path";

import { check, type CheckResult } from "./gcode.js";
import { convert } from "./convert.js";
import { openInFlashStudio } from "./flashstudio.js";
import { inspect } from "./inspect.js";
import { PROCESS } from "./machine.js";
import { split } from "./split.js";
import { state } from "./state.js";

const ok = (s: string) => `  ✓ ${s}`;
const bad = (s: string) => `  ✗ ${s}`;
const warn = (s: string) => `  ! ${s}`;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * Every flag a command takes: true when it carries a value, false when it is a switch. A flag not listed is refused,
 * and so is a value flag with nothing after it. Until 2026-10-03 a switch took the next word as its value, so
 * `convert lid.stl --keep base.stl` delivered a project without base.stl and said nothing.
 */
const FLAGS: Record<string, Record<string, boolean>> = {
  convert: {
    process: true, filament: true, scale: true, "scale-z": true, name: true, out: true, set: true, "object-set": true,
    keep: false, "from-mesh": false, "keep-merged": false, "no-arrange": false, "dry-run": false, "keep-custom-gcode": false,
  },
  split: { out: true, "min-tris": true },
  gui: { port: true, open: false },
};

/** Why a flag is gone, when it is. */
const GONE: Record<string, string> = {
  plate: "every plate is converted, and a project that needs two plates on the 5M becomes pt1- and pt2-, each checked",
};

interface Args { positional: string[]; flags: Map<string, string[]>; }

function parse(argv: string[], spec: Record<string, boolean>): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (!(name in spec)) throw new Error(`--${name} is not a flag here${GONE[name] ? `: ${GONE[name]}` : ""}`);
    if (!spec[name]) {
      if (eq >= 0) throw new Error(`--${name} is a switch and takes no value`);
      flags.set(name, []);
      continue;
    }
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new Error(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

/** A value flag's last value. */
const one = (flags: Map<string, string[]>, name: string): string | undefined => flags.get(name)?.at(-1);

/** A positive number, or an error that names the flag. */
function positive(flags: Map<string, string[]>, name: string): number | undefined {
  const text = one(flags, name);
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a number greater than 0, got '${text}'`);
  return value;
}

function cmdState(): number {
  const s = state();
  console.log(`b2f state — ${new Date(s.when).toLocaleString()}`);
  console.log("\nFlash Studio");
  console.log(s.slicer.found ? ok(`AppImage: ${s.slicer.appImage}`) : bad(`no AppImage at ${s.slicer.appImage}`));
  console.log(ok(`settings folder: ${s.slicer.datadir} (the slicer is told to use this one and no other)`));
  console.log(s.slicer.certificates ? ok("certificate bundle present (answers the AppImage's first-launch prompt)") : bad("no certificate bundle"));
  console.log(s.slicer.profiles ? ok("Adventurer 5M 0.4 presets present") : bad(`presets missing: ${s.slicer.missing.map((p) => basename(p)).join(", ")}`));
  console.log(`\nwork  ${s.work.root}  in/: ${s.work.in.length} file(s), out/: ${s.work.out.length}`);
  console.log();
  for (const block of s.blocks) console.log(`BLOCK: ${block}`);
  console.log(`next: ${s.next}`);
  return s.blocks.length ? 1 : 0;
}

async function cmdInspect(path: string): Promise<number> {
  const i = await inspect(path);
  console.log(`${i.file}  (${mb(i.megabytes * 1e6)})`);
  if (i.mesh) console.log(ok(`STL, ${i.mesh.triangles} triangles, ${i.mesh.size.map((n) => n.toFixed(1)).join(" × ")} mm`));
  if (i.project) {
    console.log(ok(`3MF by ${i.project.generator}, made for ${i.project.printerModel} (${i.project.printerSettingsId})`));
    console.log(ok(`process ${i.project.printSettingsId}, layer ${i.project.layerHeight} mm, nozzle ${i.project.nozzle}`));
    console.log(ok(`filaments ${i.project.filaments.length}: ${[...new Set(i.project.filamentTypes)].join(", ")}`));
    console.log(ok(`supports ${i.project.supports ? "ON" : "off"} (${i.project.supportType}), brim ${i.project.brim}, infill ${i.project.infill}`));
  }
  if (i.gcode) {
    console.log(ok(`G-code by ${i.gcode.generatedBy}, for ${i.gcode.printerModel}`));
    console.log(ok(`${i.gcode.layers} layers, max Z ${i.gcode.maxZ} mm, ${i.gcode.time}`));
  }
  const noteKeys = Object.keys(i.notes);
  if (noteKeys.length) {
    console.log("the designer's notes — read these before slicing, nothing downstream carries them:");
    for (const [key, value] of Object.entries(i.notes)) console.log(`    ${key}: ${value.slice(0, 700)}`);
  }
  if (i.objects?.length) {
    console.log("objects (after transforms):");
    for (const o of i.objects) {
      console.log(`    object ${o.objectId}: ${o.size.map((n) => n.toFixed(1)).join(" × ")} mm, ${o.triangles} tris`);
    }
  }
  for (const w of i.warnings) console.log(warn(w));
  console.log(`\nverdict: ${i.verdict}${i.because ? ` — ${i.because}` : ""}`);
  return i.verdict === "REFUSE" ? 2 : 0;
}

/** Exit 2 on anything but a clean read: a file that cannot be read is not a file fit to print. */
function printCheck(path: string | undefined): number {
  if (!path) {
    console.log("give one G-code file to check");
    return 2;
  }
  try {
    return printCheckResult(check(path));
  } catch (err) {
    console.log(bad(`${path}: ${err instanceof Error ? err.message : String(err)}`));
    console.log("\nDO NOT SEND — the file could not be read");
    return 2;
  }
}

function printCheckResult(r: CheckResult): number {
  console.log(`${r.file}  by ${r.generatedBy}`);
  for (const line of r.lines) console.log(line.state === "ok" ? ok(line.text) : line.state === "bad" ? bad(line.text) : warn(line.text));
  console.log();
  if (r.code === 2) {
    console.log(`DO NOT SEND — ${r.failures.length} failure(s)`);
    for (const f of r.failures) console.log(`  - ${f}`);
  } else {
    console.log(`clean: sliced for the Adventurer 5M 0.4, fit to print${r.warnings.length ? ` (${r.warnings.length} warning(s))` : ""}`);
  }
  return r.code;
}

async function cmdConvert(argv: string[]): Promise<number> {
  const { positional, flags } = parse(argv, FLAGS["convert"] ?? {});
  if (!positional.length) { console.log("give a project .3mf, or one or more meshes"); return 1; }
  const processKey = one(flags, "process") ?? "0.20";
  if (!(processKey in PROCESS)) { console.log(`--process must be one of ${Object.keys(PROCESS).join(", ")}`); return 1; }
  const scale = positive(flags, "scale");
  const scaleZ = positive(flags, "scale-z");
  const filament = one(flags, "filament");
  const name = one(flags, "name");
  const out = one(flags, "out");
  let lastStep = "";
  const result = await convert({
    inputs: positional,
    process: processKey as keyof typeof PROCESS,
    ...(filament !== undefined ? { filament } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(scaleZ !== undefined ? { scaleZ } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(out !== undefined ? { out } : {}),
    keep: flags.has("keep"),
    fromMesh: flags.has("from-mesh"),
    keepMerged: flags.has("keep-merged"),
    keepCustomGcode: flags.has("keep-custom-gcode"),
    arrange: !flags.has("no-arrange"),
    overrides: flags.get("set") ?? [],
    objectSets: flags.get("object-set") ?? [],
    dryRun: flags.has("dry-run"),
    onLine: (line) => process.stdout.write(`  ${line}\n`),
    // Each step once, as the slicer names it: the command line's progress bar is a column of them.
    onProgress: (p) => {
      if (p.text === lastStep) return;
      lastStep = p.text;
      process.stdout.write(`  ${String(p.percent).padStart(3)} %  ${p.text}\n`);
    },
  });

  console.log("presets, each flattened through its inherits chain:");
  for (const [label, chain] of Object.entries(result.chains)) console.log(`  ${label}: ${chain.join(" → ")}`);
  if (Object.keys(result.notes).length) {
    console.log("the designer's notes on this model — nothing below carries them, so read them:");
    for (const [key, value] of Object.entries(result.notes)) console.log(`  ${key}: ${value.slice(0, 700)}`);
  }
  if (result.kept.length) {
    console.log("the designer's own settings, kept over the AD5M preset's:");
    for (const k of result.kept) console.log(`  ${k.key}: ${k.now} (the preset has ${k.was})`);
  }
  if (result.overrides.length) {
    console.log("your own choices, on top of the process preset:");
    for (const o of result.overrides) console.log(`  ${o.key}: ${o.was} → ${o.now}`);
  }
  if (result.objectSets?.length) {
    console.log("one object's own settings, the way Flash Studio's Add settings writes them:");
    for (const o of result.objectSets) console.log(`  '${o.object}': ${o.key} = ${o.value}${o.was ? ` (it had ${o.was})` : ""}`);
  }
  if (result.replaced.length) {
    console.log(`the project's own model-facing settings that the AD5M preset replaces (${result.replaced.length}):`);
    for (const r of result.replaced) console.log(`  ${r.key}: ${r.was} → ${r.now}`);
  }
  if (result.collapsed?.moved.length || result.collapsed?.dropped.length) {
    console.log("one extruder — the project was collapsed onto slot 1 in a cleaned copy:");
    for (const m of result.collapsed.moved) console.log(`  ${m}`);
    for (const d of result.collapsed.dropped) console.log(warn(`${d}: taken out; add a pause there in Flash Studio if you want the colour change`));
  }
  for (const k of result.collapsed?.kept ?? []) console.log(warn(`the project's ${k} is kept`));
  const custom = result.collapsed?.custom ?? [];
  if (custom.length) {
    const keptAny = custom.some((c) => c.kept);
    console.log(keptAny
      ? "the designer's own G-code at a layer — kept on --keep-custom-gcode; the check below reads it:"
      : "the designer's own G-code at a layer — taken out (--keep-custom-gcode keeps it, and the check reads it):");
    for (const c of custom) console.log(warn(`${c.at}: ${c.text.replace(/\r?\n/g, " ⏎ ").slice(0, 300)}`));
  }
  if (result.plateNames?.length) {
    console.log("plate names — taken out of the copy the slicer read, its command line crashes on a named plate:");
    for (const n of result.plateNames) console.log(`  ${n}`);
  }
  if (result.thickened) {
    console.log(`${result.thickened.factor}× as thick, same footprint — in the copy the slicer read:`);
    for (const o of result.thickened.objects) {
      const mm = (v: [number, number, number]) => v.map((n) => n.toFixed(1)).join(" × ");
      console.log(`  '${o.name}' ${mm(o.before)} → ${mm(o.after)} mm`);
    }
  }
  for (const o of result.separated?.objects ?? []) {
    const sizes = o.sizes.map((v) => v.map((n) => n.toFixed(1)).join("×")).join(", ");
    console.log(`parts merged into one object — '${o.name}' is ${o.pieces}, taken apart where they sat: ${sizes} mm`);
  }
  for (const h of result.separated?.held ?? []) {
    console.log(warn(`'${h.name}' is ${h.pieces} parts merged into one object, left that way — ${h.why}`));
  }
  if (result.variants?.keys.length) {
    console.log(`nozzle kinds — the project names ${result.variants.kinds.join(" and ")}, the 5M has one; their lists were taken out of the copy the slicer read:`);
    console.log(`  ${result.variants.keys.join(", ")}`);
  }
  if (result.droppedKeys?.length) console.log(warn(`dropped out-of-range keys: ${result.droppedKeys.join(", ")}`));
  for (const n of result.notCarried ?? []) console.log(warn(`not carried from the project: ${n}`));
  if (!result.plates.length) {
    console.log(bad(result.errorString));
    if (result.advice) console.log(`\n${result.advice}${result.meshRetry ? " (--from-mesh)" : ""}`);
    if (result.workKept && result.work) console.log(`work folder kept: ${result.work}`);
    return result.code;
  }
  for (const r of result.checks) {
    console.log(`\n--- check ${r.file}`);
    printCheckResult(r);
  }
  for (const w of result.slicerWarnings) console.log(warn(`Flash Studio warns: ${w}`));
  console.log();
  if (result.workKept) console.log(`work folder kept: ${result.work}`);
  if (!result.delivered) {
    console.log(bad(result.advice ?? "nothing was saved"));
    return result.code;
  }
  for (const r of result.removed ?? []) console.log(ok(`an earlier file of this job is gone: ${basename(r)}`));
  if (result.parts?.length) {
    for (const p of result.parts) console.log(ok(`saved ${p}`));
    console.log(`done: ${result.parts.length} plates, one file each — open them in Flash Studio one at a time, slice and print from there`);
    return result.code;
  }
  console.log(ok(`saved ${result.project3mf}`));
  console.log("done: the one file to open in Flash Studio — slice and print from there (b2f open FILE opens it)");
  return result.code;
}

function cmdOpen(path: string): number {
  const r = openInFlashStudio(path);
  console.log(r.ok ? ok(`Flash Studio is opening ${basename(path)} (pid ${r.pid ?? "?"})`) : bad(r.error ?? "did not start"));
  return r.ok ? 0 : 1;
}

const mm = (size: [number, number, number], digits: number) => size.map((v) => v.toFixed(digits)).join(" × ");

async function cmdSplit(argv: string[]): Promise<number> {
  // --split takes every id that follows it, up to the next flag: --split 3 5, or --split none for all objects whole.
  const ids: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--split") { rest.push(argv[i] ?? ""); continue; }
    while (argv[i + 1] !== undefined && !(argv[i + 1] ?? "").startsWith("--")) ids.push(argv[++i] ?? "");
  }
  const { positional, flags } = parse(rest, FLAGS["split"] ?? {});
  const project = positional[0] ?? "";
  if (!project.toLowerCase().endsWith(".3mf")) { console.log("give one project .3mf"); return 1; }
  const out = one(flags, "out");
  const minTris = positive(flags, "min-tris");
  const result = await split(project, {
    ids,
    ...(out !== undefined ? { out } : {}),
    ...(minTris !== undefined ? { minTris } : {}),
  });
  for (const o of result.objects) {
    const list = o.shells.map((sh) => `${sh.triangles} tris ${sh.size.map((v) => v.toFixed(0)).join("×")} mm`).join(", ");
    const pieces = o.pieceCount > 1 ? ` in ${o.pieceCount} pieces that sit apart` : " in one piece";
    console.log(`object ${o.objectId} '${o.name}': ${o.triangles} triangles, ${o.shellCount} shell(s)${pieces}: ${list}${o.shellCount > 6 ? " …" : ""}`);
    for (const n of o.skipped) console.log(warn(`  skipped a ${n}-triangle fragment`));
    for (const w of o.written) {
      console.log(ok(`  ${basename(w.path)}  ${w.whole ? `whole, ${w.triangles} tris` : `${mm(w.size, 1)} mm, ${w.triangles} tris`}`));
    }
  }
  console.log(ids.length ? `\n${result.written.length} STL(s) in ${result.out}` : "\nreport only — add --split ID to write STLs");
  return 0;
}

const [command, ...rest] = process.argv.slice(2);

let code = 0;
try {
  switch (command) {
    case "state": code = cmdState(); break;
    case "inspect": code = rest[0] ? await cmdInspect(rest[0]) : 1; break;
    case "check": code = printCheck(rest[0]); break;
    case "split": code = await cmdSplit(rest); break;
    case "convert": code = await cmdConvert(rest); break;
    case "open": code = rest[0] ? cmdOpen(rest[0]) : 1; break;
    case "gui": {
      const { serve, DEFAULT_PORT } = await import("./gui.js");
      const { flags } = parse(rest, FLAGS["gui"] ?? {});
      await serve(positive(flags, "port") ?? DEFAULT_PORT, flags.has("open"));
      break; // the server holds the process open; nothing exits below
    }
    default:
      console.log(`b2f <command> [args] — Bambu to Flashforge Converter

  state              what is true right now: Flash Studio, its presets, the work folder (read-only)
  inspect FILE       what a file is, and what its designer said; SLICE / CONVERT / CHECK / REFUSE
  check FILE.gcode   hold a G-code to the printer's ratings; exit 2 = do not print it (read-only)
  split PROJECT.3mf  shells and pieces per object; --split ID… one STL per shell, every other object whole
                     (--split none: all whole — but a piece that sits clear of the rest is still its own STL)
  convert INPUT…     turn a Bambu project (or meshes) into a Flash Studio project for the AD5M 0.4, checked;
                     one .3mf lands in the out folder (~/3dprint/out/ by default), the proof slice is thrown away
                     --process 0.12|0.20|0.24  --filament NAME  --set KEY=VALUE  --name STEM  --out DIR
                     --object-set 'NAME:KEY=VALUE' (one object alone, as Flash Studio's Add settings — e.g. supports
                       under the one part with a long bridge: 'lid.stl:support_type=normal(auto)')
                     --scale F (every direction)  --scale-z F (same footprint, F times as thick)
                     --from-mesh (when the slicer crashes on the project)  --keep (keep the work folder)
                     --keep-merged (leave an object that is really several parts welded into one)
                     --keep-custom-gcode (keep the designer's own G-code at a layer; taken out by default)
  open FILE.3mf      open a finished project in Flash Studio, to slice and print from there`);
      code = command ? 1 : 0;
  }
} catch (err) {
  console.log(bad(err instanceof Error ? err.message : String(err)));
  code = command === "check" ? 2 : 1;
}
if (command !== "gui") process.exit(code);
