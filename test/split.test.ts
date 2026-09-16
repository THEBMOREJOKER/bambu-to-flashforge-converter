/**
 * Shells and STLs out of a project's mesh, on a synthetic project: two parts and a stray triangle in one mesh.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { split } from "../src/split.js";
import { stlInfo } from "../src/stl.js";
import { writeZip } from "../src/zipwrite.js";

// Every scratch folder a test makes goes when the file is done.
const made: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "b2f-test-"));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});


// Two tetrahedra in one mesh, plus a single stray triangle, placed 10 mm up X by the build item.
const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
     <vertex x="5" y="0" z="0"/><vertex x="7" y="0" z="0"/><vertex x="5" y="2" z="0"/><vertex x="5" y="0" z="2"/>
     <vertex x="9" y="9" z="0"/><vertex x="9.5" y="9" z="0"/><vertex x="9" y="9.5" z="0"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
     <triangle v1="4" v2="6" v3="5"/><triangle v1="4" v2="5" v3="7"/><triangle v1="4" v2="7" v3="6"/><triangle v1="5" v2="6" v3="7"/>
     <triangle v1="8" v2="9" v3="10"/>
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>
 </build>
</model>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="1">
    <metadata key="name" value="two parts.stl"/>
    <metadata key="extruder" value="1"/>
  </object>
</config>`;

function project(): string {
  const path = join(scratch(), "p.3mf");
  writeZip(path, [
    { name: "3D/3dmodel.model", data: Buffer.from(MODEL) },
    { name: "Metadata/model_settings.config", data: Buffer.from(SETTINGS) },
  ]);
  return path;
}

test("a report counts the shells and writes nothing", async () => {
  const out = join(scratch(), "split");
  const r = await split(project(), { out });
  assert.equal(r.objects.length, 1);
  const o = r.objects[0]!;
  assert.equal(o.name, "two parts.stl");
  assert.equal(o.triangles, 9);
  assert.equal(o.shellCount, 3);
  assert.deepEqual(o.shells.map((s) => s.triangles), [4, 4, 1]);
  assert.deepEqual(o.shells[1]!.size, [2, 2, 2]);
  assert.equal(existsSync(out), false);
});

test("--split ID writes one STL per shell, placed as the project places it, and skips fragments", async () => {
  const out = join(scratch(), "split");
  const r = await split(project(), { ids: ["1"], out, minTris: 2 });
  assert.deepEqual(r.written.map((p) => p.slice(out.length + 1)), ["two_parts-1.stl", "two_parts-2.stl"]);
  assert.deepEqual(r.objects[0]!.skipped, [1]);
  const first = stlInfo(r.written[0]!);
  assert.equal(first.triangles, 4);
  assert.deepEqual(first.min, [10, 0, 0]);
  assert.deepEqual(first.max, [11, 1, 1]);
  const bytes = readFileSync(r.written[1]!);
  assert.equal(bytes.length, 84 + 50 * 4);
  assert.equal(bytes.subarray(0, 10).toString("ascii"), "split_mesh");
  assert.equal(bytes.readUInt32LE(80), 4);
});

test("an id that matches nothing writes every object whole", async () => {
  const out = join(scratch(), "split");
  const r = await split(project(), { ids: ["none"], out });
  assert.equal(r.written.length, 1);
  const whole = stlInfo(r.written[0]!);
  assert.equal(whole.triangles, 9);
  assert.deepEqual(whole.max, [19.5, 9.5, 2]);
});

