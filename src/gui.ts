/**
 * The app: one page on loopback, driving the same engine the command line drives.
 *
 * Loopback is a rule here, not a flag — the server refuses to bind anything else, and refuses a request whose
 * Host header is not localhost, so a name pointed at this machine cannot reach it either. A page on another site
 * cannot drive it from your browser either: every request
 * that does something carries a header only this app's own page sends, and an Origin, when the browser sends one,
 * has to be this page's. Every path a request names has to resolve inside ~/3dprint, links followed. It never talks
 * to the printer: a finished project is opened in Flash Studio, and Flash Studio slices it and sends it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { DEFAULT_FILAMENT, PROCESS, WORKDIR } from "./machine.js";
import { filamentChoices } from "./presets.js";
import { convert, type ConvertResult, type Progress } from "./convert.js";
import { openInFlashStudio } from "./flashstudio.js";
import { inspect } from "./inspect.js";
import { page } from "./page.js";
import { state } from "./state.js";

const HOST = "127.0.0.1";
export const DEFAULT_PORT = 8770;

interface Job { lines: string[]; done: boolean; progress?: Progress; result?: ConvertResult; error?: string; }
const jobs = new Map<string, Job>();
/** A finished job stays this long for its page to read, then goes. */
const JOB_KEPT_MS = 10 * 60 * 1000;

/** The header this app's own page sends with every request that does something. */
const OWN_PAGE = "x-b2f";
/** A JSON request is a path and a few choices; a model can be large. */
const JSON_LIMIT = 1 << 20;
const UPLOAD_LIMIT = 512 * 1024 * 1024;
/** The brims the page offers: as the file, none, where needed, outside only. */
const BRIMS = new Set(["", "no_brim", "auto_brim", "outer_only"]);


class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Only paths under the work folder, whatever a request asks for, read where they really lead: a link under ~/3dprint
 * that points out of it is refused (until 2026-10-03 it was followed). A relative path is read from ~/3dprint, and a
 * path that does not exist is not one to act on.
 */
function insideWork(path: string): string | null {
  let full: string;
  let root: string;
  try {
    root = realpathSync(resolve(WORKDIR));
    full = realpathSync(resolve(WORKDIR, path));
  } catch {
    return null;
  }
  return full === root || full.startsWith(`${root}/`) ? full : null;
}

/**
 * A request that does something comes from this app's own page: its header, and its Origin, when the browser sends
 * one, the very host and port the page was served from (the Host header, already held to localhost).
 */
