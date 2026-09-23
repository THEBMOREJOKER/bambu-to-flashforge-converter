/**
 * The bed fit, which decides whether a part is reported as too big before anything slices it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { fitsBed, stlInfo } from "../src/stl.js";



test("the bed test allows a flat rotation and refuses what is too tall", () => {
  assert.equal(fitsBed([210, 210, 219]), true);
  assert.equal(fitsBed([230, 10, 10]), false);
  assert.equal(fitsBed([10, 10, 221]), false);
});

test("an ASCII STL with an overlong solid line is refused, not handed to the slicer", () => {
  const dir = mkdtempSync(join(tmpdir(), "stl-name-"));
  const path = join(dir, "long.stl");
  writeFileSync(path, `solid ${"A".repeat(400)}\nfacet normal 0 0 1\n  outer loop\n    vertex 0 0 0\n`
    + "    vertex 1 0 0\n    vertex 0 1 0\n  endloop\nendfacet\nendsolid\n");
  assert.throws(() => stlInfo(path), /solid" line is 40[0-9] bytes/);
  rmSync(dir, { recursive: true, force: true });
});

test("an ordinary ASCII STL still reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "stl-ok-"));
  const path = join(dir, "cube.stl");
  writeFileSync(path, "solid cube\nfacet normal 0 0 1\n  outer loop\n    vertex 0 0 0\n"
    + "    vertex 1 0 0\n    vertex 0 1 0\n  endloop\nendfacet\nendsolid\n");
  const info = stlInfo(path);
  assert.equal(info.ascii, true);
  assert.equal(info.triangles, 1);
  rmSync(dir, { recursive: true, force: true });
});
