/**
 * A project laid out over several plates is cut into one project per plate; these need no slicer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { keepItems, keepPlate, platesOf } from "../src/plates.js";

const SETTINGS = `<config>
  <object id="2">
    <metadata key="name" value="wing"/>
  </object>
  <object id="6">
    <metadata key="name" value="fuselage"/>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>
    <model_instance>
      <metadata key="object_id" value="2"/>
    </model_instance>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <metadata key="gcode_file" value="Metadata/plate_2.gcode"/>
    <model_instance>
      <metadata key="object_id" value="6"/>
    </model_instance>
  </plate>
  <assemble>
   <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />
   <assemble_item object_id="6" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />
  </assemble>
</config>`;

test("each plate's objects are read in plate order", () => {
  assert.deepEqual(platesOf(SETTINGS), [{ plate: 1, objects: ["2"] }, { plate: 2, objects: ["6"] }]);
});

test("the second plate becomes plate 1 of its own file, with only its object", () => {
  const xml = keepPlate(SETTINGS, 2, new Set(["6"]));
  assert.deepEqual(platesOf(xml), [{ plate: 1, objects: ["6"] }]);
  assert.ok(!xml.includes('<object id="2">'));
  assert.ok(xml.includes('<object id="6">'));
  assert.ok(!xml.includes("gcode_file"));
  assert.ok(!xml.includes('assemble_item object_id="2"'));
});

test("the build keeps only the items of the plate's objects", () => {
  const build = `<build>\n  <item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n  <item objectid="6" printable="1"/>\n </build>`;
  const kept = keepItems(build, new Set(["6"]));
  assert.ok(!kept.includes('objectid="2"'));
  assert.ok(kept.includes('objectid="6"'));
});
