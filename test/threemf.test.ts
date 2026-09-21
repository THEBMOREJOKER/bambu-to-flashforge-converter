/**
 * What a 3MF says about itself, and the changes that make a Bambu project a one-slot Flash Studio project — on
 * synthetic projects written in each test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { withZip } from "../src/zip.js";
import {
  blankPlateNames, cleanNote, collapseFilaments, extruderVariants, firstSlot, notes, objectSettings, oneSlot,
  outOfRangeKeys, type ProjectSettings, projectSettings, sliceWarnings, unslicedChanges,
} from "../src/threemf.js";
import { copyZipWith, writeZip } from "../src/zipwrite.js";

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


test("cleanNote resolves entities escaped more than twice", () => {
  assert.equal(cleanNote("a&amp;lt;br&amp;gt;b"), "a · b");
  assert.equal(cleanNote("a&amp;amp;lt;br&amp;amp;gt;b&amp;amp;nbsp;"), "a · b");
  assert.equal(cleanNote("<p>one</p><p>two</p>"), "one · two");
});

// A Bambu project's shape: an object on AMS slot 10 with a part on slot 3, a part that follows its object, an object
// already on slot 1, a tool change at a layer and a pause at another.
const MODEL_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="2">
    <metadata key="name" value="fidget.stl"/>
    <metadata key="extruder" value="10"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="cap"/>
      <metadata key="extruder" value="3"/>
    </part>
    <part id="2" subtype="normal_part">
      <metadata key="extruder" value="0"/>
    </part>
  </object>
  <object id="5">
    <metadata key="name" value="base.stl"/>
    <metadata key="extruder" value="1"/>
  </object>
</config>`;

const LAYERS = `<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
<plate>
<plate_info id="1"/>
<layer top_z="10" type="1" extruder="1" color="" extra="" gcode="M601"/>
<layer top_z="35.041000366210938" type="2" extruder="2" color="#BB3D43" extra="" gcode="tool_change"/>
<mode value="MultiAsSingle"/>
</plate>
</custom_gcodes_per_layer>`;

function projectWith(members: Record<string, string>): string {
  const path = join(scratch(), "p.3mf");
  writeZip(path, Object.entries(members).map(([name, text]) => ({ name, data: Buffer.from(text) })));
  return path;
}

test("a project on slot 10 with a tool change collapses onto slot 1", () => {
  withZip(projectWith({
    "Metadata/model_settings.config": MODEL_SETTINGS,
    "Metadata/custom_gcode_per_layer.xml": LAYERS,
  }), (zip) => {
    const c = collapseFilaments(zip);
    assert.deepEqual(c.moved, ["fidget.stl: slot 10, 3 → slot 1"]);
    assert.deepEqual(c.dropped, ["tool change to slot 2 (#BB3D43) at 35.04 mm"]);
    assert.deepEqual(c.kept, ["pause at 10.00 mm"]);

    const settings = c.members["Metadata/model_settings.config"]?.toString("utf8") ?? "";
    assert.equal(settings.match(/key="extruder" value="1"/g)?.length, 3);
    assert.equal(settings.match(/key="extruder" value="0"/g)?.length, 1);
    assert.doesNotMatch(settings, /value="10"|value="3"/);
    assert.equal(settings.replace(/key="extruder" value="\d+"/g, "").length,
      MODEL_SETTINGS.replace(/key="extruder" value="\d+"/g, "").length);

    const layers = c.members["Metadata/custom_gcode_per_layer.xml"]?.toString("utf8") ?? "";
    assert.doesNotMatch(layers, /tool_change/);
    assert.match(layers, /type="1"/);
    assert.match(layers, /<mode value="MultiAsSingle"\/>/);
  });
});

// A designer who names a plate: Flash Studio's command line crashes on one.
const PLATES = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="3">
    <metadata key="name" value="Assembly"/>
    <metadata key="extruder" value="3"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="shell"/>
    </part>
    <part id="2" subtype="normal_part">
      <metadata key="name" value="spiral"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="B. by layer 36 x 65 mm"/>
    <metadata key="locked" value="false"/>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <metadata key="plater_name" value=""/>
  </plate>
  <plate>
    <metadata key="plater_id" value="3"/>
    <metadata key="plater_name" value="lid &amp; base"/>
  </plate>
</config>`;

test("a named plate loses its name, and the name is said", () => {
  const r = blankPlateNames(PLATES);
  assert.deepEqual(r.names, ["plate 1: B. by layer 36 x 65 mm", "plate 3: lid & base"]);
  // Nothing but the two names changed.
  assert.equal(r.xml, PLATES.replace("B. by layer 36 x 65 mm", "").replace("lid &amp; base", ""));
});

test("a project with no named plate is left as it is", () => {
  const plain = blankPlateNames(PLATES).xml;
  assert.deepEqual(blankPlateNames(plain), { xml: plain, names: [] });
  assert.deepEqual(blankPlateNames(MODEL_SETTINGS), { xml: MODEL_SETTINGS, names: [] });
});

// Bambu Studio 2.04 on a P1S: two kinds of nozzle, and filament lists one entry per slot per kind.
const TWO_KINDS: ProjectSettings = {
  filament_settings_id: ["Bambu PLA Basic @BBL P1S 0.4 nozzle", "Bambu PLA Basic @BBL P1S 0.4 nozzle"],
  printer_extruder_variant: ["Direct Drive Standard", "Direct Drive High Flow"],
  extruder_variant_list: ["Direct Drive Standard,Direct Drive High Flow"],
  filament_extruder_variant: ["Direct Drive Standard", "Direct Drive High Flow", "Direct Drive Standard", "Direct Drive High Flow"],
  filament_self_index: ["1", "1", "2", "2"],
  print_extruder_id: ["1", "1"],
  extruder_type: ["Direct Drive"],
};

test("a project that names two kinds of nozzle has their lists taken out", () => {
  assert.deepEqual(extruderVariants(TWO_KINDS, new Set()), {
    kinds: ["Direct Drive Standard", "Direct Drive High Flow"],
    keys: ["extruder_variant_list", "filament_extruder_variant", "filament_self_index", "print_extruder_id", "printer_extruder_variant"],
  });
  // A key a flattened preset carries stays: the slicer replaces it anyway.
  assert.deepEqual(extruderVariants(TWO_KINDS, new Set(["print_extruder_id"])).keys,
    ["extruder_variant_list", "filament_extruder_variant", "filament_self_index", "printer_extruder_variant"]);
});

test("a project that names one kind of nozzle, or none, is left as it is", () => {
  const oneKind: ProjectSettings = {
    ...TWO_KINDS,
    printer_extruder_variant: ["Direct Drive Standard"],
    extruder_variant_list: ["Direct Drive Standard"],
    filament_extruder_variant: ["Direct Drive Standard", "Direct Drive Standard"],
    filament_self_index: ["1", "2"],
    print_extruder_id: ["1"],
  };
  assert.deepEqual(extruderVariants(oneKind, new Set()), { kinds: ["Direct Drive Standard"], keys: [] });
  assert.deepEqual(extruderVariants({ extruder_type: ["DirectDrive"] }, new Set()), { kinds: [], keys: [] });
});

test("an object's parts are counted, so a mesh taken out whole can say what it makes one piece", () => {
  withZip(projectWith({ "Metadata/model_settings.config": PLATES }), (zip) => {
    assert.deepEqual(objectSettings(zip).map((o) => `${o.name}: ${o.parts}`), ["Assembly: 2"]);
  });
  withZip(projectWith({ "Metadata/model_settings.config": MODEL_SETTINGS }), (zip) => {
    assert.deepEqual(objectSettings(zip).map((o) => o.parts), [2, 0]);
  });
});

test("a project already on one slot is left alone", () => {
  withZip(projectWith({
    "Metadata/model_settings.config": MODEL_SETTINGS.replace(/value="(10|3)"/g, 'value="1"'),
  }), (zip) => {
    const c = collapseFilaments(zip);
    assert.deepEqual(c, { members: {}, moved: [], dropped: [], kept: [] });
  });
});

// What Flash Studio's CLI exports after a slice, cut down: the plate's G-code, its checksum, the relationship that
// points at it, and the slice results — none of which a project handed to Flash Studio should carry.
const SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="weight" value="90.68"/>
    <warning msg="bed_temperature_too_high_than_filament" level="3" error_code ="1000C001"  />
  </plate>
</config>`;

const GCODE_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>
</Relationships>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
 <Relationship Target="/Auxiliaries/.thumbnails/thumbnail_3mf.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>
</Relationships>`;

test("a sliced export loses its G-code and slice results, and keeps the project", () => {
  const sliced = projectWith({
    "3D/3dmodel.model": "<model/>",
    "Metadata/model_settings.config": MODEL_SETTINGS,
    "Metadata/plate_1.gcode": "G1 X0\n",
    "Metadata/plate_1.gcode.md5": "abc",
    "Metadata/_rels/model_settings.config.rels": GCODE_RELS,
    "Metadata/slice_info.config": SLICE_INFO,
    "Auxiliaries/.thumbnails/thumbnail_3mf.png": "png",
    "_rels/.rels": ROOT_RELS,
  });
  const out = join(scratch(), "out.3mf");
  withZip(sliced, (zip) => {
    assert.deepEqual(sliceWarnings(zip), ["bed_temperature_too_high_than_filament (1000C001)"]);
    copyZipWith(zip, out, unslicedChanges(zip));
  });
  withZip(out, (zip) => {
    assert.deepEqual(zip.names().sort(), [
      "3D/3dmodel.model", "Auxiliaries/.thumbnails/thumbnail_3mf.png", "Metadata/model_settings.config",
      "Metadata/slice_info.config", "_rels/.rels",
    ]);
    const rels = zip.readText("_rels/.rels");
    assert.match(rels, /3D\/3dmodel\.model/);
    assert.match(rels, /thumbnail_3mf\.png/);
    assert.doesNotMatch(rels, /plate_1\.png/);
    const info = zip.readText("Metadata/slice_info.config");
    assert.match(info, /X-BBL-Client-Type/);
    assert.doesNotMatch(info, /<plate>|warning/);
    assert.equal(zip.readText("Metadata/model_settings.config"), MODEL_SETTINGS);
    assert.deepEqual(sliceWarnings(zip), []);
  });
});

test("an unsliced project needs no changes", () => {
  withZip(projectWith({ "3D/3dmodel.model": "<model/>", "Metadata/model_settings.config": MODEL_SETTINGS }), (zip) => {
    assert.deepEqual(unslicedChanges(zip), {});
  });
});

test("eleven slots become one, cut to the slot everything prints from", () => {
  const n = 11;
  const slots = (make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i));
  const project = {
    filament_settings_id: slots((i) => `Bambu ${i}`),
    filament_colour: slots((i) => `#${i}`),
    nozzle_temperature: slots((i) => String(200 + i)),
    hole_coef_1: slots(() => "0"),
    flush_volumes_matrix: Array.from({ length: n * n }, (_, i) => String(i)),
    flush_volumes_vector: Array.from({ length: 2 * n }, (_, i) => String(i)),
    different_settings_to_system: Array.from({ length: n + 2 }, (_, i) => `d${i}`),
    printable_area: ["0x0", "256x0", "256x256", "0x256"],
    wall_loops: "2",
    machine_like: slots(() => "m"),
  };
  const xml = '<plate><metadata key="filament_maps" value="1 1 1 1 1 1 1 1 1 1 1"/></plate>';
  const r = oneSlot(project, xml, new Set(["nozzle_temperature"]), new Set(["machine_like"]));
  assert.equal(r.from, 11);
  assert.deepEqual(r.settings["filament_settings_id"], ["Bambu 0"]);
  assert.deepEqual(r.settings["filament_colour"], ["#0"]);
  assert.deepEqual(r.settings["nozzle_temperature"], ["200"]);
  assert.deepEqual(r.settings["hole_coef_1"], ["0"]);
  assert.deepEqual(r.settings["flush_volumes_matrix"], ["0"]);
  assert.deepEqual(r.settings["flush_volumes_vector"], ["0", "1"]);
  assert.deepEqual(r.settings["different_settings_to_system"], ["d0", "d1", "d12"]);
  assert.deepEqual(r.settings["printable_area"], project.printable_area);
  assert.equal(r.settings["wall_loops"], "2");
  // a preset's own key is the slicer's to replace, and is left as it came
  assert.deepEqual(r.settings["machine_like"], project.machine_like);
  assert.equal(r.modelXml, '<plate><metadata key="filament_maps" value="1"/></plate>');
});

test("with two slots only filament keys are cut", () => {
  const r = oneSlot(
    { filament_settings_id: ["a", "b"], filament_type: ["PLA", "PETG"], machine_max_speed_x: ["500", "200"] },
    null, new Set(), new Set(),
  );
  assert.deepEqual(r.settings["filament_type"], ["PLA"]);
  assert.deepEqual(r.settings["machine_max_speed_x"], ["500", "200"]);
});

test("a single-slot project is not touched", () => {
  const project = { filament_settings_id: ["a"], nozzle_temperature: ["220"] };
  assert.equal(oneSlot(project, null, new Set(), new Set()).settings, project);
});

test("a layer list left empty is dropped with its file", () => {
  withZip(projectWith({
    "Metadata/custom_gcode_per_layer.xml": LAYERS.replace(/<layer top_z="10"[^>]*\/>\n/, ""),
  }), (zip) => {
    const c = collapseFilaments(zip);
    assert.deepEqual(c.dropped, ["tool change to slot 2 (#BB3D43) at 35.04 mm"]);
    assert.equal(c.members["Metadata/custom_gcode_per_layer.xml"], null);
  });
});

const MODEL_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <metadata name="Title">Fidget</metadata>
 <metadata name="Description">&amp;lt;p&amp;gt;Print at 0.2 mm&amp;lt;/p&amp;gt;&amp;lt;p&amp;gt;base 15% infill, figure 0%&amp;lt;/p&amp;gt;</metadata>
 <resources/>
</model>`;

test("a designer's notes come out of the model's head as plain text", () => {
  withZip(projectWith({ "3D/3dmodel.model": MODEL_HEAD }), (zip) => {
    assert.deepEqual(notes(zip), { Title: "Fidget", Description: "Print at 0.2 mm · base 15% infill, figure 0%" });
  });
});

test("a model without notes is not an error", () => {
  withZip(projectWith({ "3D/3dmodel.model": "<model><resources/></model>" }), (zip) => {
    assert.deepEqual(notes(zip), {});
  });
});

test("project and per-object settings read as the slicer wrote them", () => {
  const settings = { printer_model: "Bambu Lab X1 Carbon", filament_settings_id: ["Bambu PLA Basic", "Generic PLA"] };
  withZip(projectWith({
    "Metadata/project_settings.config": JSON.stringify(settings),
    "Metadata/model_settings.config": MODEL_SETTINGS.replace(
      '<metadata key="extruder" value="1"/>\n  </object>',
      '<metadata key="extruder" value="1"/>\n    <metadata key="sparse_infill_density" value="0%"/>\n  </object>',
    ),
  }), (zip) => {
    const ps = projectSettings(zip);
    assert.ok(ps);
    assert.equal(firstSlot(ps["printer_model"]), "Bambu Lab X1 Carbon");
    assert.equal(firstSlot(ps["filament_settings_id"]), "Bambu PLA Basic");
    const objects = objectSettings(zip);
    assert.deepEqual(objects.map((o) => [o.objectId, o.name, o.extruder]), [["2", "fidget.stl", "10"], ["5", "base.stl", "1"]]);
    assert.deepEqual(objects[1]?.settings, { sparse_infill_density: "0%" });
  });
});

test("the values a newer Bambu Studio writes and Orca 2.3.2 refuses are named", () => {
  assert.deepEqual(outOfRangeKeys({
    wall_filament: "0", sparse_infill_filament: ["0"], support_filament: "1",
    raft_first_layer_expansion: "-1", tree_support_wall_count: ["-1"], wall_loops: "-1",
  }), ["raft_first_layer_expansion", "sparse_infill_filament", "tree_support_wall_count", "wall_filament"]);
});
