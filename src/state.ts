/**
 * What is true about the conversion path right now: whether Flash Studio and the presets it ships are where this
 * tool looks, and what is in the work folder. Read-only. Ends with the one thing to do next.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { APPIMAGE, DEFAULT_FILAMENT, MACHINE_JSON, OUTDIR, PROCESS, PROFILES, SSL_CERT, WORKDIR } from "./machine.js";
import { findPreset } from "./presets.js";

export interface WorkFile { name: string; path: string; bytes: number; modified: number; }

export interface State {
  when: string;
  slicer: { appImage: string; found: boolean; certificates: boolean; profiles: boolean; missing: string[] };
  work: { root: string; in: WorkFile[]; out: WorkFile[] };
  blocks: string[];
  next: string;
}

function listFiles(dir: string, limit = 40): WorkFile[] {
  if (!existsSync(dir)) return [];
  const out: WorkFile[] = [];
  const walk = (base: string, depth: number) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const path = join(base, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) walk(path, depth + 1);
      } else {
        const s = statSync(path);
        out.push({ name: path.slice(dir.length + 1), path, bytes: s.size, modified: s.mtimeMs });
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.modified - a.modified).slice(0, limit);
}

export function state(): State {
  const blocks: string[] = [];
  const found = existsSync(APPIMAGE);
  const missing = [MACHINE_JSON, ...Object.values(PROCESS).map((p) => join(PROFILES, "process", p))]
    .filter((p) => !existsSync(p));
  if (!findPreset("filament", DEFAULT_FILAMENT)) missing.push(`filament preset ${DEFAULT_FILAMENT}`);

  if (!found) blocks.push("install Flash Studio for Linux (the AppImage) under ~/Applications, or set FLASH_STUDIO to its path");
  else if (missing.length) blocks.push("launch Flash Studio once from its menu entry so it unpacks its presets, and add the Adventurer 5M");
  if (!existsSync(SSL_CERT)) blocks.push(`no certificate bundle at ${SSL_CERT}: set SSL_CERT_FILE`);

  const inDir = join(WORKDIR, "in");
  return {
    when: new Date().toISOString(),
    slicer: { appImage: APPIMAGE, found, certificates: existsSync(SSL_CERT), profiles: missing.length === 0, missing },
    work: { root: WORKDIR, in: listFiles(inDir), out: listFiles(OUTDIR) },
    blocks,
    next: blocks[0] ?? `put a model in ${inDir} and inspect it`,
  };
}
