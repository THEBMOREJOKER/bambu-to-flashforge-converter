/**
 * Taking a combined body apart, on a synthetic project: a build item's object becomes one object per piece, the
 * geometry comes through untouched, and the per-object settings follow. What paint holds together stays together.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { itemMeshes } from "../src/split.js";
import { separation } from "../src/separate.js";
import { copyZipWith, writeZip } from "../src/zipwrite.js";
import { Zip } from "../src/zip.js";

const made: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "b2f-test-"));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Two tetrahedra 5 mm apart in one mesh, wrapped the way a Bambu project wraps a volume, placed 10 mm up X. */
function model(paint = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
     <vertex x="5" y="0" z="0"/><vertex x="7" y="0" z="0"/><vertex x="5" y="2" z="0"/><vertex x="5" y="0" z="2"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="2" v3="1"${paint}/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
     <triangle v1="4" v2="6" v3="5"/><triangle v1="4" v2="5" v3="7"/><triangle v1="4" v2="7" v3="6"/><triangle v1="5" v2="6" v3="7"/>
    </triangles>
   </mesh>
  </object>
  <object id="2" type="model">
   <components>
    <component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
   </components>
  </object>
 </resources>
 <build>
  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0" printable="1" />
 </build>
</model>`;
}

const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="组合体.stl"/>
    <metadata key="extruder" value="1"/>
    <metadata face_count="8"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="组合体.stl"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <mesh_stat face_count="8" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <model_instance>
      <metadata key="object_id" value="2"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="69"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 10 0 0" offset="0 0 0" />
  </assemble>
</config>`;

function project(paint = ""): string {
  const path = join(scratch(), "p.3mf");
  writeZip(path, [
    { name: "3D/3dmodel.model", data: Buffer.from(model(paint)) },
    { name: "Metadata/model_settings.config", data: Buffer.from(SETTINGS) },
  ]);
  return path;
}

/** The cleaned copy a conversion would hand the slicer. */
async function separated(source: string): Promise<{ path: string; objects: number; held: string[] }> {
  const zip = new Zip(source);
  try {
    const plan = await separation(zip);
    if (!plan) return { path: source, objects: 0, held: [] };
    const path = join(scratch(), "cleaned.3mf");
    copyZipWith(zip, path, plan.members(zip, null));
    return { path, objects: plan.objects.length, held: plan.held.map((h) => h.why) };
  } finally {
    zip.close();
  }
}

test("a combined body becomes one object per piece, where each piece sat", async () => {
  const { path, objects } = await separated(project());
  assert.equal(objects, 1);
  const zip = new Zip(path);
  try {
    const items = await itemMeshes(zip);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.mesh.tris.length / 3), [4, 4]);
    // The build item placed the object 10 mm up X; each piece carries that placement in its own vertices.
    const xs = items.map((i) => Math.min(...Array.from({ length: i.mesh.verts.length / 3 }, (_, v) => i.mesh.verts[3 * v]!)));
    assert.deepEqual(xs, [10, 15]);
    const settings = zip.readText("Metadata/model_settings.config");
    assert.equal((settings.match(/<object id="/g) ?? []).length, 2);
    assert.equal((settings.match(/<model_instance>/g) ?? []).length, 2);
    assert.equal((settings.match(/<assemble_item /g) ?? []).length, 2);
    assert.match(settings, /组合体\.stl \(part 1 of 2\)/);
    assert.match(settings, /组合体\.stl \(part 2 of 2\)/);
    assert.equal(settings.includes('key="identify_id" value="69"'), false);
  } finally {
    zip.close();
  }
});

test("paint on a face holds an object together, and says so", async () => {
  const { objects, held } = await separated(project(' paint_color="4"'));
  assert.equal(objects, 0);
  assert.deepEqual(held, ["its faces carry painted regions, and paint does not survive the mesh being rewritten"]);
});

test("a project whose objects are each one piece is left alone", async () => {
  const path = join(scratch(), "one.3mf");
  writeZip(path, [{ name: "3D/3dmodel.model", data: Buffer.from(model().replace(/<vertex x="5"/g, '<vertex x="0.5"').replace(/<vertex x="7"/, '<vertex x="1.5"')) }]);
  const zip = new Zip(path);
  try {
    assert.equal(await separation(zip), null);
  } finally {
    zip.close();
  }
});
