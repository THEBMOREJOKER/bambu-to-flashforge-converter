/**
 * The page. A flight deck on a blue-black canvas: Flash Studio's readiness across the top, then three bays — the
 * models, the job, and the first layer on the bed. Two colours carry meaning and nothing else is coloured: nozzle heat
 * (orange into amber) for work that is live and the one action that starts it, toolpath cyan for geometry. Numbers are
 * instruments — condensed, tabular, large where they matter. The progress bar rides the slicer's own report, step by
 * step; when a slice passes, its first layer is laid across the bed once. No framework, no build step, no fonts to
 * fetch: it has to come up on a machine with no network, so the faces are the ones Ubuntu ships.
 *
 * The client script below deliberately avoids template literals so this file can hold it as one.
 */

import { DEFAULT_FILAMENT } from "./machine.js";

const STYLE = String.raw`
  :root {
    --void:#05080D; --deck:#0A1018; --deck2:#0E1621; --deck3:#141E2C;
    --rule:#17222F; --rule2:#223246; --rule3:#30455D;
    --ink:#E7EEF7; --ink2:#97A6BA; --ink3:#607086;
    --heat:#FF6A1A; --heat2:#FFB347; --heatdeep:#7C2604;
    --path:#3DCBFF;
    --ok:#31E2A2; --warn:#FFC24B; --bad:#FF4F64;
    --sans:"Ubuntu Sans","Ubuntu","Noto Sans","DejaVu Sans",sans-serif;
    --mono:"Ubuntu Sans Mono","Ubuntu Mono","Noto Sans Mono","DejaVu Sans Mono",monospace;
    --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px;
    color-scheme:dark;
  }
  * { box-sizing:border-box; }
  html, body { margin:0; min-height:100%; }
  body { background:var(--void); color:var(--ink); font:14px/1.5 var(--sans); -webkit-font-smoothing:antialiased;
    scrollbar-color:var(--rule3) transparent; }
  body::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:linear-gradient(rgba(61,203,255,.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(61,203,255,.045) 1px, transparent 1px);
    background-size:44px 44px;
    -webkit-mask-image:radial-gradient(ellipse 90% 70% at 50% 0%, #000 10%, transparent 75%);
    mask-image:radial-gradient(ellipse 90% 70% at 50% 0%, #000 10%, transparent 75%); }
  ::selection { background:rgba(61,203,255,.3); }
  :focus-visible { outline:2px solid var(--path); outline-offset:2px; }
  .hidden { display:none !important; }
  h2 { margin:0; font:600 13px/1.3 var(--sans); color:var(--ink2); }
  h3 { margin:0; font:600 13px/1.3 var(--sans); }
  .fine { margin:0; font-size:12px; line-height:1.45; color:var(--ink3); overflow-wrap:anywhere; }

  /* the bar: brand and Flash Studio's readiness */
  .bar { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:var(--s5); flex-wrap:wrap;
    padding:10px var(--s5); background:rgba(5,8,13,.985); border-bottom:1px solid var(--rule);
    -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); }
  .brand { display:flex; align-items:center; gap:var(--s3); }
  .glyph { width:34px; height:34px; flex:none; }
  .brand h1 { margin:0; font:680 20px/1 var(--sans); font-variation-settings:"wdth" 78; letter-spacing:.01em; }
  .brand p { margin:4px 0 0; font-size:12px; color:var(--ink3); }
  .telemetry { margin-left:auto; display:flex; gap:var(--s2); flex-wrap:wrap; }
  .gauge { min-width:96px; padding:6px 12px 7px; border:1px solid var(--rule); border-radius:9px;
    background:linear-gradient(180deg, var(--deck2), var(--deck)); }
  .gauge .k { display:block; font-size:11px; line-height:1.3; color:var(--ink3); white-space:nowrap; }
  .gauge .v { display:flex; align-items:baseline; gap:5px; font:520 18px/1.2 var(--sans);
    font-variation-settings:"wdth" 76; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .gauge .v small { font-size:11px; color:var(--ink3); font-variation-settings:"wdth" 100; }
  .gauge.wide { width:250px; }
  .gauge.wide .v { display:block; overflow:hidden; text-overflow:ellipsis; font-size:15px; font-variation-settings:"wdth" 88; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--ink3); align-self:center; flex:none; }
  .dot.on { background:var(--ok); box-shadow:0 0 10px var(--ok); }
  .dot.warn { background:var(--warn); box-shadow:0 0 10px var(--warn); }
  .dot.off { background:var(--bad); box-shadow:0 0 10px var(--bad); }
  .dot.live { background:var(--heat); box-shadow:0 0 12px var(--heat); animation:throb 1.2s ease-in-out infinite; }

  /* the deck: models · job · first layer */
  .deck { position:relative; z-index:1; display:grid; gap:var(--s4); max-width:1680px; margin:0 auto;
    grid-template-columns:272px minmax(0,1fr) minmax(0,460px); padding:var(--s4) var(--s5) var(--s6); }
  .bay { min-width:0; padding:var(--s4); border:1px solid var(--rule); border-radius:14px;
    background:linear-gradient(180deg, var(--deck2), var(--deck) 180px); }
  .bay-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s3); margin-bottom:var(--s3); }
  .count { font:400 12px/1.2 var(--mono); color:var(--ink3); text-align:right; }
  .rail { position:sticky; top:84px; align-self:start; display:flex; flex-direction:column; max-height:calc(100vh - 100px); }
  .proof { position:sticky; top:84px; align-self:start; max-height:calc(100vh - 100px); overflow:auto; }
  @media (max-width:1280px) {
    .deck { grid-template-columns:260px minmax(0,1fr); }
    .rail { grid-row:span 2; }
    .proof { grid-column:2; position:static; max-height:none; overflow:visible; }
  }
  @media (max-width:820px) {
    .bar { padding:10px var(--s3); gap:var(--s3); }
    .telemetry { margin-left:0; width:100%; }
    .gauge { flex:1; min-width:0; }
    .gauge.wide { flex-basis:100%; width:auto; }
    .deck { grid-template-columns:minmax(0,1fr); padding:var(--s3); gap:var(--s3); }
    .rail { position:static; max-height:none; grid-row:auto; }
    .proof { grid-column:auto; }
  }

  /* models */
  .files { list-style:none; margin:0 -8px; padding:0; overflow:auto; flex:1 1 auto; min-height:60px; }
  .files li + li { margin-top:2px; }
  .files li.empty { padding:12px 8px; color:var(--ink3); font-size:13px; }
  .files button { position:relative; display:block; width:100%; padding:9px 10px 9px 16px; border:0; border-radius:9px;
    background:transparent; color:var(--ink); text-align:left; cursor:pointer; font:inherit; transition:background .15s; }
  .files button:hover { background:var(--deck3); }
  .files button.on { background:linear-gradient(90deg, rgba(255,106,26,.16), rgba(255,106,26,0) 85%); }
  .files button.on::before { content:""; position:absolute; left:4px; top:9px; bottom:9px; width:3px; border-radius:2px;
    background:linear-gradient(var(--heat2), var(--heat)); box-shadow:0 0 10px var(--heat); }
  .files .name { display:block; font:520 13.5px/1.35 var(--sans); overflow-wrap:anywhere; }
  .files .meta { display:flex; flex-wrap:wrap; gap:4px 10px; margin-top:3px; font:400 11.5px/1.2 var(--mono); color:var(--ink3); }
  .files .ext { color:var(--ink2); }
  .files .done { color:var(--ok); }
  .files button.other .name { color:var(--ink3); }
  .drop { display:flex; align-items:center; gap:10px; margin-top:var(--s3); padding:12px 14px; border:1px dashed var(--rule3);
    border-radius:11px; color:var(--ink2); font-size:13px; cursor:pointer; transition:border-color .15s, background .15s; }
  .drop:hover { border-color:var(--path); color:var(--ink); }
  .drop:focus-within { border-color:var(--path); }
  .drop svg { width:20px; height:20px; flex:none; color:var(--path); }
  .drop input { position:absolute; width:1px; height:1px; opacity:0; }
  .drop.over { border-color:var(--path); border-style:solid; color:var(--ink); background:rgba(61,203,255,.08);
    box-shadow:inset 0 0 0 3px rgba(61,203,255,.12); }
  .next { margin:var(--s3) 0 0; font-size:12px; color:var(--ink3); }
  .next.warn { color:var(--warn); }

  /* the model */
  .model { padding-bottom:var(--s4); margin-bottom:var(--s4); border-bottom:1px solid var(--rule); }
  .lede { margin:var(--s5) 0; font-size:16px; color:var(--ink3); }
  .model-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s4); }
  .title { margin:0; font:660 30px/1.06 var(--sans); font-variation-settings:"wdth" 76; color:var(--ink); overflow-wrap:anywhere; }
  .sub { display:flex; flex-wrap:wrap; gap:4px 14px; margin-top:7px; font-size:13px; color:var(--ink3); }
  .sub .by { color:var(--ink2); }
  .sub .file { font:400 12px/1.5 var(--mono); overflow-wrap:anywhere; }
  .tag { flex:none; margin-top:4px; padding:5px 11px; border:1px solid var(--rule3); border-radius:999px;
    font:600 12px/1 var(--sans); color:var(--ink2); }
  .tag.convert, .tag.slice { color:var(--path); border-color:rgba(61,203,255,.45); background:rgba(61,203,255,.08); }
  .tag.refuse { color:var(--bad); border-color:rgba(255,79,100,.45); background:rgba(255,79,100,.08); }
  .because { margin:10px 0 0; color:var(--ink2); }
  .specs { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:1px; margin-top:var(--s4);
    overflow:hidden; background:var(--rule); border:1px solid var(--rule); border-radius:11px; }
  .spec { padding:10px 12px; background:var(--deck); }
  .spec .k { display:block; font-size:11.5px; color:var(--ink3); }
  .spec .v { display:block; margin-top:2px; font:520 14px/1.3 var(--sans); overflow-wrap:anywhere; }
  .spec.good .v { color:var(--ok); }
  .spec.bad .v { color:var(--bad); }
  .objects { display:flex; flex-wrap:wrap; gap:6px; margin-top:var(--s3); }
  .obj { display:inline-flex; align-items:center; gap:8px; padding:4px 11px 4px 4px; border:1px solid var(--rule2);
    border-radius:999px; font:400 12px/1 var(--mono); color:var(--ink2); }
  .obj b { display:inline-grid; place-items:center; min-width:20px; height:20px; border-radius:999px;
    background:var(--deck3); color:var(--ink); font:600 11px/1 var(--sans); }
  .notes { margin-top:var(--s4); padding:12px 14px; border:1px solid rgba(255,194,75,.3); border-radius:11px;
    background:linear-gradient(180deg, rgba(255,194,75,.07), rgba(255,194,75,.015)); }
  .notes h3 { color:var(--warn); font-size:12.5px; }
  .notes p { margin:6px 0 0; font-size:13px; color:var(--ink); overflow-wrap:anywhere; }
  .notes p b { margin-right:6px; font-weight:600; color:var(--ink2); }
  .notes .clamp { display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  .notes.open .clamp { display:block; }
  .flags { display:grid; gap:4px; margin-top:var(--s3); }
  .fold { margin-top:var(--s3); }
  .fold summary, .checks summary { display:flex; align-items:center; gap:8px; list-style:none; cursor:pointer;
    font-size:12.5px; color:var(--ink2); }
  .fold summary::-webkit-details-marker, .checks summary::-webkit-details-marker { display:none; }
  .fold summary::before, .checks summary::before { content:"▸"; color:var(--ink3); transition:transform .15s; }
  .fold[open] summary::before, .checks[open] summary::before { transform:rotate(90deg); }
  .fold .flags { margin-top:8px; }
  .flag { display:flex; gap:10px; align-items:baseline; font-size:13px; color:var(--ink2); overflow-wrap:anywhere; }
  .flag .s { flex:none; width:14px; text-align:center; font-weight:700; }
  .flag.ok .s { color:var(--ok); }
  .flag.warn .s { color:var(--warn); }
  .flag.bad .s { color:var(--bad); }
  .flag.bad { color:#FFB8C1; }

  /* settings */
  .fields { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:14px 16px; }
  .field.span2 { grid-column:1 / -1; }
  .field > label, .field > .label { display:block; margin:0 0 6px; font-size:12px; color:var(--ink2); }
  @media (max-width:560px) { .fields { grid-template-columns:minmax(0,1fr); } }
  select, input[type=text] { width:100%; height:42px; padding:0 12px; border:1px solid var(--rule2); border-radius:10px;
    background-color:var(--void); color:var(--ink); font:400 14px/1 var(--sans); transition:border-color .15s, box-shadow .15s; }
  select { -webkit-appearance:none; appearance:none; padding-right:34px; background-repeat:no-repeat;
    background-position:right 13px center;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M1 1l4 4 4-4' fill='none' stroke='%2397A6BA' stroke-width='1.5'/></svg>"); }
  input::placeholder { color:var(--ink3); }
  select:hover, input[type=text]:hover { border-color:var(--rule3); }
  select:focus-visible, input[type=text]:focus-visible { outline:none; border-color:var(--path);
    box-shadow:0 0 0 3px rgba(61,203,255,.2); }
  .seg { display:flex; gap:3px; padding:3px; border:1px solid var(--rule2); border-radius:11px; background:var(--void); }
  .seg input { position:absolute; width:1px; height:1px; opacity:0; }
  .seg label { flex:1; display:flex; flex-direction:column; align-items:center; gap:1px; padding:6px 4px; border-radius:8px;
    color:var(--ink2); cursor:pointer; transition:background .15s, color .15s; }
  .seg label:hover { color:var(--ink); }
  .seg label b { font:620 14px/1.15 var(--sans); font-variation-settings:"wdth" 82; font-variant-numeric:tabular-nums; }
  .seg label small { font-size:11px; color:var(--ink3); }
  .seg input:checked + label { background:var(--deck3); color:var(--ink);
    box-shadow:inset 0 0 0 1px var(--rule3), 0 0 14px -5px rgba(61,203,255,.6); }
  .seg input:checked + label small { color:var(--path); }
  .seg input:focus-visible + label { outline:2px solid var(--path); outline-offset:1px; }
  .launch { display:flex; align-items:center; gap:var(--s4); flex-wrap:wrap; margin-top:var(--s4); }
  .launch .fine { flex:1; min-width:200px; }

  /* the one action */
  .ignite { display:inline-flex; align-items:center; justify-content:center; gap:10px; padding:13px 24px; border:0;
    border-radius:11px; cursor:pointer; color:#1C0900; font:680 15px/1 var(--sans); font-variation-settings:"wdth" 84;
    background:linear-gradient(180deg, var(--heat2), var(--heat));
    box-shadow:inset 0 0 0 1px rgba(255,210,150,.55), inset 0 1px 0 rgba(255,255,255,.35), 0 10px 30px -10px rgba(255,106,26,.8);
    transition:transform .12s, box-shadow .2s, filter .2s; }
  .ignite:hover:not(:disabled) { filter:brightness(1.07);
    box-shadow:inset 0 0 0 1px rgba(255,230,190,.8), inset 0 1px 0 rgba(255,255,255,.4), 0 12px 38px -8px rgba(255,106,26,1); }
  .ignite:active:not(:disabled) { transform:translateY(1px); }
  .ignite:disabled { cursor:not-allowed; color:var(--ink3); background:var(--deck3); box-shadow:inset 0 0 0 1px var(--rule2); }
  .ghost { display:inline-flex; align-items:center; justify-content:center; padding:10px 16px; border:1px solid var(--rule3);
    border-radius:10px; background:transparent; color:var(--ink); font:600 13.5px/1 var(--sans); cursor:pointer;
    transition:border-color .15s, background .15s; }
  .ghost:hover { border-color:var(--path); background:rgba(61,203,255,.06); }
  .ghost.small { margin-top:8px; padding:6px 10px; font-size:12px; color:var(--ink2); }

  /* the run: the slicer's own report, step by step */
  .run { margin-top:var(--s4); padding:var(--s4); border:1px solid var(--rule2); border-radius:13px;
    background:radial-gradient(120% 160% at 0% 0%, rgba(255,106,26,.09), transparent 55%), #04070B; }
  .run.done { background:radial-gradient(120% 160% at 0% 0%, rgba(49,226,162,.08), transparent 55%), #04070B; }
  .run.failed { background:radial-gradient(120% 160% at 0% 0%, rgba(255,79,100,.09), transparent 55%), #04070B; }
  .stages { display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; margin-bottom:var(--s4); }
  .stages span { position:relative; padding-top:9px; font-size:12px; color:var(--ink3); transition:color .3s; }
  .stages span::before { content:""; position:absolute; left:0; right:0; top:0; height:3px; border-radius:3px;
    background:var(--rule2); transition:background .3s, box-shadow .3s; }
  .stages span.past { color:var(--ink2); }
  .stages span.past::before { background:var(--ink3); }
  .stages span.on { color:var(--heat2); }
  .stages span.on::before { background:linear-gradient(90deg, var(--heat), var(--heat2)); box-shadow:0 0 12px rgba(255,140,50,.7); }
  .run.done .stages span { color:var(--ok); }
  .run.done .stages span::before { background:var(--ok); box-shadow:none; }
  .readout { display:flex; align-items:flex-end; gap:var(--s4); }
  .pct { min-width:2.5ch; font:300 52px/.86 var(--sans); font-variation-settings:"wdth" 75;
    font-variant-numeric:tabular-nums; color:var(--ink); }
  .pct i { margin-left:2px; font-style:normal; font-size:21px; color:var(--ink3); }
  .run.done .pct { color:var(--ok); }
  .run.failed .pct { color:var(--bad); }
  .step { flex:1; min-width:0; padding-bottom:3px; }
  .step b { display:block; font:560 16px/1.3 var(--sans); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .step small { display:block; font-size:12px; color:var(--ink3); }
  .run.failed .step b { white-space:normal; color:#FFB8C1; }
  .clock { padding-bottom:5px; font:400 13px/1 var(--mono); font-variant-numeric:tabular-nums; color:var(--ink3); }
  .track { position:relative; height:12px; margin-top:var(--s4); border-radius:999px; background:#020408;
    box-shadow:inset 0 0 0 1px var(--rule2), inset 0 2px 6px rgba(0,0,0,.7); }
  .fill { position:absolute; left:0; top:0; bottom:0; width:0; border-radius:999px;
    background:linear-gradient(90deg, var(--heatdeep), var(--heat) 62%, var(--heat2));
    box-shadow:0 0 20px rgba(255,106,26,.5); transition:width .6s cubic-bezier(.2,.7,.2,1); }
  .fill::after { content:""; position:absolute; inset:0; border-radius:inherit;
    background:repeating-linear-gradient(115deg, rgba(255,255,255,0) 0 10px, rgba(255,255,255,.2) 10px 14px);
    background-size:28px 100%; animation:flow .8s linear infinite; }
  .head { position:absolute; right:-10px; top:50%; width:20px; height:20px; margin-top:-10px; border-radius:50%;
    background:radial-gradient(circle, #FFFFFF 0 20%, #FFE6BD 36%, rgba(255,179,71,.85) 52%, rgba(255,106,26,0) 72%);
    animation:throb 1.1s ease-in-out infinite; }
  .run.done .fill { background:linear-gradient(90deg, #0B5E43, var(--ok)); box-shadow:0 0 16px rgba(49,226,162,.35); }
  .run.failed .fill { background:linear-gradient(90deg, #5E0C1A, var(--bad)); box-shadow:0 0 16px rgba(255,79,100,.35); }
  .run.done .fill::after, .run.failed .fill::after, .run.done .head, .run.failed .head { display:none; }
  .scale { height:7px; margin-top:6px; opacity:.9;
    background:repeating-linear-gradient(90deg, var(--rule3) 0 1px, transparent 1px 5%) 0 0 / 100% 4px no-repeat,
      repeating-linear-gradient(90deg, var(--ink3) 0 1px, transparent 1px 25%) 0 0 / 100% 7px no-repeat; }
  @keyframes flow { from { background-position:0 0; } to { background-position:28px 0; } }
  @keyframes throb { 0%, 100% { transform:scale(1); opacity:1; } 50% { transform:scale(1.28); opacity:.78; } }
  .log { margin-top:var(--s3); }
  .log summary { display:flex; align-items:center; gap:8px; list-style:none; cursor:pointer; font-size:12.5px; color:var(--ink2); }
  .log summary::-webkit-details-marker { display:none; }
  .log summary::before { content:"▸"; color:var(--ink3); transition:transform .15s; }
  .log[open] summary::before { transform:rotate(90deg); }
  .log summary span { font-family:var(--mono); font-size:11.5px; color:var(--ink3); }
  .log pre { max-height:260px; margin:8px 0 0; padding:12px; overflow:auto; border:1px solid var(--rule); border-radius:10px;
    background:#020408; color:var(--ink2); font:400 11.5px/1.55 var(--mono); white-space:pre-wrap; overflow-wrap:anywhere; }

  /* what changed */
  .changes { margin-top:var(--s5); padding-top:var(--s4); border-top:1px solid var(--rule); }
  .changes > h2 { margin-bottom:var(--s3); }
  .change { padding:12px 14px; border:1px solid var(--rule); border-radius:11px; background:var(--deck); }
  .change + .change { margin-top:8px; }
  .change summary { cursor:pointer; font:600 13px/1.3 var(--sans); }
  .change p { margin:4px 0 0; font-size:13px; color:var(--ink2); }
  .change ul { margin:6px 0 0; padding-left:18px; font-size:13px; color:var(--ink2); }
  .change code { display:block; margin-top:8px; font:400 12px/1.55 var(--mono); color:var(--path); overflow-wrap:anywhere; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; margin-top:10px; border-collapse:collapse; font-size:12.5px; }
  th { padding:4px 10px 6px 0; border-bottom:1px solid var(--rule2); color:var(--ink3); font-weight:500; text-align:left; }
  td { padding:5px 10px 5px 0; border-bottom:1px solid var(--rule); vertical-align:top; overflow-wrap:anywhere; }
  td.key { font-family:var(--mono); font-size:12px; color:var(--ink); }
  td.was { color:var(--ink3); text-decoration:line-through; text-decoration-color:rgba(255,79,100,.55); }

  /* the first layer, and the verdict */
  .plate { padding:10px; border:1px solid var(--rule2); border-radius:13px; overflow:hidden;
    background:radial-gradient(90% 90% at 50% 40%, #0B1724, #04080D); }
  svg.bed { display:block; width:100%; height:auto; }
  .bed .sheet { fill:#07101A; stroke:var(--rule3); stroke-width:.6; }
  .bed .grid { stroke:#12202F; stroke-width:.25; }
  .bed .grid.major { stroke:#1B2F45; stroke-width:.45; }
  .bed .lbl { fill:var(--ink3); font-family:var(--mono); font-size:5px; }
  .bed .lbl.empty { font-family:var(--sans); font-size:7px; }
  .bed .purge path { fill:none; stroke:#3C5873; stroke-width:.6; stroke-linecap:round; }
  .bed .toolpath path { fill:none; stroke:var(--path); stroke-width:.5; stroke-linecap:round; stroke-linejoin:round; }
  .bed .toolpath.reveal { animation:lay 1.7s cubic-bezier(.35,.55,.2,1) both; }
  .bed .scan { fill:#C8F2FF; animation:scan 1.7s cubic-bezier(.35,.55,.2,1) both; }
  @keyframes lay { from { clip-path:inset(0 100% 0 0); } to { clip-path:inset(0 0 0 0); } }
  @keyframes scan { 0% { transform:translateX(0); opacity:1; } 90% { opacity:1; } 100% { transform:translateX(var(--run)); opacity:0; } }
  .verdict { display:grid; gap:10px; margin-top:var(--s4); }
  .verdict:empty { display:none; }
  .verdict h3 { margin-top:4px; color:var(--ink2); }
  .stamp { display:flex; align-items:center; gap:12px; padding:12px 14px; border:1px solid; border-radius:12px; }
  .stamp .mark { display:grid; place-items:center; width:36px; height:36px; flex:none; border-radius:50%; font:700 18px/1 var(--sans); }
  .stamp b { display:block; font:660 18px/1.2 var(--sans); font-variation-settings:"wdth" 82; }
  .stamp span { font-size:12.5px; color:var(--ink2); }
  .stamp.ok { border-color:rgba(49,226,162,.38); background:linear-gradient(90deg, rgba(49,226,162,.13), rgba(49,226,162,.02)); }
  .stamp.ok .mark { background:rgba(49,226,162,.16); color:var(--ok); box-shadow:0 0 18px rgba(49,226,162,.35); }
  .stamp.bad { border-color:rgba(255,79,100,.38); background:linear-gradient(90deg, rgba(255,79,100,.13), rgba(255,79,100,.02)); }
  .stamp.bad .mark { background:rgba(255,79,100,.16); color:var(--bad); }
  .readouts { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:1px; overflow:hidden;
    background:var(--rule); border:1px solid var(--rule); border-radius:11px; }
  .ro { min-width:0; padding:9px 10px; background:var(--deck); }
  .ro .k { display:block; font-size:11px; color:var(--ink3); white-space:nowrap; }
  .ro .v { display:block; margin-top:2px; font:520 20px/1.1 var(--sans); font-variation-settings:"wdth" 74;
    font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .ro .v small { margin-left:2px; font-size:11px; color:var(--ink3); font-variation-settings:"wdth" 100; }
  @media (max-width:440px) { .readouts { grid-template-columns:repeat(3, minmax(0,1fr)); } }
  .act { display:flex; }
  .act .ignite { flex:1; }
  .checks > div { display:grid; gap:3px; margin-top:8px; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation:none !important; transition:none !important; }
    .bed .scan { display:none; }
  }
`;

