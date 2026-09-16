/**
 * The page. One column on a warm near-black: one border weight, mono for
 * every figure, and no colour except where something needs looking at. No framework, no build step, no fonts to
 * fetch — it has to come up on a machine with no network.
 *
 * The client script below deliberately avoids template literals so this file can hold it as one.
 */

import { DEFAULT_FILAMENT } from "./machine.js";

const STYLE = String.raw`
  :root {
    --ink0:#0e0d0c; --ink1:#131211; --ink2:#1b1917; --ink3:#232120;
    --line:#2a2725; --line2:#3b3733;
    --text:#ECE8E1; --mute:#8B857D; --dim:#5f5a54;
    --ok:#7FA66A; --warn:#D7A35A; --bad:#C4553F;
    --sans:"Ubuntu","Noto Sans",system-ui,sans-serif;
    --mono:"Ubuntu Mono",ui-monospace,"DejaVu Sans Mono",monospace;
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:36px;
  }
  * { box-sizing:border-box; }
  html, body { margin:0; min-height:100%; background:var(--ink0); color:var(--text);
    font:14px/1.55 var(--sans); -webkit-font-smoothing:antialiased; }
  .wrap { width:min(1100px,100%); margin:0 auto; padding:0 var(--s5); }
  .eyebrow, label, th, button, .tag { font:400 10px/1.3 var(--mono); letter-spacing:.16em;
    text-transform:uppercase; color:var(--mute); }
  .top { background:#0b0a09; border-bottom:1px solid var(--line); }
  .top .wrap { display:flex; align-items:center; gap:var(--s5); min-height:64px; flex-wrap:wrap; }
  .mark { margin:0; font:500 20px/1 var(--mono); letter-spacing:.32em; text-transform:uppercase; }
  .pill { margin-left:auto; display:flex; gap:var(--s2); align-items:center; font:400 11px/1 var(--mono); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--dim); }
  .dot.on { background:var(--ok); } .dot.off { background:var(--bad); } .dot.warn { background:var(--warn); }
  main { padding:var(--s5) 0 var(--s6); display:grid; grid-template-columns:300px 1fr; gap:var(--s5); }
  @media (max-width:900px) { main { grid-template-columns:1fr; } }
  .card { background:var(--ink1); border:1px solid var(--line); border-radius:5px; padding:var(--s4); }
  .card + .card { margin-top:var(--s4); }
  .card h2 { margin:0 0 var(--s3); font:400 11px/1.3 var(--mono); letter-spacing:.18em;
    text-transform:uppercase; color:var(--mute); }
  .files { list-style:none; margin:0; padding:0; max-height:46vh; overflow:auto; }
  .files li { border-top:1px solid var(--line); }
  .files li:first-child { border-top:0; }
  .files button { display:block; width:100%; text-align:left; background:transparent; border:0;
    padding:8px 6px; cursor:pointer; color:var(--text); font:400 12px/1.4 var(--mono);
    letter-spacing:0; text-transform:none; overflow-wrap:anywhere; }
  .files button:hover { background:var(--ink3); }
  .files button.on { background:var(--ink3); box-shadow:inset 2px 0 0 var(--text); }
  .files .meta { color:var(--dim); font-size:10.5px; }
  .drop { margin-top:var(--s3); border:1px dashed var(--line2); border-radius:4px; padding:var(--s4);
    text-align:center; color:var(--mute); font:400 11px/1.4 var(--mono); }
  .drop.over { border-color:var(--text); color:var(--text); }
  dl.facts { display:grid; grid-template-columns:auto 1fr; gap:2px var(--s4); margin:0; }
  dl.facts dt { font:400 10px/1.6 var(--mono); letter-spacing:.14em; text-transform:uppercase; color:var(--mute); }
  dl.facts dd { margin:0; font:400 13px/1.6 var(--mono); }
  .note { border-left:2px solid var(--line2); padding:var(--s2) 0 var(--s2) var(--s3); margin:var(--s2) 0;
    color:var(--text); font-size:13px; }
  .note b { display:block; font:400 10px/1.6 var(--mono); letter-spacing:.14em; text-transform:uppercase;
    color:var(--warn); }
  .line { display:flex; gap:var(--s2); align-items:baseline; font:400 12.5px/1.7 var(--mono); }
  .line .s { width:1em; flex:none; }
  .ok .s { color:var(--ok); } .bad .s { color:var(--bad); } .warn .s { color:var(--warn); }
  .bad { color:#E7B4A8; } .warn { color:#E2CBA4; }
  form { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:var(--s3); }
  label { display:block; margin-bottom:4px; }
  select, input[type=text], input[type=number] { width:100%; background:var(--ink0); color:var(--text);
    border:1px solid var(--line2); border-radius:3px; padding:7px 8px; font:400 12.5px/1.3 var(--mono); }
  .row { display:flex; gap:var(--s3); align-items:center; flex-wrap:wrap; margin-top:var(--s4); }
  button.go { background:var(--ink3); color:var(--text); border:1px solid var(--line2); border-radius:3px;
    padding:9px 16px; cursor:pointer; letter-spacing:.14em; }
  button.go:hover:not(:disabled) { background:var(--ink2); border-color:var(--text); }
  button.go:disabled { opacity:.4; cursor:not-allowed; }
  button.go.primary { background:#2b2a27; }
  pre.log { margin:var(--s3) 0 0; max-height:260px; overflow:auto; background:var(--ink0);
    border:1px solid var(--line); border-radius:3px; padding:var(--s3);
    font:400 11.5px/1.5 var(--mono); color:var(--mute); white-space:pre-wrap; }
  svg.plate { width:100%; height:auto; background:var(--ink0); border:1px solid var(--line); border-radius:3px; }
  .hint { color:var(--mute); font-size:12px; margin:var(--s2) 0 0; }
  .hidden { display:none; }
`;

