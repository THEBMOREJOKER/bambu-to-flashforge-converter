/**
 * The designer's own G-code at a layer, kept: read by plate, written back into a project, and placed into a slice at
 * the layer Flash Studio writes it at (ToolOrdering::assign_custom_gcodes, 1.7.15). None of these needs the slicer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { customItems, layerHeights, placeInSlice, placeItems, placementsFor, withCustomItems } from "../src/customgcode.js";

const LIST = `<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
<plate>
<plate_info id="1"/>
<layer top_z="3" type="1" extruder="1" color="" extra="" gcode="PAUSE"/>
<layer top_z="5" type="4" extruder="1" color="" extra="M104 S215" gcode="M104 S215"/>
<layer top_z="9" type="2" extruder="2" color="#FF0000" extra="" gcode="tool_change"/>
<mode value="SingleExtruder"/>
</plate>
<plate>
<plate_info id="2"/>
<layer top_z="7" type="4" extruder="1" color="" extra="M106 S128&#10;M117 magnets in" gcode="M106 S128&#10;M117 magnets in"/>
<mode value="SingleExtruder"/>
</plate>
</custom_gcodes_per_layer>
`;

test("the Custom items are read by plate, with their text unescaped, and pauses and tool changes are not", () => {
  const items = customItems(LIST);
  assert.deepEqual(items.map((i) => [i.plate, i.z, i.text]), [[1, 5, "M104 S215"], [2, 7, "M106 S128\nM117 magnets in"]]);
  // A list from PrusaSlicer 2.2 or older has no type; anything but M600, M601 and tool_change is the designer's text.
  const old = customItems(`<plate>\n<plate_info id="1"/>\n<layer top_z="2" extruder="1" color="" gcode="M300 S440 P200"/>\n<layer top_z="4" extruder="1" color="" gcode="M601"/>\n</plate>`);
  assert.equal(old.length, 1);
  assert.deepEqual([old[0]?.z, old[0]?.text], [2, "M300 S440 P200"]);
});

test("kept items go back into their plate in height order, beside its pauses, once", () => {
  const exported = `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n<plate>\n<plate_info id="1"/>\n<layer top_z="3" type="1" extruder="1" color="" extra="" gcode="PAUSE"/>\n<mode value="SingleExtruder"/>\n</plate>\n</custom_gcodes_per_layer>\n`;
  const items = customItems(LIST);
  const one = withCustomItems(exported, 1, items.filter((i) => i.plate === 1));
  assert.deepEqual([...one.matchAll(/top_z="([^"]+)"/g)].map((m) => m[1]), ["3", "5"]);
  assert.match(one, /<layer top_z="5" type="4"[^>]*extra="M104 S215"[^>]*\/>\n<mode value="SingleExtruder"\/>/);
  assert.equal(withCustomItems(one, 1, items.filter((i) => i.plate === 1)), one, "an item already there is not written twice");
  // A plate with no list gets a block; a project with no list file gets the file.
  const two = withCustomItems(one, 2, items.filter((i) => i.plate === 2));
  assert.match(two, /<plate>\n<plate_info id="2"\/>\n<layer top_z="7"[^>]*\/>\n<mode value="SingleExtruder"\/>\n<\/plate>\n<\/custom_gcodes_per_layer>/);
  const fresh = withCustomItems(null, 1, items.filter((i) => i.plate === 1));
  assert.deepEqual(customItems(fresh).map((i) => i.text), ["M104 S215"]);
  // The designer's text is written as it was, a dollar sign included.
  const dollar = customItems(`<plate>\n<plate_info id="1"/>\n<layer top_z="2" type="4" extruder="1" color="" extra="M117 $&amp;5" gcode="M117 $&amp;5"/>\n</plate>`);
  assert.match(withCustomItems(exported, 1, dollar), /extra="M117 \$&amp;5"/);
});

const heights = Array.from({ length: 25 }, (_, i) => Math.round((i + 1) * 2) / 10); // 0.2 … 5.0

test("an item runs at the layer nearest its height, and above the top it runs at the top layer", () => {
  const at = (z: number) => placeItems(heights, [{ z, custom: true, tag: `t${z}` }], [{ plate: 1, z, text: "M117", tag: `t${z}` }])[0];
  assert.equal(at(5)?.layer, 5);
  assert.equal(at(3.05)?.layer, 3);
  assert.equal(at(3.15)?.layer, 3.2);
  assert.equal(at(99)?.layer, 5, "above the print, Flash Studio writes it at the top layer");
  assert.equal(at(0.05)?.layer, null, "under half the first layer it is not written");
  assert.match(at(0.05)?.why ?? "", /under the first layer/);
});

test("a layer takes one event: a second item there, or one sharing it with a pause, is not written, and says so", () => {
  const items = [{ plate: 1, z: 3.0, text: "A", tag: "a" }, { plate: 1, z: 3.04, text: "B", tag: "b" }];
  const placed = placeItems(heights, items.map((i) => ({ z: i.z, custom: true, tag: i.tag })), items);
  assert.deepEqual(placed.map((p) => p.layer), [null, 3]);
  assert.match(placed[0]?.why ?? "", /one per layer/);
  const withPause = placeItems(heights, [{ z: 3.04, custom: false, tag: "pause" }, { z: 3.0, custom: true, tag: "a" }], [items[0]!]);
  assert.equal(withPause[0]?.layer, null);
});

test("the text is written at the start of its layer, after the layer's own marks, line by line", () => {
  const slice = [";LAYER_CHANGE", ";Z:0.2", ";HEIGHT:0.2", "G1 X1 Y1 E1", ";LAYER_CHANGE", ";Z:0.4", ";HEIGHT:0.2", "G1 X2 Y2 E1"].join("\n");
  assert.deepEqual(layerHeights(slice), [0.2, 0.4]);
  const items = customItems(LIST).filter((i) => i.plate === 2).map((i) => ({ ...i, z: 0.4 }));
  const placements = placementsFor(slice, null, 2, items);
  assert.equal(placements[0]?.layer, 0.4);
  const placed = placeInSlice(slice, placements).split("\n");
  assert.deepEqual(placed.slice(5, 10), [";Z:0.4", ";HEIGHT:0.2", ";CUSTOM_GCODE", "M106 S128", "M117 magnets in"]);
  assert.equal(placed.at(-1), "G1 X2 Y2 E1");
});

test("in a slice with the layer change written out, it goes after the fan-speed mark, as Flash Studio writes it", () => {
  // A 5 mm layer as the 1.7.15 slicer writes it, with and then without the erase switch.
  const layer = [";LAYER_CHANGE", ";Z:5", ";HEIGHT:0.2", ";BEFORE_LAYER_CHANGE", ";5", "G1 E-.8 F1800", ";WIPE_START",
    "G1 F9023.957", "G1 X7.462 Y-32.144", "G1 X7.094 Y-32.082", ";WIPE_END", ";AFTER_LAYER_CHANGE", ";5",
    ";_SET_FAN_SPEED_CHANGING_LAYER", "G17", "G3 Z5.4 I-1.103 J-.513 P1  F30000"];
  const item = { plate: 1, z: 5, text: "M104 S215", tag: "t" };
  const placed = placeInSlice([";Z:4.8", ...layer].join("\n"), [{ item, layer: 5 }]).split("\n");
  assert.deepEqual(placed.slice(14, 18), [";_SET_FAN_SPEED_CHANGING_LAYER", ";CUSTOM_GCODE", "M104 S215", "G17"]);
});