const SCRIPT = String.raw`
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
const SVGNS = "http://www.w3.org/2000/svg";
const STAGES = ["prepare", "slice", "check", "save"];
const state = { file: null, name: "", result: null, started: 0, poll: null, outputs: [] };

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svg(tag, attrs) {
  const node = document.createElementNS(SVGNS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
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
function decoded(name) { try { return decodeURIComponent(name); } catch (err) { return name; } }
function pretty(name) {
  return decoded(String(name || "")).replace(/\.(gcode\.3mf|gcode|3mf|stl|step|stp|obj|pdf)$/i, "")
    .replace(/-(mesh-)?ad5m$/i, "").replace(/[+_]+/g, " ").replace(/\s+/g, " ").trim();
}
function ext(name) { const m = /\.([a-z0-9]+)$/i.exec(name); return m ? m[1].toUpperCase() : ""; }
function cap(text) { text = String(text || ""); return text.charAt(0).toUpperCase() + text.slice(1); }
function clock(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function uniq(list) { return list.filter((v, n) => list.indexOf(v) === n); }
function checked(name) { const n = document.querySelector("input[name='" + name + "']:checked"); return n ? n.value : ""; }
function flag(kind, text) {
  const row = el("div", "flag " + kind);
  row.appendChild(el("span", "s", kind === "ok" ? "✓" : kind === "bad" ? "✗" : "!"));
  row.appendChild(el("span", null, text));
  return row;
}

async function loadState() {
  let s;
  try { s = await api("/api/state"); } catch (err) { return; }
  renderTelemetry(s);
  state.outputs = s.work.out.map((f) => f.name.split("/").pop());
  $("#next").textContent = s.next;
  $("#next").className = s.blocks.length ? "next warn" : "next";
  renderFiles(s.work.in);
}

function renderTelemetry(s) {
  const ready = s.slicer.found && s.slicer.profiles;
  $("#slicerdot").className = "dot " + (ready ? "on" : s.slicer.found ? "warn" : "off");
  $("#t-slicer").textContent = ready ? "Ready" : s.slicer.found ? "Presets missing" : "Not found";
  $("#t-presets").textContent = s.slicer.profiles ? "AD5M 0.4" : "Missing";
  const made = s.work.out.filter((f) => /-ad5m\.3mf$/.test(f.name));
  $("#t-count").textContent = String(made.length);
  $("#t-last").textContent = made.length ? pretty(made[0].name.split("/").pop()) : "—";
  $("#t-last").title = made.length ? made[0].path : "";
}

function renderFiles(files) {
  const list = $("#files");
  list.textContent = "";
  $("#count").textContent = files.length + (files.length === 1 ? " file" : " files");
  if (!files.length) { list.appendChild(el("li", "empty", "Nothing here yet — drop a model below.")); return; }
  for (const f of files) {
    const li = el("li");
    const button = el("button");
    button.type = "button";
    button.title = f.name;
    if (f.path === state.file) button.classList.add("on");
    if (!/\.(3mf|stl|step|stp|obj|gcode)$/i.test(f.name)) button.classList.add("other");
    button.appendChild(el("span", "name", pretty(f.name)));
    const meta = el("span", "meta");
    meta.appendChild(el("span", "ext", ext(f.name)));
    meta.appendChild(el("span", null, mb(f.bytes)));
    meta.appendChild(el("span", null, when(f.modified)));
    const stem = f.name.replace(/\.[^.]+$/, "");
    if (state.outputs.some((h) => h.indexOf(stem + "-") === 0 && /-ad5m\.3mf$/.test(h))) meta.appendChild(el("span", "done", "✓ converted"));
    button.appendChild(meta);
    button.onclick = () => choose(f.path, f.name, button);
    li.appendChild(button);
    list.appendChild(li);
  }
}

async function choose(path, name, button) {
  for (const b of $$("#files button")) b.classList.remove("on");
  if (button) button.classList.add("on");
  state.file = path;
  state.name = name;
  state.result = null;
  $("#slice").disabled = true;
  resetOutcome();
  const box = $("#inspection");
  box.textContent = "";
  box.appendChild(el("p", "lede", "Reading " + pretty(name) + "…"));
  try {
    const i = await api("/api/inspect", { path: path });
    if (state.file !== path) return;
    renderInspection(i, name);
    $("#slice").disabled = i.verdict === "REFUSE";
  } catch (err) {
    box.textContent = "";
    box.appendChild(flag("bad", String(err.message || err)));
  }
}

function resetOutcome() {
  $("#run").classList.add("hidden");
  $("#logbox").classList.add("hidden");
  $("#changes").classList.add("hidden");
  $("#verdict").textContent = "";
  drawPlate(null, false);
}

const NOTE_LABELS = { Description: "Description", ProfileTitle: "Profile", ProfileDescription: "Profile notes" };

function renderInspection(i, name) {
  const box = $("#inspection");
  box.textContent = "";
  const notes = i.notes || {};
  const head = el("div", "model-head");
  const titles = el("div");
  titles.appendChild(el("h2", "title", notes.Title || pretty(i.file || name)));
  const sub = el("div", "sub");
  if (notes.Designer) sub.appendChild(el("span", "by", "by " + notes.Designer));
  sub.appendChild(el("span", "file", (i.file || name) + " · " + i.megabytes.toFixed(1) + " MB"));
  titles.appendChild(sub);
  head.appendChild(titles);
  const verdict = String(i.verdict || "").toLowerCase();
  head.appendChild(el("span", "tag " + verdict, cap(verdict)));
  box.appendChild(head);
  if (i.because) box.appendChild(el("p", "because", i.because));

  const specs = el("div", "specs");
  const spec = (k, v, cls) => {
    const d = el("div", "spec" + (cls ? " " + cls : ""));
    d.appendChild(el("span", "k", k));
    d.appendChild(el("span", "v", v));
    specs.appendChild(d);
  };
  if (i.project) {
    spec("Made for", i.project.printerModel);
    spec("Their profile", i.project.layerHeight + " mm · " + i.project.infill + " infill");
    spec("Filament slots", i.project.filaments.length + " · " + uniq(i.project.filamentTypes).join(", "));
    spec("Supports · brim", (i.project.supports ? "on" : "off") + " · " + i.project.brim);
  }
  if (i.mesh) spec("Mesh", i.mesh.triangles.toLocaleString() + " triangles");
  if (i.objects && i.objects.length) {
    spec("Objects", String(i.objects.length));
    spec("Bed fit", i.fits ? "Fits 220 × 220 × 220" : "Too big — scaling or splitting is your call", i.fits ? "good" : "bad");
  }
  if (specs.childNodes.length) box.appendChild(specs);
  if (i.objects && i.objects.length) {
    const objects = el("div", "objects");
    i.objects.forEach((o, n) => {
      const chip = el("span", "obj");
      chip.appendChild(el("b", null, String(n + 1)));
      chip.appendChild(document.createTextNode(o.size.map((v) => v.toFixed(1)).join(" × ") + " mm"));
      objects.appendChild(chip);
    });
    box.appendChild(objects);
  }
  const keys = Object.keys(notes).filter((k) => k !== "Title" && k !== "Designer");
  if (keys.length) {
    const panel = el("div", "notes");
    panel.appendChild(el("h3", null, "The designer's notes — read these before slicing; nothing downstream carries them"));
    for (const k of keys) {
      const row = el("p", "clamp");
      row.appendChild(el("b", null, NOTE_LABELS[k] || k));
      row.appendChild(document.createTextNode(notes[k]));
      panel.appendChild(row);
    }
    if (keys.some((k) => String(notes[k]).length > 180)) {
      const more = el("button", "ghost small", "Show all");
      more.type = "button";
      more.onclick = () => {
        panel.classList.toggle("open");
        more.textContent = panel.classList.contains("open") ? "Show less" : "Show all";
      };
      panel.appendChild(more);
    }
    box.appendChild(panel);
  }
  if (i.warnings && i.warnings.length) {
    const routine = i.warnings.every((w) => /convert (moves|replaces)/.test(w));
    const fold = el("details", "fold");
    fold.open = !routine;
    fold.appendChild(el("summary", null, (routine ? "What convert will change" : "Look at these first") + " (" + i.warnings.length + ")"));
    const list = el("div", "flags");
    for (const w of i.warnings) list.appendChild(flag("warn", w));
    fold.appendChild(list);
    box.appendChild(fold);
  }
}

async function slice(fromMesh) {
  if (!state.file || state.poll) return;
  const go = $("#slice");
  go.disabled = true;
  go.textContent = "Slicing…";
  resetOutcome();
  $("#log").textContent = "";
  $("#logcount").textContent = "";
  $("#logbox").open = false;
  $("#logbox").classList.remove("hidden");
  startRun();
  const options = {
    path: state.file,
    process: checked("process"),
    filament: $("#filament").value,
    brim: checked("brim"),
    infill: $("#infill").value.trim(),
    name: $("#name").value.trim(),
    fromMesh: fromMesh === true ? "1" : "",
  };
  const release = () => { go.disabled = false; go.textContent = "Slice for the 5M"; };
  let job;
  try {
    job = await api("/api/slice", options);
  } catch (err) {
    finishRun(false, String(err.message || err));
    release();
    return;
  }
  let seen = 0;
  const tick = async () => {
    let update;
    try { update = await api("/api/job?id=" + encodeURIComponent(job.id)); } catch (err) { return; }
    if (update.lines.length > seen) {
      $("#log").textContent += update.lines.slice(seen).join("\n") + "\n";
      $("#log").scrollTop = $("#log").scrollHeight;
      seen = update.lines.length;
      $("#logcount").textContent = seen + (seen === 1 ? " line" : " lines");
    }
    if (update.progress) showProgress(update.progress);
    $("#run-time").textContent = clock(Date.now() - state.started);
    if (!update.done) return;
    clearInterval(state.poll);
    state.poll = null;
    release();
    const r = update.result;
    state.result = r || null;
    const ok = Boolean(r && r.delivered);
    finishRun(ok, ok ? "Saved for Flash Studio" : r ? (r.advice || r.errorString) : (update.error || "Stopped"));
    if (r) {
      renderChanges(r);
      renderVerdict(r);
      if (r.maps && r.maps[0]) drawPlate(r.maps[0], true);
    } else {
      renderVerdict({ checks: [], advice: update.error });
    }
    if (!ok) $("#logbox").open = true;
    loadState();
  };
  state.poll = setInterval(tick, 400);
}

function startRun() {
  state.started = Date.now();
  $("#run").className = "run live";
  $("#run-plate").textContent = "";
  $("#run-time").textContent = "0:00";
  setBar(0, "Starting", "prepare");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("#run").scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
}
function showProgress(p) {
  const stage = p.stage === "retry" ? "prepare" : p.stage === "done" ? "save" : p.stage;
  setBar(p.percent, cap(p.text), stage);
  $("#run-plate").textContent = p.plates && p.plates > 1 ? "Plate " + p.plate + " of " + p.plates : "";
}
function setBar(percent, text, stage) {
  $("#run-fill").style.width = percent + "%";
  $("#run-pct").textContent = String(percent);
  $("#run-text").textContent = text;
  $("#run").setAttribute("aria-valuenow", String(percent));
  $("#run").setAttribute("aria-valuetext", percent + "% — " + text);
  const at = STAGES.indexOf(stage);
  $$("#run .stages span").forEach((s, n) => { s.className = n < at ? "past" : n === at ? "on" : ""; });
}
function finishRun(ok, text) {
  const run = $("#run");
  run.classList.remove("live");
  run.classList.add(ok ? "done" : "failed");
  if (ok) {
    $("#run-fill").style.width = "100%";
    $("#run-pct").textContent = "100";
    $$("#run .stages span").forEach((s) => { s.className = "past"; });
  }
  $("#run-text").textContent = text;
  $("#run-time").textContent = clock(Date.now() - state.started);
}

function change(title, text, items, code) {
  const d = el("div", "change");
  d.appendChild(el("h3", null, title));
  if (text) d.appendChild(el("p", null, text));
  if (items && items.length) {
    const ul = el("ul");
    for (const t of items) ul.appendChild(el("li", null, t));
    d.appendChild(ul);
  }
  if (code) d.appendChild(el("code", null, code));
  return d;
}
function settingsTable(title, rows, open) {
  const d = el("details", "change");
  d.open = open;
  d.appendChild(el("summary", null, title + " (" + rows.length + ")"));
  const wrap = el("div", "table-wrap");
  const t = el("table");
  const head = el("tr");
  for (const h of ["Setting", "Was", "Now"]) head.appendChild(el("th", null, h));
  t.appendChild(head);
  for (const o of rows) {
    const tr = el("tr");
    tr.appendChild(el("td", "key", o.key));
    tr.appendChild(el("td", "was", String(o.was)));
    tr.appendChild(el("td", null, String(o.now)));
    t.appendChild(tr);
  }
  wrap.appendChild(t);
  d.appendChild(wrap);
  return d;
}
function renderChanges(r) {
  const box = $("#changes");
  box.textContent = "";
  const blocks = [];
  if (r.separated && r.separated.objects.length) {
    blocks.push(change("Parts merged into one object, taken apart", "Each piece is an object of its own now, where it sat — move, orient and set them apart.",
      r.separated.objects.map((o) => o.name + ": " + o.pieces + " pieces — "
        + o.sizes.map((s) => s.map((v) => v.toFixed(1)).join("×")).join(", ") + " mm")));
  }
  if (r.separated && r.separated.held.length) {
    blocks.push(change("Parts merged into one object, left as they are", null,
      r.separated.held.map((h) => h.name + ": " + h.pieces + " parts — " + h.why)));
  }
  if (r.variants && r.variants.keys.length) {
    blocks.push(change("Nozzle kinds taken out", "The project names " + r.variants.kinds.join(" and ") + "; the 5M has one.",
      null, r.variants.keys.join(", ")));
  }
  if (r.plateNames && r.plateNames.length) {
    blocks.push(change("Plate names taken out", "Flash Studio's command line crashes on a named plate.", r.plateNames));
  }
  if (r.collapsed && (r.collapsed.moved.length || r.collapsed.dropped.length)) {
    blocks.push(change("Moved onto the one extruder", null, r.collapsed.moved.concat(
      r.collapsed.dropped.map((d) => d + " — taken out; a pause there is yours to ask for"))));
  }
  if (r.droppedKeys && r.droppedKeys.length) {
    blocks.push(change("Values Flash Studio refuses, dropped", "The AD5M preset supplies them.", null, r.droppedKeys.join(", ")));
  }
  if (r.notCarried && r.notCarried.length) blocks.push(change("Not carried from the project", null, r.notCarried));
  if (r.overrides && r.overrides.length) blocks.push(settingsTable("Your choices, on top of the preset", r.overrides, true));
  if (r.replaced && r.replaced.length) blocks.push(settingsTable("The project's settings the preset replaced", r.replaced, false));
  if (!blocks.length) return;
  box.appendChild(el("h2", null, "What changed for the 5M"));
  for (const b of blocks) box.appendChild(b);
  box.classList.remove("hidden");
}

function stamp(kind, title, text) {
  const d = el("div", "stamp " + kind);
  d.appendChild(el("span", "mark", kind === "ok" ? "✓" : "✗"));
  const t = el("div");
  t.appendChild(el("b", null, title));
  t.appendChild(el("span", null, text));
  d.appendChild(t);
  return d;
}
function shortTime(t) {
  return String(t || "—").replace(/^(\d+h)\s*(\d+m)\s*\d+s$/, "$1 $2").replace(/^(\d+m)\s*\d+s$/, "$1");
}
function readouts(f) {
  const d = el("div", "readouts");
  const add = (k, v, unit) => {
    const c = el("div", "ro");
    c.appendChild(el("span", "k", k));
    const value = el("span", "v", v);
    if (unit) value.appendChild(el("small", null, unit));
    c.appendChild(value);
    d.appendChild(c);
  };
  const mm = Number(f.filamentMm);
  add("Filament", isFinite(mm) ? (mm / 1000).toFixed(2) : String(f.filamentMm), isFinite(mm) ? "m" : "mm");
  add("Print time", shortTime(f.timeEstimate));
  add("Layers", String(f.layers));
  add("Nozzle", String(f.nozzleC), "°C");
  add("Bed", String(f.bedC), "°C");
  return d;
}
function renderVerdict(r) {
  const box = $("#verdict");
  box.textContent = "";
  if (!r.checks || !r.checks.length) {
    box.appendChild(stamp("bad", "The slicer stopped", r.advice || r.errorString || "No plate was written."));
    if (r.meshRetry) {
      const retry = el("button", "ghost", "Retry from the mesh alone");
      retry.type = "button";
      retry.onclick = () => slice(true);
      box.appendChild(retry);
      box.appendChild(el("p", "fine", "An object made of several parts comes out as one piece; per-object settings, modifiers, " +
        "painted supports and layer changes are not carried, and the log names what was lost."));
    }
    return;
  }
  const lines = [];
  for (const c of r.checks) for (const l of c.lines) lines.push(l);
  const failed = r.checks.some((c) => c.code === 2);
  const passed = lines.filter((l) => l.state === "ok").length;
  box.appendChild(failed
    ? stamp("bad", "Do not print this", lines.filter((l) => l.state === "bad").length + " check(s) failed — nothing was saved")
    : stamp("ok", "Fit to print", "Sliced for the Adventurer 5M 0.4 · " + passed + " checks passed"));
  r.checks.forEach((c, n) => {
    if (r.checks.length > 1) box.appendChild(el("h3", null, "Plate " + (n + 1)));
    box.appendChild(readouts(c.facts));
  });
  if (failed) for (const l of lines) if (l.state !== "ok") box.appendChild(flag(l.state, l.text));
  for (const w of r.slicerWarnings || []) box.appendChild(flag("warn", "Flash Studio warns: " + w));
  if (r.delivered) {
    const act = el("div", "act");
    const open = el("button", "ignite", "Open in Flash Studio");
    open.type = "button";
    open.onclick = () => openProject(r.project3mf, open);
    act.appendChild(open);
    box.appendChild(act);
    box.appendChild(el("p", "fine", "Slice and print from there. Saved as " + r.project3mf));
  } else if (!failed) {
    box.appendChild(flag("bad", r.advice || "Nothing was saved."));
  }
  const all = el("details", "checks");
  all.appendChild(el("summary", null, "Every check (" + lines.length + ")"));
  const list = el("div");
  for (const l of lines) list.appendChild(flag(l.state, l.text));
  all.appendChild(list);
  box.appendChild(all);
}

function label(x, y, text, anchor, cls) {
  const t = svg("text", { x: x, y: y, "text-anchor": anchor, class: "lbl" + (cls ? " " + cls : "") });
  t.textContent = text;
  return t;
}
function drawPlate(map, reveal) {
  const box = $("#plate");
  box.textContent = "";
  const min = map ? map.bed.min : -110, max = map ? map.bed.max : 110, span = max - min, pad = 9;
  const root = svg("svg", { viewBox: (min - pad) + " " + (min - pad) + " " + (span + 2 * pad) + " " + (span + 2 * pad),
    class: "bed", role: "img", "aria-label": map ? "The first layer on the bed" : "The empty bed" });
  const defs = svg("defs", {});
  const glow = svg("filter", { id: "glow", x: "-5%", y: "-5%", width: "110%", height: "110%" });
  glow.appendChild(svg("feGaussianBlur", { stdDeviation: "1.1", result: "soft" }));
  const merge = svg("feMerge", {});
  merge.appendChild(svg("feMergeNode", { in: "soft" }));
  merge.appendChild(svg("feMergeNode", { in: "SourceGraphic" }));
  glow.appendChild(merge);
  defs.appendChild(glow);
  root.appendChild(defs);
  root.appendChild(svg("rect", { x: min, y: min, width: span, height: span, rx: 3, class: "sheet" }));
  for (let v = min + 10; v < max; v += 10) {
    const cls = Math.round(v) % 50 === 0 ? "grid major" : "grid";
    root.appendChild(svg("line", { x1: v, y1: min, x2: v, y2: max, class: cls }));
    root.appendChild(svg("line", { x1: min, y1: v, x2: max, y2: v, class: cls }));
  }
  root.appendChild(label(min, max + 6.5, String(min), "start"));
  root.appendChild(label(0, max + 6.5, span + " mm", "middle"));
  root.appendChild(label(max, max + 6.5, String(max), "end"));
  box.appendChild(root);
  if (!map) {
    root.appendChild(label(0, 2, "The first layer lands here after a slice", "middle", "empty"));
    $("#plate-meta").textContent = span + " × " + span + " mm";
    return;
  }
  const line = (points) => svg("path", { d: "M" + points.map((p) => p[0].toFixed(2) + "," + (-p[1]).toFixed(2)).join("L") });
  const purge = svg("g", { class: "purge" });
  for (const p of map.purge) purge.appendChild(line(p));
  root.appendChild(purge);
  const path = svg("g", { class: "toolpath" + (reveal ? " reveal" : ""), filter: "url(#glow)" });
  for (const p of map.paths) path.appendChild(line(p));
  root.appendChild(path);
  const f = map.footprint;
  if (reveal && f) {
    const scan = svg("rect", { x: f.minX - 0.4, y: -f.maxY - 3, width: 0.8, height: f.maxY - f.minY + 6, class: "scan", rx: 0.4 });
    scan.style.setProperty("--run", (f.maxX - f.minX) + "px");
    root.appendChild(scan);
  }
  $("#plate-meta").textContent = f
    ? (f.maxX - f.minX).toFixed(1) + " × " + (f.maxY - f.minY).toFixed(1) + " mm" +
      (map.clearance !== null ? " · " + map.clearance.toFixed(1) + " mm to the edge" : "") + (map.truncated ? " · drawing cut short" : "")
    : span + " × " + span + " mm";
}

async function openProject(path, button) {
  button.disabled = true;
  button.textContent = "Opening…";
  let r;
  try { r = await api("/api/open", { path: path }); } catch (err) { r = { ok: false, error: String(err.message || err) }; }
  button.disabled = false;
  button.textContent = r.ok ? "Opened — open again" : "Open in Flash Studio";
  if (!r.ok) button.parentElement.after(flag("bad", r.error || "Flash Studio did not start"));
}

function setupDrop() {
  const zone = $("#drop"), input = $("#pick"), text = $("#drop-text");
  const send = async (file) => {
    if (!file) return;
    text.textContent = "Saving " + file.name + "…";
    let saved = null;
    try {
      const response = await fetch("/api/upload", {
        method: "POST", headers: { "x-filename": encodeURIComponent(file.name) }, body: await file.arrayBuffer() });
      if (response.ok) saved = (await response.json()).saved;
    } finally {
      text.textContent = "Drop a model here, or browse";
    }
    await loadState();
    if (saved) {
      const name = saved.split("/").pop();
      const button = $$("#files button").filter((b) => b.title === name)[0];
      choose(saved, name, button);
    }
  };
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); send(e.dataTransfer.files[0]); });
  input.addEventListener("change", () => { const file = input.files[0]; input.value = ""; send(file); });
}

$("#slice").onclick = () => slice(false);
setupDrop();
drawPlate(null, false);
loadState();
setInterval(loadState, 20000);
`;

