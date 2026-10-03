/**
 * The command line, run as a person runs it. None of these reach the slicer: each is refused before it would.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const CLI = join(import.meta.dirname, "../src/cli.js");
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const dir = mkdtempSync(join(tmpdir(), "b2f-cli-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("check exits 2 on a file it cannot read, and on no file at all", () => {
  assert.equal(run("check", join(dir, "missing.gcode")).code, 2);
  assert.equal(run("check").code, 2);
});

test("check exits 2 on a line the firmware would run that the check cannot hold", () => {
  const path = join(dir, "t.gcode");
  writeFileSync(path, "; printer_model = Flashforge Adventurer 5M\nM104S400\n");
  assert.equal(run("check", path).code, 2);
});

test("a switch never takes the next word: an input after --keep stays an input", () => {
  // `convert lid.stl --keep base.stl` delivered a project without base.stl until 2026-10-03.
  const r = run("convert", join(dir, "lid.stl"), "--keep", join(dir, "base.stl"));
  assert.equal(r.code, 1);
  assert.match(r.out, /no such file: .*lid\.stl/);
  assert.match(run("convert", "x.stl", "--keep=1").out, /--keep is a switch/);
});

test("an unknown flag, a flag with no value and a bad number are refused", () => {
  const plate = run("convert", "x.3mf", "--plate", "2");
  assert.equal(plate.code, 1);
  assert.match(plate.out, /--plate is not a flag here: every plate is converted/);
  assert.match(run("convert", "x.stl", "--name").out, /--name needs a value/);
  assert.match(run("convert", "x.stl", "--name", "--keep").out, /--name needs a value/);
  assert.match(run("convert", "x.stl", "--scale", "big").out, /--scale must be a number greater than 0/);
  assert.match(run("convert", "x.stl", "--sett", "wall_loops=3").out, /--sett is not a flag here/);
});