function fromOwnPage(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${request.headers.host ?? ""}`) return false;
  return request.headers[OWN_PAGE] === "1";
}

function localHost(request: IncomingMessage): boolean {
  const host = (request.headers.host ?? "").split(":")[0] ?? "";
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function json(response: ServerResponse, body: unknown, code = 200): void {
  const text = JSON.stringify(body);
  response.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(text);
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  if (Number(request.headers["content-length"] ?? 0) > limit) throw new Refused(413, `over ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Refused(413, `over ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) throw new Refused(415, "JSON only");
  try {
    const body = JSON.parse((await readBody(request, JSON_LIMIT)).toString("utf8")) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Refused) throw err;
  }
  throw new Refused(400, "not a JSON object");
}

/** A model dropped on the page goes to ~/3dprint/in/ through a .part file, never whole in memory, and has a cap. */
async function saveUpload(request: IncomingMessage, destination: string): Promise<void> {
  if (Number(request.headers["content-length"] ?? 0) > UPLOAD_LIMIT) throw new Refused(413, "a model over 512 MB");
  const part = `${destination}.part`;
  const fd = openSync(part, "w");
  let size = 0;
  try {
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > UPLOAD_LIMIT) throw new Refused(413, "a model over 512 MB");
      writeSync(fd, chunk as Buffer);
    }
  } catch (err) {
    closeSync(fd);
    rmSync(part, { force: true });
    throw err;
  }
  closeSync(fd);
  renameSync(part, destination);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The filament presets Flash Studio offers for the 5M 0.4, the default first; read once, they do not change. */
let offered: string[] | null = null;
function filaments(): string[] {
  offered ??= [DEFAULT_FILAMENT, ...filamentChoices().filter((n) => n !== DEFAULT_FILAMENT).sort((a, b) => a.localeCompare(b))];
  return offered;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!localHost(request)) {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("this page answers on localhost only\n");
    return;
  }
  const url = new URL(request.url ?? "/", `http://${HOST}`);
  const path = url.pathname;
  if (request.method !== "GET" && !fromOwnPage(request)) {
    response.writeHead(403, { "Content-Type": "text/plain" });
    response.end("this app takes requests from its own page only\n");
    return;
  }

  if (path === "/" && request.method === "GET") {
    const html = page(filaments());
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(html);
    return;
  }

  if (path === "/api/state" && request.method === "GET") {
    json(response, state());
    return;
  }

  if (path === "/api/inspect" && request.method === "POST") {
    const body = await readJson(request);
    const file = insideWork(text(body["path"]));
    if (!file) return json(response, { error: "no such file under ~/3dprint" }, 400);
    try {
      return json(response, await inspect(file));
    } catch (err) {
      return json(response, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  if (path === "/api/slice" && request.method === "POST") {
    const body = await readJson(request);
    const file = insideWork(text(body["path"]));
    if (!file) return json(response, { error: "no such file under ~/3dprint" }, 400);
    // Every choice is one the page offers, and nothing else: the filament one of the presets it lists, the layer one of
    // the three processes, the brim one of its four, the infill a percentage, the name a plain file name.
    const processKey = text(body["process"]) || "0.20";
    const filament = text(body["filament"]);
    const brim = text(body["brim"]);
    const infill = text(body["infill"]);
    const name = text(body["name"]);
    if (!(processKey in PROCESS)) return json(response, { error: `layer height must be one of ${Object.keys(PROCESS).join(", ")}` }, 400);
    if (filament && !filaments().includes(filament)) return json(response, { error: "not a filament preset the page offers" }, 400);
    if (!BRIMS.has(brim)) return json(response, { error: "not a brim the page offers" }, 400);
    if (infill && !(/^\d{1,3}%$/.test(infill) && Number.parseInt(infill, 10) <= 100)) {
      return json(response, { error: "infill is a percentage, 0% to 100%" }, 400);
    }
    if (name && (/[/\\\0]/.test(name) || name === "." || name === "..")) {
      return json(response, { error: "the name is a plain file name: no folder in it" }, 400);
    }
    // One slice at a time: the slicer is one machine's worth of work, and two jobs used to share a clean-up.
    if ([...jobs.values()].some((j) => !j.done)) return json(response, { error: "a slice is running — one at a time" }, 409);

    const overrides: string[] = [];
    if (brim) overrides.push(`brim_type=${brim}`);
    if (infill) overrides.push(`sparse_infill_density=${infill}`);

    const id = randomUUID();
    const job: Job = { lines: [], done: false };
    jobs.set(id, job);
    void convert({
      inputs: [file],
      process: processKey as keyof typeof PROCESS,
      ...(filament ? { filament } : {}),
      ...(name ? { name } : {}),
      fromMesh: body["fromMesh"] === "1",
      overrides,
      onLine: (line) => job.lines.push(line),
      onProgress: (progress) => { job.progress = progress; },
    })
      .then((result) => {
        job.result = result;
        for (const [label, chain] of Object.entries(result.chains)) job.lines.push(`${label}: ${chain.join(" → ")}`);
        job.lines.push(result.delivered ? `saved ${(result.parts ?? [result.project3mf]).join(", ")}` : result.errorString);
        if (result.advice) job.lines.push(result.advice);
      })
      .catch((err: unknown) => {
        job.error = err instanceof Error ? err.message : String(err);
        job.lines.push(job.error);
      })
      .finally(() => {
        job.done = true;
        setTimeout(() => jobs.delete(id), JOB_KEPT_MS).unref();
      });
    return json(response, { id });
  }

  if (path === "/api/job" && request.method === "GET") {
    const job = jobs.get(url.searchParams.get("id") ?? "");
    if (!job) return json(response, { error: "no such job" }, 404);
    return json(response, job);
  }

  if (path === "/api/open" && request.method === "POST") {
    const body = await readJson(request);
    const file = insideWork(text(body["path"]));
    if (!file || !file.toLowerCase().endsWith(".3mf")) {
      return json(response, { ok: false, error: "no such project under ~/3dprint" }, 400);
    }
    return json(response, openInFlashStudio(file));
  }

  if (path === "/api/upload" && request.method === "POST") {
    const name = decodeURIComponent(request.headers["x-filename"] as string | undefined ?? "dropped.3mf");
    const safe = basename(name).replace(/[^\w.+\-]+/g, "_");
    const destination = join(WORKDIR, "in", safe);
    mkdirSync(join(WORKDIR, "in"), { recursive: true });
    await saveUpload(request, destination);
    return json(response, { saved: destination });
  }

  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("not here\n");
}

/** The app's server, not yet listening. */
export function appServer(): Server {
  return createServer((request, response) => {
    handle(request, response).catch((err: unknown) => {
      if (!response.headersSent) response.writeHead(err instanceof Refused ? err.status : 500, { "Content-Type": "text/plain" });
      response.end(err instanceof Error ? err.message : String(err));
      // A body refused part-way is not read to its end.
      if (err instanceof Refused) request.destroy();
    });
  });
}

export async function serve(port = DEFAULT_PORT, open = false): Promise<void> {
  const server = appServer();

  // A busy port is a thing to say, not a stack trace to read.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`b2f is already answering on ${HOST}:${port} — open http://${HOST}:${port}/ in a browser,`);
      console.error(`or stop that one with:  pkill -f "[c]li.js gui"   (or start a second on --port 8771)`);
      process.exit(1);
    }
    console.error(`could not listen on ${HOST}:${port}: ${err.message}`);
    process.exit(1);
  });
  process.on("SIGINT", () => {
    console.log("\nstopped");
    process.exit(0);
  });

  await new Promise<void>((ready) => server.listen(port, HOST, ready));
  const address = `http://${HOST}:${port}/`;
  console.log(`Bambu to Flashforge Converter on ${address}  (loopback only — nothing on your network can reach it)`);
  console.log("ctrl-c to stop");
  if (open) spawn("xdg-open", [address], { detached: true, stdio: "ignore" }).unref();
}