const GLYPH = `<svg class="glyph" viewBox="0 0 34 34" aria-hidden="true">
  <defs><linearGradient id="hot" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#FFB347"/><stop offset="1" stop-color="#FF6A1A"/></linearGradient></defs>
  <rect x="7.5" y="3.5" width="19" height="11" rx="2.6" fill="none" stroke="#97A6BA" stroke-width="1.6"/>
  <path d="M12.5 16h9l-2.9 7.6h-3.2z" fill="url(#hot)"/>
  <circle cx="17" cy="25.4" r="1.7" fill="#FFFFFF"/>
  <path d="M4.5 30.2h25" stroke="#3DCBFF" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;

const DROP_ICON = `<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round"><path d="M10 13V3M6 7l4-4 4 4"/><path d="M3 12v3.5A1.5 1.5 0 0 0 4.5 17h11a1.5 1.5 0 0 0 1.5-1.5V12"/></svg>`;

function radios(name: string, choices: Array<[string, string, string]>, chosen: string): string {
  return choices.map(([value, big, small]) => {
    const id = `${name}-${value || "preset"}`.replace(/[^\w-]/g, "");
    return `<input type="radio" name="${name}" id="${id}" value="${value}"${value === chosen ? " checked" : ""}/>` +
      `<label for="${id}"><b>${big}</b><small>${small}</small></label>`;
  }).join("");
}

