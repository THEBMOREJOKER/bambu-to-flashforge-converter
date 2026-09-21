/**
 * The retry after a refused project reads its own result, not the refusal the first run left behind.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { convert, runCli } from "../src/convert.js";
import { APPIMAGE, MACHINE_JSON } from "../src/machine.js";
import { withZip } from "../src/zip.js";
import { writeZip } from "../src/zipwrite.js";

test("a run that crashes does not inherit the previous run's result.json", async () => {
  const out = mkdtempSync(join(tmpdir(), "b2f-test-"));
  try {
    writeFileSync(join(out, "result.json"), JSON.stringify({ error_string: "Invalid parameter value(s) included in the 3mf file." }));
    const run = await runCli(["sh", "-c", "kill -SEGV $$"], out);
    assert.equal(run.signal, "SIGSEGV");
    assert.deepEqual(run.result, {});
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a run that writes result.json is read back", async () => {
  const out = mkdtempSync(join(tmpdir(), "b2f-test-"));
  try {
    const run = await runCli(["sh", "-c", `echo '{"return_code": 0}' > "${out}/result.json"`], out);
    assert.equal(run.exit, 0);
    assert.deepEqual(run.result, { return_code: 0 });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// Flash Studio's command line crashes on a plate that has a name. Nothing else in this project needs changing, so
// the name alone has to be enough for a cleaned copy to be what the slicer is handed. Needs Flash Studio installed.
const NAMED = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="3">
    <metadata key="name" value="Assembly"/>
    <metadata key="extruder" value="1"/>
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
  </plate>
</config>`;

test("a project with a named plate is handed to the slicer without the name, its parts still apart",
  { skip: !existsSync(APPIMAGE) || !existsSync(MACHINE_JSON) }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "b2f-test-"));
    let work = "";
    try {
      const project = join(dir, "named.3mf");
      writeZip(project, [{ name: "Metadata/model_settings.config", data: Buffer.from(NAMED) }]);
      const r = await convert({ inputs: [project], dryRun: true, keep: true, out: dir });
      work = r.work;
      assert.deepEqual(r.plateNames, ["plate 1: B. by layer 36 x 65 mm"]);
      const handed = r.command[r.command.length - 1] ?? "";
      assert.match(handed, /named-cleaned-input\.3mf$/);
      withZip(handed, (zip) => {
        const xml = zip.readText("Metadata/model_settings.config");
        assert.equal(xml, NAMED.replace("B. by layer 36 x 65 mm", ""));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (work) rmSync(work, { recursive: true, force: true });
    }
  });

// From Bambu Studio 2.04 a P1S project names two kinds of nozzle, and Flash Studio's command line dies on their
// lists for the 5M's one. Needs Flash Studio installed. They come out of the copy it reads; the rest of the settings stay.
const TWO_KINDS = {
  filament_settings_id: ["Bambu PLA Basic @BBL P1S 0.4 nozzle"],
  printer_extruder_variant: ["Direct Drive Standard", "Direct Drive High Flow"],
  extruder_variant_list: ["Direct Drive Standard,Direct Drive High Flow"],
  filament_extruder_variant: ["Direct Drive Standard", "Direct Drive High Flow"],
  filament_self_index: ["1", "1"],
  seam_position: "back",
};

test("a project naming two kinds of nozzle is handed to the slicer without their lists",
  { skip: !existsSync(APPIMAGE) || !existsSync(MACHINE_JSON) }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "b2f-test-"));
    let work = "";
    try {
      const project = join(dir, "kinds.3mf");
      writeZip(project, [{ name: "Metadata/project_settings.config", data: Buffer.from(JSON.stringify(TWO_KINDS)) }]);
      const r = await convert({ inputs: [project], dryRun: true, keep: true, out: dir });
      work = r.work;
      assert.deepEqual(r.variants, {
        kinds: ["Direct Drive Standard", "Direct Drive High Flow"],
        keys: ["extruder_variant_list", "filament_extruder_variant", "filament_self_index", "printer_extruder_variant"],
      });
      const handed = r.command[r.command.length - 1] ?? "";
      assert.match(handed, /kinds-cleaned-input\.3mf$/);
      withZip(handed, (zip) => {
        assert.deepEqual(zip.readJson("Metadata/project_settings.config"), {
          filament_settings_id: ["Bambu PLA Basic @BBL P1S 0.4 nozzle"], seam_position: "back",
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (work) rmSync(work, { recursive: true, force: true });
    }
  });
