/**
 * The same size, thicker. Two things have to hold: a point's world Z comes out multiplied and its X and Y come out
 * untouched, whatever rotation the project put on the object; and an object that stood on the bed still stands on it.
 * The build below is a converted project's own — one item turned 118°, one turned 45°, one square — because a rotation
 * is exactly what a naive scale gets wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, parseTransform, scaleWorldZ } from "../src/geometry.js";
import { thickenAssembly, thickenItems } from "../src/thicken.js";

const BUILD = `<build p:UUID="2c7c17d8">
  <item objectid="2" transform="-0.461913602 0.886924926 0 -0.886924926 -0.461913602 0 0 0 1 -1.599219 14.500608 9.31541252" printable="1" auto_drop="1"/>
  <item objectid="4" transform="0.707106781 0.707106781 0 -0.707106781 0.707106781 0 0 0 1 42.258695 -33.359995 13" printable="1" auto_drop="1"/>
  <item objectid="6" transform="1 0 0 0 1 0 0 0 1 -0.293734 -36.615537 14.5" printable="1" auto_drop="1"/>
 </build>`;

const near = (got: number, want: number, tol = 1e-6) =>
  assert.ok(Math.abs(got - want) < tol, `expected ${want}, got ${got}`);

test("a turned object's Z scales and its footprint does not", () => {
  const m = parseTransform("-0.461913602 0.886924926 0 -0.886924926 -0.461913602 0 0 0 1 -1.599219 14.500608 9.31541252");
  const doubled = scaleWorldZ(m, 2);
  for (const [x, y, z] of [[0, 0, 0], [12, -30, 9.315], [-7.5, 4, -9.315]] as const) {
    const was = apply(m, x, y, z);
    const now = apply(doubled, x, y, z);
    near(now[0], was[0]);
    near(now[1], was[1]);
    near(now[2], was[2] * 2);
  }
});

test("every item of the build comes out twice as thick, seated on the bed", () => {
  // Each mesh is centred on its own origin, so half its height is the item's Z and its floor is 0.
  const items = [...thickenItems(BUILD, 2, [0, 0, 0]).matchAll(/transform="([^"]*)"/g)].map((m) => parseTransform(m[1] ?? ""));
  assert.equal(items.length, 3);
  const heights = [18.63082504, 26, 29];
  items.forEach((m, i) => {
    const half = heights[i]! / 2;
    // A point at the mesh's own floor still lands on the bed, and its top stands at twice the height.
    near(apply(m, 0, 0, -half)[2], 0, 1e-4);
    near(apply(m, 0, 0, half)[2], heights[i]! * 2, 1e-4);
  });
});

test("the footprint of every item is untouched to the micron", () => {
  const before = [...BUILD.matchAll(/transform="([^"]*)"/g)].map((m) => parseTransform(m[1] ?? ""));
  const after = [...thickenItems(BUILD, 2, [0, 0, 0]).matchAll(/transform="([^"]*)"/g)].map((m) => parseTransform(m[1] ?? ""));
  before.forEach((was, i) => {
    const now = after[i]!;
    for (const [x, y, z] of [[30, -12, 4], [-45, 60, -3]] as const) {
      near(apply(now, x, y, z)[0], apply(was, x, y, z)[0]);
      near(apply(now, x, y, z)[1], apply(was, x, y, z)[1]);
    }
  });
});

test("an object the project left floating is put back at the height it floated at", () => {
  const floating = '<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 20"/></build>';
  // A 10 mm cube centred on its origin, sitting with its floor at 15 mm.
  const m = parseTransform([...thickenItems(floating, 3, [15]).matchAll(/transform="([^"]*)"/g)][0]![1] ?? "");
  near(apply(m, 0, 0, -5)[2], 15);
  near(apply(m, 0, 0, 5)[2], 15 + 30);
});

test("an item with no transform, and a build with no items, are left alone", () => {
  assert.equal(thickenItems('<build><item objectid="1" printable="1"/></build>', 2, []),
    '<build><item objectid="1" printable="1"/></build>');
  assert.equal(thickenItems("<build></build>", 2, []), "<build></build>");
});

test("the assembly view's copy of where an object sits is kept in step", () => {
  const xml = '<assemble>\n   <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 9.3154125213623047" offset="0 0 0" />\n  </assemble>';
  const out = thickenAssembly(xml, 2);
  assert.match(out, /transform="1 0 0 0 1 0 0 0 2 0 0 18\.63082504/);
  assert.match(out, /offset="0 0 0"/);
});
