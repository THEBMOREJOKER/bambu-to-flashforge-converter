/**
 * The bed fit, which decides whether a part is reported as too big before anything slices it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fitsBed } from "../src/stl.js";



test("the bed test allows a flat rotation and refuses what is too tall", () => {
  assert.equal(fitsBed([210, 210, 219]), true);
  assert.equal(fitsBed([230, 10, 10]), false);
  assert.equal(fitsBed([10, 10, 221]), false);
});
