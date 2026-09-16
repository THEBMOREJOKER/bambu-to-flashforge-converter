/**
 * A top-down picture of the plate, drawn from the G-code itself rather than from the model: what the first layer
 * actually puts on the bed, where the purge line runs, and how close any of it comes to the edge. It is the one
 * view that answers "will this stick" — a tall part on a small footprint is the thing that lets go.
 */
import { readFileSync } from "node:fs";

import { BED_MAX, BED_MIN } from "./machine.js";

export interface PlateMap {
  bed: { min: number; max: number };
  firstLayerZ: number | null;
  /** Polylines of first-layer extrusion, in bed coordinates. */
  paths: Array<Array<[number, number]>>;
  /** What the start block lays down before the object — the purge line. */
  purge: Array<Array<[number, number]>>;
  footprint: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** How far the nearest first-layer extrusion sits from the bed edge. */
  clearance: number | null;
  segments: number;
  truncated: boolean;
}

const NUMBER = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)";
const PARAM = new RegExp(`([A-Za-z])\\s*(${NUMBER})`, "g");

/**
 * @param maxSegments a plate's first layer can run to tens of thousands of moves; the page needs a picture, not
 * every last one, so the walk stops once it has enough to draw honestly.
 */
export function plateMap(path: string, maxSegments = 12000): PlateMap {
  const paths: Array<Array<[number, number]>> = [];
  const purge: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> | null = null;
  let layers = 0;
  let firstLayerZ: number | null = null;
  let segments = 0;
  let truncated = false;
  let x = 0, y = 0, z = 0;
  let absolute = true;
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.startsWith(";")) {
      if (raw.startsWith(";LAYER_CHANGE")) {
        layers++;
        current = null;
        if (layers > 1) break; // the first layer is the whole story for adhesion
      }
      continue;
    }
    const code = (raw.split(";", 1)[0] ?? "").trim();
    if (!code) continue;
    const word = (code.split(/\s+/, 1)[0] ?? "").toUpperCase();
    if (word === "G90") { absolute = true; continue; }
    if (word === "G91") { absolute = false; continue; }
    if (word !== "G0" && word !== "G1" && word !== "G2" && word !== "G3") continue;

    const p = new Map<string, number>();
    PARAM.lastIndex = 0;
    for (let m = PARAM.exec(code.slice(word.length)); m; m = PARAM.exec(code.slice(word.length))) {
      p.set((m[1] ?? "").toUpperCase(), Number.parseFloat(m[2] ?? "0"));
    }
    const nx = p.has("X") ? (absolute ? p.get("X") ?? x : x + (p.get("X") ?? 0)) : x;
    const ny = p.has("Y") ? (absolute ? p.get("Y") ?? y : y + (p.get("Y") ?? 0)) : y;
    const nz = p.has("Z") ? (absolute ? p.get("Z") ?? z : z + (p.get("Z") ?? 0)) : z;
    const extruding = (p.get("E") ?? 0) > 0 && (p.has("X") || p.has("Y"));

    if (extruding) {
      if (segments >= maxSegments) {
        truncated = true;
      } else {
        const into = layers === 0 ? purge : paths;
        if (!current) {
          current = [];
          current.push([x, y]);
          into.push(current);
        }
        current.push([nx, ny]);
        segments++;
        if (layers === 1) {
          firstLayerZ ??= nz;
          box ??= { minX: nx, minY: ny, maxX: nx, maxY: ny };
          box.minX = Math.min(box.minX, x, nx);
          box.minY = Math.min(box.minY, y, ny);
          box.maxX = Math.max(box.maxX, x, nx);
          box.maxY = Math.max(box.maxY, y, ny);
        }
      }
    } else {
      current = null;
    }
    x = nx; y = ny; z = nz;
  }

  const clearance = box
    ? Math.min(box.minX - BED_MIN, box.minY - BED_MIN, BED_MAX - box.maxX, BED_MAX - box.maxY)
    : null;

  return {
    bed: { min: BED_MIN, max: BED_MAX },
    firstLayerZ,
    paths,
    purge,
    footprint: box,
    clearance,
    segments,
    truncated,
  };
}
