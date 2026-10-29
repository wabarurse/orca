// MOCKUP-PICK (throwaway): a localhost gallery of the Ctrl+T task-list variants.
//   bun scripts/mockup-pick-tasks-web.ts [port]      → http://127.0.0.1:15174/
// Renders the real variant renderer over fixture tasks; ANSI SGR becomes HTML spans. Reads and writes nothing;
// ORCA_HOME is pointed at a fresh temp dir anyway. Click a pane, then ↑↓←→ PgUp/PgDn, or click a row.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ORCA_HOME = mkdtempSync(join(tmpdir(), "orca-mockup-web-"));
process.env.COLORTERM ??= "truecolor";
delete process.env.NO_COLOR;
const { renderTaskTreeVariant, variantNavigate, VARIANTS } = await import("../src/tui/components/task-tree-mockup");
const { SAMPLE, id } = await import("./mockup-pick-tasks-fixtures");
const { navigateOutline } = await import("../src/tui/components/task-tree");

const port = Number(process.argv[2]) || 15174;
const SIZES = [{ name: "wide", cols: 120, rows: 30 }, { name: "narrow", cols: 60, rows: 22 }] as const;
const PRESETS = [{ n: 8, why: "long name, blocked" }, { n: 3, why: "working, needs merged #1" }, { n: 6, why: "ready to merge" }, { n: 12, why: "waits on #3 and #5" }];
const EMPTY_ID = "__empty";

// ---- ANSI → HTML ----
const FG: Record<number, string> = {
  30: "#3b3f4a", 31: "#ff6b6b", 32: "#5fd38d", 33: "#f2c94c", 34: "#5aa9ff", 35: "#c792ea", 36: "#4fd6e0", 37: "#d8dee9",
  90: "#7a8190", 91: "#ff8787", 92: "#8ce99a", 93: "#ffe066", 94: "#74c0fc", 95: "#e599f7", 96: "#66d9e8", 97: "#ffffff",
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function ansiHtml(line: string): string {
  let out = "", bold = false, dim = false, under = false, rev = false, fg = "", open = false, link = "";
  const style = () => {
    const css: string[] = [];
    if (rev) css.push(`background:${fg || "#d8dee9"};color:#0d1117`); else if (fg) css.push(`color:${fg}`);
    if (bold) css.push("font-weight:700"); if (dim) css.push("opacity:.55"); if (under) css.push("text-decoration:underline");
    return css.join(";");
  };
  const flush = () => { if (open) { out += "</span>"; open = false; } const css = style(); if (css) { out += `<span style="${css}">`; open = true; } };
  const re = /\x1b\[([0-9;:]*)m|\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)|([^\x1b]+)|\x1b/g;
  for (let m; (m = re.exec(line));) {
    if (m[1] !== undefined) {
      const ps = m[1] === "" ? [0] : m[1].split(/[;:]/).map(Number);
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]!;
        if (p === 0) { bold = dim = under = rev = false; fg = ""; }
        else if (p === 1) bold = true; else if (p === 2) dim = true; else if (p === 22) bold = dim = false;
        else if (p === 4) under = true; else if (p === 24) under = false; else if (p === 7) rev = true; else if (p === 27) rev = false;
        else if (FG[p]) fg = FG[p]!; else if (p === 39) fg = "";
        else if (p === 38 && ps[i + 1] === 5) { fg = `var(--c${ps[i + 2]})`; i += 2; }
        else if (p === 38 && ps[i + 1] === 2) { fg = `rgb(${ps[i + 2]},${ps[i + 3]},${ps[i + 4]})`; i += 4; }
      }
      flush();
    } else if (m[2] !== undefined) {
      if (open) { out += "</span>"; open = false; }
      if (link) out += "</a>";
      link = m[2];
      if (link) out += `<a href="${esc(link)}" target="_blank" rel="noreferrer">`;
      flush();
    } else if (m[3] !== undefined) out += esc(m[3]);
  }
  if (open) out += "</span>";
  if (link) out += "</a>";
  return out;
}