export function page(filaments: string[]): string {
  const options = filaments.map((f) => `<option${f === DEFAULT_FILAMENT ? " selected" : ""}>${f}</option>`).join("");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="dark"/>
<title>Bambu to Flashforge</title>
<style>${STYLE}</style></head>
<body>
<header class="bar">
  <div class="brand">${GLYPH}<div><h1>Bambu → Flashforge</h1><p>Bambu Studio projects, made ready for the Adventurer 5M</p></div></div>
  <div class="telemetry">
    <div class="gauge"><span class="k">Flash Studio</span><span class="v"><span class="dot" id="slicerdot"></span><span id="t-slicer">Reading…</span></span></div>
    <div class="gauge"><span class="k">Presets</span><span class="v" id="t-presets">—</span></div>
    <div class="gauge"><span class="k">Converted</span><span class="v" id="t-count">—</span></div>
    <div class="gauge wide"><span class="k">Last converted</span><span class="v" id="t-last">—</span></div>
  </div>
</header>
<main class="deck">
  <aside class="bay rail" aria-label="Models">
    <div class="bay-head"><h2>Models</h2><span class="count" id="count"></span></div>
    <ul class="files" id="files"></ul>
    <label class="drop" id="drop">${DROP_ICON}<span id="drop-text">Drop a model here, or browse</span>
      <input type="file" id="pick" accept=".3mf,.stl,.step,.stp,.obj,.gcode"/></label>
    <p class="next" id="next"></p>
  </aside>
  <section class="bay job" aria-label="The job">
    <div class="model" id="inspection"><p class="lede">Choose a model on the left, or drop one in.</p></div>
    <div class="bay-head"><h2>Slice settings</h2><span class="count">Flashforge's AD5M 0.4 presets</span></div>
    <form class="fields" onsubmit="return false">
      <div class="field span2"><label for="filament">Filament</label><select id="filament">${options}</select></div>
      <div class="field"><span class="label" id="process-label">Layer height</span>
        <div class="seg" role="radiogroup" aria-labelledby="process-label">${radios("process",
          [["0.12", "0.12", "fine"], ["0.20", "0.20", "standard"], ["0.24", "0.24", "draft"]], "0.20")}</div></div>
      <div class="field"><span class="label" id="brim-label">Brim</span>
        <div class="seg" role="radiogroup" aria-labelledby="brim-label">${radios("brim",
          [["", "None", "preset"], ["auto_brim", "Auto", "where needed"], ["outer_only", "Outer", "outside only"]], "")}</div></div>
      <div class="field"><label for="infill">Infill</label><input id="infill" type="text" placeholder="Preset (15%)"/></div>
      <div class="field"><label for="name">Output name</label><input id="name" type="text" placeholder="From the file"/></div>
    </form>
    <div class="launch">
      <button class="ignite" id="slice" type="button" disabled>Slice for the 5M</button>
      <p class="fine">Temperatures and speeds come from Flashforge's own presets — they are not on this page.</p>
    </div>
    <div class="run hidden" id="run" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Slicing">
      <div class="stages"><span>Prepare</span><span>Slice</span><span>Check</span><span>Save</span></div>
      <div class="readout">
        <span class="pct"><span id="run-pct">0</span><i>%</i></span>
        <span class="step"><b id="run-text">Starting</b><small id="run-plate"></small></span>
        <span class="clock" id="run-time">0:00</span>
      </div>
      <div class="track"><div class="fill" id="run-fill"><span class="head"></span></div></div>
      <div class="scale" aria-hidden="true"></div>
    </div>
    <details class="log hidden" id="logbox"><summary>Slicer log <span id="logcount"></span></summary><pre id="log"></pre></details>
    <div class="changes hidden" id="changes"></div>
  </section>
  <section class="bay proof" aria-label="The first layer">
    <div class="bay-head"><h2>First layer on the bed</h2><span class="count" id="plate-meta">220 × 220 mm</span></div>
    <div class="plate" id="plate"></div>
    <div class="verdict" id="verdict"></div>
  </section>
</main>
<script>${SCRIPT}</script>
</body></html>`;
}