const SCRIPT = String.raw`
const $ = (sel) => document.querySelector(sel);
const state = { file: null, result: null, plate: null };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
async function api(path, body) {
  const options = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {};
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
function mb(bytes) { return (bytes / 1e6).toFixed(1) + " MB"; }
function when(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

async function loadState() {
  const s = await api("/api/state");
  const ready = s.slicer.found && s.slicer.profiles;
  $("#slicerdot").className = "dot " + (ready ? "on" : s.slicer.found ? "warn" : "off");
  $("#slicertext").textContent = ready
    ? "Flash Studio ready · Adventurer 5M 0.4 presets found"
    : s.slicer.found ? "Flash Studio found · presets missing" : "Flash Studio not found";
  $("#next").textContent = s.next;
  $("#next").className = s.blocks.length ? "hint warn" : "hint";
  const list = $("#files");
  list.textContent = "";
  for (const f of s.work.in) {
    const li = el("li");
    const button = el("button");
    button.appendChild(el("span", null, f.name));
    button.appendChild(el("div", "meta", mb(f.bytes) + " · " + when(f.modified)));
    button.onclick = () => choose(f.path, button);
    li.appendChild(button);
    list.appendChild(li);
  }
}

async function choose(path, button) {
  for (const b of document.querySelectorAll("#files button")) b.classList.remove("on");
  if (button) button.classList.add("on");
  state.file = path;
  state.result = null;
  $("#slice").disabled = true;
  $("#result").classList.add("hidden");
  $("#inspection").innerHTML = "<p class='hint'>reading…</p>";
  try {
    const i = await api("/api/inspect", { path: path });
    renderInspection(i);
    $("#slice").disabled = i.verdict === "REFUSE";
  } catch (err) {
    $("#inspection").innerHTML = "";
    $("#inspection").appendChild(el("p", "line bad", String(err.message || err)));
  }
}

function renderInspection(i) {
  const box = $("#inspection");
  box.textContent = "";
  const facts = el("dl", "facts");
  const add = (key, value) => { facts.appendChild(el("dt", null, key)); facts.appendChild(el("dd", null, value)); };
  add("file", i.file + "  (" + i.megabytes.toFixed(1) + " MB)");
  add("verdict", i.verdict + (i.because ? " — " + i.because : ""));
  if (i.mesh) add("mesh", i.mesh.triangles.toLocaleString() + " triangles, " + i.mesh.size.map((n) => n.toFixed(1)).join(" × ") + " mm");
  if (i.project) {
    add("made for", i.project.printerModel + " · " + i.project.printSettingsId);
    add("as set", "layer " + i.project.layerHeight + " mm · infill " + i.project.infill + " · brim " + i.project.brim +
      " · supports " + (i.project.supports ? "on" : "off"));
    add("filaments", i.project.filaments.length + " slot(s): " + [...new Set(i.project.filamentTypes)].join(", "));
  }
  if (i.objects && i.objects.length) {
    add("objects", i.objects.map((o) => o.size.map((n) => n.toFixed(1)).join(" × ") + " mm").join("   ·   "));
    add("fits the bed", i.fits ? "yes, 220 × 220 × 220" : "NO — scaling or splitting is your call");
  }
  box.appendChild(facts);
  const keys = Object.keys(i.notes || {});
  if (keys.length) {
    const note = el("div", "note");
    note.appendChild(el("b", null, "the designer's notes — nothing downstream carries them"));
    for (const key of keys) note.appendChild(el("div", null, key + ": " + i.notes[key]));
    box.appendChild(note);
  }
  for (const w of i.warnings || []) {
    const line = el("div", "line warn");
    line.appendChild(el("span", "s", "!"));
    line.appendChild(el("span", null, w));
    box.appendChild(line);
  }
}

async function slice(fromMesh) {
  if (!state.file) return;
  $("#slice").disabled = true;
  $("#log").textContent = "";
  $("#log").classList.remove("hidden");
  $("#result").classList.add("hidden");
  const options = {
    path: state.file,
    process: $("#process").value,
    filament: $("#filament").value,
    brim: $("#brim").value,
    infill: $("#infill").value.trim(),
    name: $("#name").value.trim(),
    fromMesh: fromMesh === true ? "1" : "",
  };
  let job;
  try {
    job = await api("/api/slice", options);
  } catch (err) {
    $("#log").textContent = String(err.message || err);
    $("#slice").disabled = false;
    return;
  }
  let seen = 0;
  const poll = setInterval(async () => {
    const update = await api("/api/job?id=" + encodeURIComponent(job.id));
    if (update.lines.length > seen) {
      $("#log").textContent += update.lines.slice(seen).join("\n") + "\n";
      $("#log").scrollTop = $("#log").scrollHeight;
      seen = update.lines.length;
    }
    if (!update.done) return;
    clearInterval(poll);
    $("#slice").disabled = false;
    state.result = update.result;
    renderResult(update.result);
  }, 400);
}

function renderResult(r) {
  const box = $("#result");
  box.textContent = "";
  box.classList.remove("hidden");
  if (r.overrides && r.overrides.length) {
    const h = el("h2", null, "your choices, on top of the preset");
    box.appendChild(h);
    for (const o of r.overrides) box.appendChild(el("div", "line", o.key + ": " + o.was + " → " + o.now));
  }
  if (r.replaced && r.replaced.length) {
    box.appendChild(el("h2", null, "the project's settings the preset replaced"));
    for (const o of r.replaced) box.appendChild(el("div", "line", o.key + ": " + o.was + " → " + o.now));
  }
  if (r.collapsed && (r.collapsed.moved.length || r.collapsed.dropped.length)) {
    box.appendChild(el("h2", null, "one extruder — changed in the copy the slicer read"));
    for (const m of r.collapsed.moved) box.appendChild(el("div", "line", m));
    for (const d of r.collapsed.dropped) {
      box.appendChild(el("div", "line warn", d + " — taken out; a pause there is yours to ask for"));
    }
  }
  if (!r.checks || !r.checks.length) {
    const line = el("div", "line bad");
    line.appendChild(el("span", "s", "✗"));
    line.appendChild(el("span", null, r.advice || r.errorString));
    box.appendChild(line);
    if (r.meshRetry) {
      const retry = el("button", "go", "retry from the mesh alone");
      retry.onclick = function () { slice(true); };
      box.appendChild(retry);
      box.appendChild(el("div", "line", "per-object settings, modifiers, painted supports and layer changes in the project are not carried; the log names what was lost"));
    }
    return;
  }
  for (const check of r.checks) {
    box.appendChild(el("h2", null, "check — " + check.file));
    for (const line of check.lines) {
      const row = el("div", "line " + line.state);
      row.appendChild(el("span", "s", line.state === "ok" ? "✓" : line.state === "bad" ? "✗" : "!"));
      row.appendChild(el("span", null, line.text));
      box.appendChild(row);
    }
  }
  for (const w of r.slicerWarnings || []) {
    const row = el("div", "line warn");
    row.appendChild(el("span", "s", "!"));
    row.appendChild(el("span", null, "Flash Studio warns: " + w));
    box.appendChild(row);
  }
  if (r.maps && r.maps[0]) {
    const plateBox = el("div");
    box.appendChild(plateBox);
    drawPlate(r.maps[0], plateBox);
  }
  if (!r.delivered) {
    const line = el("div", "line bad");
    line.appendChild(el("span", "s", "✗"));
    line.appendChild(el("span", null, r.advice || "nothing was saved"));
    box.appendChild(line);
    return;
  }
  const row = el("div", "row");
  const open = el("button", "go primary", "open in Flash Studio");
  open.onclick = function () { openProject(r.project3mf, open); };
  row.appendChild(open);
  row.appendChild(el("span", "hint", "slice and print from there"));
  box.appendChild(row);
  box.appendChild(el("p", "hint", "saved: " + r.project3mf));
}

function drawPlate(map, box) {
  const span = map.bed.max - map.bed.min;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", map.bed.min + " " + map.bed.min + " " + span + " " + span);
  svg.setAttribute("class", "plate");
  const path = (points, stroke, width) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
    node.setAttribute("d", "M" + points.map((p) => p[0].toFixed(2) + "," + (-p[1]).toFixed(2)).join("L"));
    node.setAttribute("fill", "none");
    node.setAttribute("stroke", stroke);
    node.setAttribute("stroke-width", String(width));
    node.setAttribute("stroke-linecap", "round");
    return node;
  };
  const bed = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bed.setAttribute("x", String(map.bed.min)); bed.setAttribute("y", String(map.bed.min));
  bed.setAttribute("width", String(span)); bed.setAttribute("height", String(span));
  bed.setAttribute("fill", "#141312"); bed.setAttribute("stroke", "#3b3733"); bed.setAttribute("stroke-width", "1");
  svg.appendChild(bed);
  for (const line of map.purge) svg.appendChild(path(line, "#5f5a54", 0.8));
  for (const line of map.paths) svg.appendChild(path(line, "#ECE8E1", 0.6));
  box.textContent = "";
  box.appendChild(el("h2", null, "first layer on the bed"));
  box.appendChild(svg);
  const f = map.footprint;
  if (f) {
    box.appendChild(el("p", "hint",
      "footprint " + (f.maxX - f.minX).toFixed(1) + " × " + (f.maxY - f.minY).toFixed(1) + " mm" +
      (map.clearance !== null ? " · nearest edge " + map.clearance.toFixed(1) + " mm" : "") +
      (map.truncated ? " · drawing truncated" : "")));
  }
}

async function openProject(path, button) {
  button.disabled = true;
  button.textContent = "opening…";
  let r;
  try {
    r = await api("/api/open", { path: path });
  } catch (err) {
    r = { ok: false, error: String(err.message || err) };
  }
  button.disabled = false;
  button.textContent = r.ok ? "opened — open again" : "open in Flash Studio";
  if (!r.ok) {
    const line = el("div", "line bad");
    line.appendChild(el("span", "s", "✗"));
    line.appendChild(el("span", null, r.error || "Flash Studio did not start"));
    button.parentElement.appendChild(line);
  }
}

function dropSetup() {
  const zone = $("#drop");
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    zone.textContent = "saving " + file.name + "…";
    const body = await file.arrayBuffer();
    await fetch("/api/upload", { method: "POST", headers: { "x-filename": encodeURIComponent(file.name) }, body: body });
    zone.textContent = "drop a model here";
    await loadState();
  });
}

$("#slice").onclick = function () { slice(false); };
dropSetup();
loadState();
setInterval(loadState, 20000);
`;