// ---- rendering ----
interface Pane { html: string; selectedId?: string; hits: { id: string; row: number; col: number; width: number }[]; state: State }
interface State { variant: number; selectedId?: string; graphY: number; detailY: number; collapsed: string[] }
function render(state: State, cols: number, rows: number, tasks = SAMPLE): Pane {
  const view = { ...state, collapsed: new Set(state.collapsed), revealSelected: true };
  const out = renderTaskTreeVariant(tasks, { ...view, cols, rows, frame: 1 });
  const html = out.lines.map(line => `<div class="l">${ansiHtml(line) || " "}</div>`).join("");
  return { html, selectedId: out.selectedId, hits: out.hits.map(({ id, row, col, width }) => ({ id, row, col, width })),
    state: { ...state, selectedId: out.selectedId, graphY: out.graph.y, detailY: out.details.y } };
}
function step(state: State, key: string, cols: number, rows: number, tasks = SAMPLE): Pane {
  const first = renderTaskTreeVariant(tasks, { ...state, collapsed: new Set(state.collapsed), cols, rows, frame: 1, revealSelected: true });
  const view = { ...state, selectedId: first.selectedId, graphY: first.graph.y, detailY: first.details.y, collapsed: new Set(state.collapsed), revealSelected: false };
  if (!variantNavigate(view, first, { name: key })) {
    // Variant 0: today's outline navigation, as App.scrollTaskTree does.
    if (["up", "down", "left", "right"].includes(key)) { view.selectedId = navigateOutline(first.nodes, view.selectedId, view.collapsed, key); view.revealSelected = true; }
    else if (key === "pageup" || key === "pagedown") view.detailY += (key === "pageup" ? -1 : 1) * Math.max(1, first.details.rows - 1);
  }
  const next = { variant: state.variant, selectedId: view.selectedId, graphY: view.graphY, detailY: view.detailY, collapsed: [...view.collapsed] };
  const out = renderTaskTreeVariant(tasks, { ...next, collapsed: view.collapsed, cols, rows, frame: 1, revealSelected: view.revealSelected });
  return { html: out.lines.map(line => `<div class="l">${ansiHtml(line) || " "}</div>`).join(""), selectedId: out.selectedId,
    hits: out.hits.map(({ id, row, col, width }) => ({ id, row, col, width })),
    state: { ...next, selectedId: out.selectedId, graphY: out.graph.y, detailY: out.details.y } };
}

const variants = [...VARIANTS.map((v, k) => ({ n: k + 1, letter: v.letter, name: v.name, idea: v.idea })),
  { n: 0, letter: "0", name: "Current", idea: "today's outline, for comparison" }];

function paneHtml(n: number, size: { name: string; cols: number; rows: number }, sel: string | undefined, empty = false): string {
  const state: State = { variant: n, selectedId: sel, graphY: 0, detailY: 0, collapsed: [] };
  const pane = render(state, size.cols, size.rows, empty ? [] : SAMPLE);
  return `<figure><figcaption>${size.name} ${size.cols}×${size.rows}${empty ? " · empty list" : ""}</figcaption>
<pre class="term" tabindex="0" data-cols="${size.cols}" data-rows="${size.rows}" data-empty="${empty ? 1 : 0}"
 data-state='${esc(JSON.stringify(pane.state))}' data-hits='${esc(JSON.stringify(pane.hits))}'>${pane.html}</pre></figure>`;
}

