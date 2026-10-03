/**
 * The flattening is the part the slicer's own CLI gets wrong. The preset tests read Flash Studio's installed presets
 * and skip on a machine without them; the override tests need nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { LIBRARY, MACHINE_JSON } from "../src/machine.js";
import {
  applyOverrides, carryDesigner, filamentChoices, findPreset, flattenPreset, restorePreset, selectableFor5M, settingsDiff,
} from "../src/presets.js";

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

function scratchFlat(preset: Record<string, unknown>): string {
  const path = join(scratch(), "flat-process.json");
  writeFileSync(path, JSON.stringify(preset));
  return path;
}

test("a choice about the part is applied and reported", () => {
  const path = scratchFlat({ brim_type: "no_brim", wall_loops: "2" });
  assert.deepEqual(applyOverrides(path, ["brim_type=auto_brim"]), [
    { key: "brim_type", was: '"no_brim"', now: "auto_brim" },
  ]);
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["brim_type"], "auto_brim");
});

test("the designer's supports, brim and infill are kept over the preset's; the printer's own are not", () => {
  const path = scratchFlat({
    enable_support: "0", support_type: "normal(auto)", brim_type: "no_brim", sparse_infill_density: ["15%"],
    layer_height: "0.2", enable_prime_tower: "0", elefant_foot_compensation: "0.15", wall_loops: "2",
  });
  const project = {
    enable_support: "1", support_type: "tree(auto)", brim_type: "outer_only", sparse_infill_density: ["5%"],
    layer_height: "0.16", enable_prime_tower: "1", elefant_foot_compensation: "0", wall_loops: "2",
  };
  assert.deepEqual(carryDesigner(path, project), [
    { key: "sparse_infill_density", was: "15%", now: "5%" },
    { key: "enable_support", was: "0", now: "1" },
    { key: "support_type", was: "normal(auto)", now: "tree(auto)" },
    { key: "brim_type", was: "no_brim", now: "outer_only" },
  ]);
  const flat = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(flat["sparse_infill_density"], ["5%"]);
  assert.equal(flat["layer_height"], "0.2");
  assert.equal(flat["enable_prime_tower"], "0");
  assert.equal(flat["elefant_foot_compensation"], "0.15");
  // your --set still has the last word
  applyOverrides(path, ["brim_type=no_brim"]);
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["brim_type"], "no_brim");
  // a value the slicer refuses goes back to the preset's
  restorePreset(path, { support_type: "normal(auto)" }, ["support_type"]);
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["support_type"], "normal(auto)");
});

test("every support setting the designer changed travels; one they left alone stays the 5M's", () => {
  // A designer set a 1 mm gap between the supports and the part, and the preset would put back 0.3. The top gap is
  // Bambu's default there, not the designer's choice, so the 5M's own stands.
  const path = scratchFlat({
    enable_support: "0", support_type: "normal(auto)", support_object_xy_distance: "0.3",
    support_top_z_distance: "0.18", support_line_width: "0.42", support_interface_speed: "80", support_filament: "0",
  });
  const project = {
    enable_support: "1", support_type: "normal(manual)", support_object_xy_distance: "1",
    support_top_z_distance: "0.2", support_line_width: "0.4", support_interface_speed: "50", support_filament: "2",
    different_settings_to_system: [
      "enable_support;support_filament;support_interface_speed;support_line_width;support_object_xy_distance;support_type",
      "", "",
    ],
  };
  assert.deepEqual(carryDesigner(path, project), [
    { key: "enable_support", was: "0", now: "1" },
    { key: "support_type", was: "normal(auto)", now: "normal(manual)" },
    { key: "support_object_xy_distance", was: "0.3", now: "1" },
  ]);
  const flat = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(flat["support_object_xy_distance"], "1");
  assert.equal(flat["support_top_z_distance"], "0.18");
  assert.equal(flat["support_line_width"], "0.42");
  assert.equal(flat["support_interface_speed"], "80");
  assert.equal(flat["support_filament"], "0");
});

test("the machine's own numbers are refused", () => {
  const path = scratchFlat({ nozzle_temperature: ["220"], outer_wall_speed: "200", default_acceleration: "10000" });
  for (const bad of ["nozzle_temperature=260", "outer_wall_speed=400", "default_acceleration=30000"]) {
    assert.throws(() => applyOverrides(path, [bad]), /refuses/);
  }
});

test("an unknown setting is refused", () => {
  assert.throws(() => applyOverrides(scratchFlat({ brim_type: "no_brim" }), ["brim_typo=auto_brim"]), /no such setting/);
});

test("a list-valued setting stays a list", () => {
  const path = scratchFlat({ sparse_infill_density: ["15%"] });
  applyOverrides(path, ["sparse_infill_density=0%"]);
  assert.deepEqual((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)["sparse_infill_density"], ["0%"]);
});

const LIBRARY_PLA = join(LIBRARY, "filament", "Generic PLA @System.json");

test("the project's own model-facing settings the preset replaces are named, on the first slot", () => {
  const replaced = settingsDiff(
    { brim_type: "auto_brim", sparse_infill_density: ["15%", "10%"], wall_loops: "2", nozzle_temperature: ["255"] },
    { brim_type: "no_brim", sparse_infill_density: ["15%"], wall_loops: "3", nozzle_temperature: ["220"] },
  );
  assert.deepEqual(replaced, [
    { key: "wall_loops", was: "2", now: "3" },
    { key: "brim_type", was: "auto_brim", now: "no_brim" },
  ]);
});

test("the PLA Flash Studio picks for the 5M resolves through the library's own bases", { skip: !existsSync(LIBRARY_PLA) }, () => {
  const path = findPreset("filament", "Generic PLA @System");
  assert.equal(path, LIBRARY_PLA);
  const { flat, chain } = flattenPreset(LIBRARY_PLA, "filament");
  assert.deepEqual(chain, ["Generic PLA @System", "fdm_filament_pla", "fdm_filament_common"]);
  // what Flash Studio itself shows for this preset on the 5M
  assert.deepEqual(flat["nozzle_temperature"], ["220"]);
  assert.deepEqual(flat["textured_plate_temp"], ["55"]);
  assert.equal(flat["name"], "Generic PLA @System");
  assert.equal(flat["inherits"], undefined);
  assert.deepEqual(selectableFor5M(LIBRARY_PLA), { ok: true });
});

test("a base preset Flash Studio cannot select is refused", { skip: !existsSync(LIBRARY_PLA) }, () => {
  const base = findPreset("filament", "Flashforge Generic PLA");
  assert.ok(base);
  assert.equal(selectableFor5M(base).ok, false);
  const offered = filamentChoices();
  assert.ok(offered.includes("Generic PLA @System"));
  assert.ok(offered.includes("Flashforge PLA Basic"));
  assert.ok(!offered.includes("Flashforge Generic PLA"));
  assert.ok(!offered.some((n) => n.includes("@G3U") || n.includes("0.25")));
});

test("Flashforge's machine chain still resolves by file name, past its index's wrong entry", { skip: !existsSync(MACHINE_JSON) }, () => {
  assert.deepEqual(flattenPreset(MACHINE_JSON, "machine").chain, [
    "Flashforge Adventurer 5M 0.4 Nozzle", "fdm_adventurer5m_common", "fdm_flashforge_common", "fdm_machine_common",
  ]);
});