export function page(filaments: string[]): string {
  const options = filaments.map((f) => `<option${f === DEFAULT_FILAMENT ? " selected" : ""}>${f}</option>`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bambu to Flashforge</title>
<style>${STYLE}</style></head>
<body>
<header class="top"><div class="wrap">
  <h1 class="mark">Bambu → Flashforge</h1>
  <div class="pill"><span class="dot" id="slicerdot"></span><span id="slicertext">reading…</span></div>
</div></header>
<div class="wrap"><main>
  <section>
    <div class="card">
      <h2>files in ~/3dprint/in</h2>
      <ul class="files" id="files"></ul>
      <div class="drop" id="drop">drop a model here</div>
    </div>
  </section>
  <section>
    <div class="card">
      <h2>what it is</h2>
      <div id="inspection"><p class="hint">choose a file on the left.</p></div>
      <p class="hint" id="next"></p>
    </div>
    <div class="card">
      <h2>how to slice it</h2>
      <form onsubmit="return false">
        <div><label for="filament">filament</label><select id="filament">${options}</select></div>
        <div><label for="process">layer height</label><select id="process">
          <option value="0.12">0.12 fine</option><option value="0.20" selected>0.20 standard</option>
          <option value="0.24">0.24 draft</option></select></div>
        <div><label for="brim">brim</label><select id="brim">
          <option value="">preset (none)</option><option value="auto_brim">auto</option>
          <option value="outer_only">outer</option></select></div>
        <div><label for="infill">infill</label><input id="infill" type="text" placeholder="preset (15%)"/></div>
        <div><label for="name">name</label><input id="name" type="text" placeholder="from the file"/></div>
      </form>
      <div class="row">
        <button class="go" id="slice" disabled>slice it for the 5M</button>
        <span class="hint">temperatures and speeds come from Flashforge's own presets — they are not on this page</span>
      </div>
      <pre class="log hidden" id="log"></pre>
    </div>
    <div class="card hidden" id="result"></div>
  </section>
</main></div>
<script>${SCRIPT}</script>
</body></html>`;
}