function page(): string {
  const pills = variants.map(v => `<a class="pill" href="#v${v.letter}" title="${esc(v.name)}">${v.letter}</a>`).join("");
  const sections = variants.map(v => `<section id="v${v.letter}" data-variant="${v.n}">
<h2><span class="letter">${v.letter}</span> ${esc(v.name)}</h2><p class="blurb">${esc(v.idea)}</p>
<div class="presets">select: ${PRESETS.map(p => `<button data-sel="${id(p.n)}">#${p.n} <small>${esc(p.why)}</small></button>`).join("")}</div>
<div class="panes">${paneHtml(v.n, SIZES[0], id(8))}${paneHtml(v.n, SIZES[1], id(3))}</div>
<details><summary>empty list</summary>${paneHtml(v.n, { name: "", cols: 80, rows: 8 }, undefined, true)}</details>
</section>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>mockup-pick · Ctrl+T task list</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:dark}
body{margin:0;background:#0b0e13;color:#c9d1d9;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
nav{position:fixed;top:12px;left:12px;display:flex;gap:6px;z-index:9;background:#0b0e13cc;padding:6px;border-radius:10px;backdrop-filter:blur(6px)}
.pill{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:999px;background:#1c222c;color:#e6edf3;text-decoration:none;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.pill:hover,.pill.on{background:#4fd6e0;color:#0b0e13}
main{padding:72px 28px 120px}
header p{color:#8b949e;max-width:900px}
section{margin:0 0 96px;scroll-margin-top:64px}
h2{margin:0;font-size:22px}.letter{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#4fd6e0;color:#0b0e13;margin-right:6px}
.blurb{margin:4px 0 10px;color:#8b949e}
.presets{margin:0 0 12px;color:#8b949e;font-size:12px}.presets button{background:#1c222c;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;margin:0 4px 4px 0;padding:3px 8px;cursor:pointer}
.presets small{color:#8b949e}
.panes{display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
figure{margin:0}figcaption{font-size:12px;color:#6e7681;margin:0 0 4px;font-family:ui-monospace,Menlo,monospace}
pre.term{margin:0;padding:10px 12px;background:#0d1117;border:1px solid #262c36;border-radius:8px;box-shadow:0 10px 30px #0008;
 font:13px/1.3 "SF Mono",ui-monospace,Menlo,Consolas,monospace;color:#d8dee9;white-space:pre;cursor:pointer;outline:none;position:relative}
pre.term:focus{border-color:#4fd6e0}
pre.term .l{height:1.3em;overflow:hidden}
pre.term a{color:inherit}
details{margin-top:10px;color:#8b949e}summary{cursor:pointer;font-size:12px}
.hint{position:fixed;right:14px;bottom:12px;color:#6e7681;font-size:12px}
</style></head><body>
<nav>${pills}</nav>
<main><header><h1>Ctrl+T task list · pick one</h1>
<p>Each pane is the real orca renderer over the same sample tasks (every status and attention kind, a long name, a missing PR, a closed PR, ready to merge and a dependency chain), drawn at 120×30 and 60×22. Click a pane, then use ↑ ↓ ← → PgUp PgDn, or click a row. In the TUI: Ctrl+T, then keys 1–8 (0 is today's view).</p></header>
${sections}</main><div class="hint">click a pane · ↑↓←→ PgUp/PgDn · Home/End</div>
<script>
const KEYS={ArrowUp:"up",ArrowDown:"down",ArrowLeft:"left",ArrowRight:"right",PageUp:"pageup",PageDown:"pagedown",Home:"home",End:"end"};
async function call(pre,body){
  const r=await fetch("/step",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,cols:+pre.dataset.cols,rows:+pre.dataset.rows,empty:pre.dataset.empty==="1"})});
  const p=await r.json(); pre.innerHTML=p.html; pre.dataset.state=JSON.stringify(p.state); pre.dataset.hits=JSON.stringify(p.hits);
}
document.querySelectorAll("pre.term").forEach(pre=>{
  pre.addEventListener("keydown",e=>{const k=KEYS[e.key]; if(!k) return; e.preventDefault(); call(pre,{state:JSON.parse(pre.dataset.state),key:k});});
  pre.addEventListener("click",e=>{
    if(e.target.closest("a")) return;
    const lines=pre.querySelectorAll(".l"); const first=lines[0].getBoundingClientRect();
    const row=Math.floor((e.clientY-first.top)/first.height);
    const probe=document.createElement("span"); probe.textContent="M".repeat(10); pre.appendChild(probe);
    const cw=probe.getBoundingClientRect().width/10; probe.remove();
    const col=Math.floor((e.clientX-first.left)/cw);
    const hit=JSON.parse(pre.dataset.hits).find(h=>h.row===row&&col>=h.col&&col<h.col+h.width);
    if(hit){const s=JSON.parse(pre.dataset.state); s.selectedId=hit.id; s.detailY=0; call(pre,{state:s});}
  });
});
document.querySelectorAll(".presets button").forEach(b=>b.addEventListener("click",()=>{
  b.closest("section").querySelectorAll(".panes pre.term").forEach(pre=>{const s=JSON.parse(pre.dataset.state); s.selectedId=b.dataset.sel; s.detailY=0; s.graphY=0; call(pre,{state:s});});
}));
const pills=[...document.querySelectorAll(".pill")];
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){pills.forEach(p=>p.classList.toggle("on",p.getAttribute("href")==="#"+e.target.id));}}),{rootMargin:"-40% 0px -55% 0px"});
document.querySelectorAll("section").forEach(s=>io.observe(s));
</script></body></html>`;
}

const server = Bun.serve({
  hostname: "127.0.0.1", port,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/" || url.pathname === "/mockup-pick") return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/step" && req.method === "POST") {
        const body = await req.json() as { state: State; key?: string; cols: number; rows: number; empty?: boolean };
        const cols = Math.max(1, Math.min(240, Number(body.cols) || 120)), rows = Math.max(1, Math.min(80, Number(body.rows) || 30));
        const state: State = { variant: Number(body.state?.variant) || 0, selectedId: body.state?.selectedId === EMPTY_ID ? undefined : body.state?.selectedId,
          graphY: Number(body.state?.graphY) || 0, detailY: Number(body.state?.detailY) || 0, collapsed: Array.isArray(body.state?.collapsed) ? body.state.collapsed : [] };
        const tasks = body.empty ? [] : SAMPLE;
        return Response.json(body.key ? step(state, body.key, cols, rows, tasks) : render(state, cols, rows, tasks));
      }
      if (url.pathname === "/render") { // ?variant=1..8|0&sel=<task number>&cols=&rows=  → plain HTML pre
        const variant = Number(url.searchParams.get("variant") ?? 1), sel = Number(url.searchParams.get("sel") ?? 0);
        const pane = render({ variant, selectedId: sel ? id(sel) : undefined, graphY: 0, detailY: 0, collapsed: [] },
          Number(url.searchParams.get("cols")) || 120, Number(url.searchParams.get("rows")) || 30);
        return new Response(`<pre style="background:#0d1117;color:#d8dee9;font:13px/1.3 ui-monospace,monospace">${pane.html}</pre>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    } catch (error) { return new Response(`error: ${error instanceof Error ? error.stack : String(error)}`, { status: 500 }); }
  },
});
console.log(`mockup-pick task list: http://${server.hostname}:${server.port}/  (ORCA_HOME=${process.env.ORCA_HOME})`);
