/**
 * The app: one page on loopback, driving the same engine the command line drives.
 *
 * Loopback is a rule here, not a flag — the server refuses to bind anything else, and refuses a request whose
 * Host header is not localhost, so a name pointed at this machine cannot reach it either. Every path a request
 * names has to resolve inside ~/3dprint. It never talks to the printer: a finished project is opened in Flash Studio,
 * and Flash Studio slices it and sends it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { DEFAULT_FILAMENT, WORKDIR } from "./machine.js";
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

/** Only paths under the work folder, whatever a request asks for. */
function insideWork(path: string): string | null {
  const full = resolve(path);
  const root = resolve(WORKDIR);
  return full === root || full.startsWith(`${root}/`) ? full : null;
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

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

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
    const body = JSON.parse((await readBody(request)).toString("utf8")) as { path?: string };
    const file = insideWork(body.path ?? "");
    if (!file || !existsSync(file)) return json(response, { error: "no such file under ~/3dprint" }, 400);
    try {
      return json(response, await inspect(file));
    } catch (err) {
      return json(response, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  if (path === "/api/slice" && request.method === "POST") {
    const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, string>;
    const file = insideWork(body["path"] ?? "");
    if (!file || !existsSync(file)) return json(response, { error: "no such file under ~/3dprint" }, 400);

    const overrides: string[] = [];
    if (body["brim"]) overrides.push(`brim_type=${body["brim"]}`);
    if (body["infill"]) overrides.push(`sparse_infill_density=${body["infill"]}`);

    const id = randomUUID();
    const job: Job = { lines: [], done: false };
    jobs.set(id, job);
    void convert({
      inputs: [file],
      process: (body["process"] as "0.12" | "0.20" | "0.24") ?? "0.20",
      ...(body["filament"] ? { filament: body["filament"] } : {}),
      ...(body["name"] ? { name: body["name"] } : {}),
      fromMesh: body["fromMesh"] === "1",
      overrides,
      onLine: (line) => job.lines.push(line),
      onProgress: (progress) => { job.progress = progress; },
    })
      .then((result) => {
        job.result = result;
        for (const [label, chain] of Object.entries(result.chains)) job.lines.push(`${label}: ${chain.join(" → ")}`);
        job.lines.push(result.delivered ? `saved ${result.project3mf}` : result.errorString);
        if (result.advice) job.lines.push(result.advice);
      })
      .catch((err: unknown) => {
        job.error = err instanceof Error ? err.message : String(err);
        job.lines.push(job.error);
      })
      .finally(() => { job.done = true; });
    return json(response, { id });
  }

  if (path === "/api/job" && request.method === "GET") {
    const job = jobs.get(url.searchParams.get("id") ?? "");
    if (!job) return json(response, { error: "no such job" }, 404);
    return json(response, job);
  }

  if (path === "/api/open" && request.method === "POST") {
    const body = JSON.parse((await readBody(request)).toString("utf8")) as { path?: string };
    const file = insideWork(body.path ?? "");
    if (!file || !file.toLowerCase().endsWith(".3mf") || !existsSync(file)) {
      return json(response, { ok: false, error: "no such project under ~/3dprint" }, 400);
    }
    return json(response, openInFlashStudio(file));
  }

  if (path === "/api/upload" && request.method === "POST") {
    const name = decodeURIComponent(request.headers["x-filename"] as string | undefined ?? "dropped.3mf");
    const safe = basename(name).replace(/[^\w.+\-]+/g, "_");
    const destination = join(WORKDIR, "in", safe);
    mkdirSync(join(WORKDIR, "in"), { recursive: true });
    writeFileSync(destination, await readBody(request));
    return json(response, { saved: destination });
  }

  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("not here\n");
}

export async function serve(port = DEFAULT_PORT, open = false): Promise<void> {
  const server = createServer((request, response) => {
    handle(request, response).catch((err: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(err instanceof Error ? err.message : String(err));
    });
  });

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
