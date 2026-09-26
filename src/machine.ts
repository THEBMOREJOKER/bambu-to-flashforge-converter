/**
 * The Adventurer 5M, as the machine and its vendor describe it — not as anyone remembers it. Every number here
 * is either off Flashforge's spec sheet or out of its own preset; the temperatures a file may command come from
 * the preset the slicer was given, never from this file.
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PRINTER_MODEL = "Flashforge Adventurer 5M";
export const NOZZLE = "0.4";

/** printable_area is -110..110 on both axes, and 220 mm of height. */
export const BED_XY = 220;
export const BED_Z = 220;
export const BED_MIN = -110;
export const BED_MAX = 110;
/** The check allows half a millimetre past the edge before it calls a move off the bed. */
export const BED_TOLERANCE = 0.5;

/** Hardware ratings: a file may not ask for more, whatever preset it came from. */
export const HW = {
  nozzleMaxC: 280,
  bedMaxC: 110,
  maxSpeedMmS: 600,
  maxAccel: 20000,
  /** Informational: Klipper clamps a Z move to its own max_z_velocity. */
  maxZSpeedMmS: 20,
} as const;

/** The 5M's stock plate, and the one Flash Studio selects for it. */
export const BED_TYPE = "Textured PEI Plate";

/** Each plate has its own temperature in a Flashforge filament preset. */
export const BED_TEMP_KEY: Record<string, string> = {
  "Cool Plate": "cool_plate_temp",
  "Engineering Plate": "eng_plate_temp",
  "High Temp Plate": "hot_plate_temp",
  "Textured PEI Plate": "textured_plate_temp",
  "Supertack Plate": "supertack_plate_temp",
};

export type Span = readonly [low: number, high: number];

/** Wider than any preset: a miss means the wrong preset, not a tuning choice. */
export const TEMP_RANGE: Record<string, { nozzle: Span; bed: Span }> = {
  PLA: { nozzle: [180, 235], bed: [0, 70] },
  PETG: { nozzle: [215, 265], bed: [50, 90] },
  ABS: { nozzle: [225, 280], bed: [80, 110] },
  ASA: { nozzle: [225, 280], bed: [80, 110] },
  TPU: { nozzle: [200, 250], bed: [0, 60] },
};

/** Bambu-only G-code the 5M's Klipper does not know. Any of these means the file was sliced for a Bambu. */
export const BAMBU_MARKERS: RegExp[] = [
  /^M1002\b/, /^M971\b/, /^M991\b/, /^M975\b/, /^M620\b/, /^M621\b/, /^G29\.2\b/,
  /^M400\s+U1\b/, /^M960\b/, /^M973\b/, /^M1004\b/, /^M981\b/,
];

export const HOME = homedir();

/**
 * Flash Studio for Linux is an AppImage, and where it lives is up to whoever downloaded it. FLASH_STUDIO names it;
 * otherwise the newest `Flash*Studio*.AppImage` under ~/Applications (two levels deep) is used.
 */
function findAppImage(): string {
  const named = process.env["FLASH_STUDIO"];
  if (named) return named;
  const root = join(HOME, "Applications");
  const found: Array<{ path: string; mtime: number }> = [];
  const look = (dir: string, depth: number) => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 2) look(path, depth + 1);
      else if (entry.isFile() && /^flash.?studio.*\.appimage$/i.test(entry.name)) {
        found.push({ path, mtime: statSync(path).mtimeMs });
      }
    }
  };
  look(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0]?.path ?? join(root, "Flash-Studio.AppImage");
}

export const APPIMAGE = findAppImage();
/**
 * Flash Studio's settings folder, which it unpacks its system presets into on first launch: one folder per vendor,
 * each with an index (`<Vendor>.json`) naming every file. FLASH_STUDIO_CONFIG points somewhere else — and whatever
 * it points at is what the slicer is told to use (`--datadir`), so presets are read from the same folder the run
 * writes to, and a second build of Flash Studio never disturbs the settings of the one you slice with by hand.
 */
export const DATADIR = process.env["FLASH_STUDIO_CONFIG"] ?? join(HOME, ".config/Orca-Flashforge");
export const SYSTEM = join(DATADIR, "system");
export const PROFILES = join(SYSTEM, "Flashforge");
/** Flash Studio's own filament library — the "@System" presets its filament list offers for any printer. */
export const LIBRARY = join(SYSTEM, "OrcaFilamentLibrary");
/**
 * The AppImage asks for a certificate bundle on first launch unless SSL_CERT_FILE names one. This is the
 * Debian/Ubuntu path; set SSL_CERT_FILE yourself on other systems.
 */
export const SSL_CERT = process.env["SSL_CERT_FILE"] ?? "/etc/ssl/certs/ca-certificates.crt";
/** The work folder: models arrive in `in/`, and finished projects land in `out/`. B2F_HOME moves it. */
export const WORKDIR = process.env["B2F_HOME"] ?? join(HOME, "3dprint");
export const OUTDIR = join(WORKDIR, "out");

export const MACHINE_JSON = join(PROFILES, "machine", "Flashforge Adventurer 5M 0.4 Nozzle.json");
export const PROCESS: Record<string, string> = {
  "0.12": "0.12mm Fine @Flashforge AD5M 0.4 Nozzle.json",
  "0.20": "0.20mm Standard @Flashforge AD5M 0.4 Nozzle.json",
  "0.24": "0.24mm Draft @Flashforge AD5M 0.4 Nozzle.json",
};
/**
 * A downloaded project's material does not travel with it: the conversion uses this unless --filament names
 * another. It is the PLA Flash Studio itself offers for the 5M (220 °C, 55 °C on the textured plate).
 * "Flashforge Generic PLA" looks like the obvious choice and is not: it is a base preset Flash Studio does not
 * let anyone select, and a project that names it opens as an unknown, self-defined preset.
 */
export const DEFAULT_FILAMENT = "Generic PLA @System";
