#!/usr/bin/env node
/**
 * b2f <command> [args] — Bambu to Flashforge Converter
 *
 *   state              what is true right now: Flash Studio, its presets, the work folder (read-only)
 *   inspect FILE       what a file is, and what its designer said; SLICE / CONVERT / CHECK / REFUSE
 *   check FILE.gcode   hold a G-code to the printer's ratings; exit 2 = do not print it (read-only)
 *   split PROJECT.3mf  shells per object; --split ID… writes one STL per shell, every other object whole
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

interface Args { positional: string[]; flags: Map<string, string | true>; }

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split("=", 2);
    const next = argv[i + 1];
    if (inline !== undefined) flags.set(name ?? "", inline);
    else if (next && !next.startsWith("--")) { flags.set(name ?? "", next); i++; }
    else flags.set(name ?? "", true);
  }
  return { positional, flags };
}

function all(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1]) { out.push(argv[i + 1] ?? ""); i++; }
    else if ((argv[i] ?? "").startsWith(`--${name}=`)) out.push((argv[i] ?? "").split("=").slice(1).join("="));
  }
  return out;
}

function cmdState(): number {
  const s = state();
  console.log(`b2f state — ${new Date(s.when).toLocaleString()}`);
  console.log("\nFlash Studio");
  console.log(s.slicer.found ? ok(`AppImage: ${s.slicer.appImage}`) : bad(`no AppImage at ${s.slicer.appImage}`));
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

function printCheck(path: string): number {
  return printCheckResult(check(path));
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
  const { positional, flags } = parse(argv);
  const processKey = String(flags.get("process") ?? "0.20");
  if (!(processKey in PROCESS)) { console.log(`--process must be one of ${Object.keys(PROCESS).join(", ")}`); return 1; }
  const result = await convert({
    inputs: positional,
    process: processKey as keyof typeof PROCESS,
    ...(flags.has("filament") ? { filament: String(flags.get("filament")) } : {}),
    ...(flags.has("plate") ? { plate: String(flags.get("plate")) } : {}),
    ...(flags.has("scale") ? { scale: Number(flags.get("scale")) } : {}),
    ...(flags.has("name") ? { name: String(flags.get("name")) } : {}),
    ...(flags.has("out") ? { out: String(flags.get("out")) } : {}),
    keep: flags.has("keep"),
    fromMesh: flags.has("from-mesh"),
    arrange: !flags.has("no-arrange"),
    overrides: all(argv, "set"),
    dryRun: flags.has("dry-run"),
    onLine: (line) => process.stdout.write(`  ${line}\n`),
  });

  console.log("presets, each flattened through its inherits chain:");
  for (const [label, chain] of Object.entries(result.chains)) console.log(`  ${label}: ${chain.join(" → ")}`);
  if (Object.keys(result.notes).length) {
    console.log("the designer's notes on this model — nothing below carries them, so read them:");
    for (const [key, value] of Object.entries(result.notes)) console.log(`  ${key}: ${value.slice(0, 700)}`);
  }
  if (result.overrides.length) {
    console.log("your own choices, on top of the process preset:");
    for (const o of result.overrides) console.log(`  ${o.key}: ${o.was} → ${o.now}`);
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
  if (result.plateNames?.length) {
    console.log("plate names — taken out of the copy the slicer read, its command line crashes on a named plate:");
    for (const n of result.plateNames) console.log(`  ${n}`);
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
  const { positional, flags } = parse(rest);
  const project = positional[0] ?? "";
  if (!project.toLowerCase().endsWith(".3mf")) { console.log("give one project .3mf"); return 1; }
  const result = await split(project, {
    ids,
    ...(flags.has("out") ? { out: String(flags.get("out")) } : {}),
    ...(flags.has("min-tris") ? { minTris: Number(flags.get("min-tris")) } : {}),
  });
  for (const o of result.objects) {
    const list = o.shells.map((sh) => `${sh.triangles} tris ${sh.size.map((v) => v.toFixed(0)).join("×")} mm`).join(", ");
    console.log(`object ${o.objectId} '${o.name}': ${o.triangles} triangles, ${o.shellCount} shell(s): ${list}${o.shellCount > 6 ? " …" : ""}`);
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
switch (command) {
  case "state": code = cmdState(); break;
  case "inspect": code = rest[0] ? await cmdInspect(rest[0]) : 1; break;
  case "check": code = rest[0] ? printCheck(rest[0]) : 1; break;
  case "split": code = await cmdSplit(rest); break;
  case "convert": code = await cmdConvert(rest); break;
  case "open": code = rest[0] ? cmdOpen(rest[0]) : 1; break;
  case "gui": {
    const { serve, DEFAULT_PORT } = await import("./gui.js");
    const { flags } = parse(rest);
    await serve(Number(flags.get("port") ?? DEFAULT_PORT), flags.has("open"));
    break; // the server holds the process open; nothing exits below
  }
  default:
    console.log(`b2f <command> [args] — Bambu to Flashforge Converter

  state              what is true right now: Flash Studio, its presets, the work folder (read-only)
  inspect FILE       what a file is, and what its designer said; SLICE / CONVERT / CHECK / REFUSE
  check FILE.gcode   hold a G-code to the printer's ratings; exit 2 = do not print it (read-only)
  split PROJECT.3mf  shells per object; --split ID… one STL per shell, every other object whole (--split none: all whole)
  convert INPUT…     turn a Bambu project (or meshes) into a Flash Studio project for the AD5M 0.4, checked;
                     one .3mf lands in the out folder (~/3dprint/out/ by default), the proof slice is thrown away
                     --process 0.12|0.20|0.24  --filament NAME  --set KEY=VALUE  --name STEM  --out DIR
                     --from-mesh (when the slicer crashes on the project)  --keep (keep the work folder)
  open FILE.3mf      open a finished project in Flash Studio, to slice and print from there`);
    code = command ? 1 : 0;
}
if (command !== "gui") process.exit(code);
