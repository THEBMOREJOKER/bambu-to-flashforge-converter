/**
 * The app on loopback: a page on another site cannot drive it, a body has a limit,
 * and a choice the page does not offer is refused. No request here reaches the slicer.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { appServer } from "../src/gui.js";
import { WORKDIR } from "../src/machine.js";

const server = appServer();
let base = "";
before(async () => {
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-B2F": "1", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("a request without the app's own header is refused, and so is another site's Origin", async () => {
  const bare = await fetch(`${base}/api/open`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(bare.status, 403);
  const foreign = await post("/api/open", { path: "x.3mf" }, { Origin: "https://example.com" });
  assert.equal(foreign.status, 403);
  const upload = await fetch(`${base}/api/upload`, { method: "POST", headers: { "x-filename": "dropped.3mf" }, body: "x" });
  assert.equal(upload.status, 403);
  // The page's own request, from its own origin, is taken.
  const own = await post("/api/open", { path: "no-such.3mf" }, { Origin: base });
  assert.equal(own.status, 400);
});

test("a JSON body has a limit, and has to be JSON", async () => {
  assert.equal((await post("/api/inspect", JSON.stringify({ path: "x".repeat(2 << 20) }))).status, 413);
  assert.equal((await post("/api/inspect", "{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("/api/inspect", "not json")).status, 400);
});

test("a slice is refused for a choice the page does not offer", async () => {
  // Under the work folder, where the app looks, and never among the models: a hidden folder of its own, gone after,
  // and the work folder with it when this run is what made it.
  const made = mkdirSync(WORKDIR, { recursive: true });
  const scratch = mkdtempSync(join(WORKDIR, ".b2f-test-"));
  try {
    const model = join(scratch, "m.stl");
    writeFileSync(model, "solid m\nendsolid m\n");
    const refused = async (extra: Record<string, string>, why: RegExp) => {
      const r = await post("/api/slice", { path: model, ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.match(((await r.json()) as { error: string }).error, why);
    };
    await refused({ filament: "/home/someone/planted.json" }, /not a filament preset the page offers/);
    await refused({ process: "0.08" }, /layer height must be one of/);
    await refused({ brim: "outer_only\npost_process=x" }, /not a brim the page offers/);
    await refused({ infill: "15%\nx" }, /infill is a percentage/);
    await refused({ name: "../../Desktop/note" }, /plain file name/);
    // A link under ~/3dprint that leads out of it is not followed.
    symlinkSync("/etc", join(scratch, "out"));
    const r = await post("/api/inspect", { path: join(scratch, "out", "hostname") });
    assert.equal(r.status, 400);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (made) rmSync(made, { recursive: true, force: true });
  }
});
