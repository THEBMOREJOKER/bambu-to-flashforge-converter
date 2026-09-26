/**
 * Handing a finished project to Flash Studio, the way its own menu entry opens a file: the AppImage with the path,
 * and SSL_CERT_FILE set so its first-launch certificate prompt never appears. Unless Flash Studio is set to a single
 * instance, each file opens in a window of its own. Slice and print from there.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { APPIMAGE, DATADIR, SSL_CERT } from "./machine.js";

export interface OpenResult { ok: boolean; pid?: number; error?: string; }

export function openInFlashStudio(path: string): OpenResult {
  if (!existsSync(APPIMAGE)) return { ok: false, error: `Flash Studio is not at ${APPIMAGE}` };
  if (!existsSync(path)) return { ok: false, error: `no such file: ${path}` };
  if (!process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"]) {
    return { ok: false, error: "no display to open a window on — start the app from the desktop icon" };
  }
  try {
    const child = spawn(APPIMAGE, ["--datadir", DATADIR, path], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SSL_CERT_FILE: SSL_CERT },
    });
    child.unref();
    return { ok: true, ...(child.pid ? { pid: child.pid } : {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
