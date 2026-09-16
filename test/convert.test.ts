/**
 * The retry after a refused project reads its own result, not the refusal the first run left behind.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../src/convert.js";

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
