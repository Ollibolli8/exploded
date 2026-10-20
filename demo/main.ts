import "./style.css";
import { createExploded, type Exploded, type PartInfo, type Region, type Status } from "../src/core";
import { createCallouts } from "../src/callouts";
import { mm } from "../src/parts";
import { createSound } from "../src/sound";

const root = document.querySelector<HTMLElement>(".xp")!;
const run = root.querySelector<HTMLElement>(".xp-run")!;
const stage = root.querySelector<HTMLElement>(".xp-stage")!;
const side = root.querySelector<HTMLElement>(".xp-side")!;
const head = root.querySelector<HTMLElement>(".xp-head")!;
const list = root.querySelector<HTMLTableElement>(".xp-list")!;
const body = list.tBodies[0];
const statusEl = root.querySelector<HTMLElement>(".xp-status")!;
const soundBtn = root.querySelector<HTMLButtonElement>(".xp-button")!;
const load = root.querySelector<HTMLElement>(".xp-load i")!;
const svg = root.querySelector<SVGSVGElement>(".xp-callouts")!;
const now = root.querySelector<HTMLElement>(".xp-now")!;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const narrow = matchMedia("(max-width: 700px)");
const coarse = matchMedia("(pointer: coarse)").matches;
let still = reduced.matches, hidden = false;
const sound = createSound();
let soundOn = false;
let ex: Exploded | null = null;
let parts: PartInfo[] = [];
let state: Status | null = null;
let hot: string | null = null;
let progress = 0;
let whole: { name: string; size: [number, number, number] } | null = null;
const callouts = createCallouts(svg);

// The model sits in what the type leaves: right of the parts list on a wide screen, between the title and the bar on
// a phone (measured, so a longer line or a short phone still frames it clear of both). All apart, the title has
// faded on a phone, so the model gets the top too.
function region(w: number, h: number, apart: 0 | 1): Region {
  const c = stage.getBoundingClientRect();
  const y = (px: number) => 1 - (2 * (px - c.top)) / h, x = (px: number) => -1 + (2 * (px - c.left)) / w;
  if (narrow.matches) {
    const top = apart ? 76 : head.getBoundingClientRect().bottom - c.top + 16;
    return { x0: -0.9, x1: 0.9, y0: y(now.getBoundingClientRect().top - 24), y1: y(c.top + top) };
  }
  const right = side.getBoundingClientRect().right;
  return apart ? { x0: x(right + 48), x1: 0.94, y0: -0.86, y1: 0.86 } : { x0: x(right + 64), x1: 0.9, y0: -0.6, y1: 0.6 };
}

function rows(w: { name: string; size: [number, number, number] }) {
  whole = w;
  body.replaceChildren();
  const tr = (cells: (string | Node)[], cls = "") => {
    const r = document.createElement("tr");
    if (cls) r.className = cls;
    cells.forEach((c, i) => {
      const td = document.createElement(i === 1 ? "th" : "td");
      if (i === 1) td.setAttribute("scope", "row");
      td.append(c);
      r.append(td);
    });
    body.append(r);
    return r;
  };
  tr(["—", w.name, "1", mm(w.size)], "xp-whole");
  for (const p of parts) {
    const name = p.fixed ? document.createTextNode(p.name) : Object.assign(document.createElement("button"), { type: "button", textContent: p.name });
    const n = document.createElement("span");
    n.className = "xp-n";
    n.textContent = p.n;
    const r = tr([n, name, String(p.count), mm(p.size)]);
    r.dataset.part = p.id;
    if (!p.fixed) {
      const b = name as HTMLButtonElement;
      b.addEventListener("click", () => ex?.toggle(p.id));
      b.setAttribute("aria-pressed", "false");
      r.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") ex?.hot(p.id); });
      r.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") ex?.hot(null); });
      b.addEventListener("focus", () => ex?.hot(p.id));
      b.addEventListener("blur", () => ex?.hot(null));
    }
  }
  show();
}

function show() {
  const steps = Math.max(...parts.map(p => p.step), 1);
  const current = Math.min(steps, Math.ceil(progress * steps - 0.15));
  for (const r of body.querySelectorAll<HTMLTableRowElement>("tr[data-part]")) {
    const p = parts.find(x => x.id === r.dataset.part)!;
    const out = state?.parts[p.id] ?? 0;
    if (out) r.dataset.out = out === p.count ? "all" : "some"; else delete r.dataset.out;
    r.querySelector("button")?.setAttribute("aria-pressed", out === 0 ? "false" : out === p.count ? "true" : "mixed");
    r.toggleAttribute("data-hot", hot === p.id);
    if (p.step && p.step === current) r.setAttribute("aria-current", "step"); else r.removeAttribute("aria-current");
  }
  // a phone has the list after the run, so the stage shows its row for the part in hand, or the one coming off now
  const p = parts.find(x => x.id === hot) ?? (progress > 0 ? parts.find(x => x.step === current) : undefined);
  const out = p ? state?.parts[p.id] ?? 0 : 0;
  if (p && out) now.dataset.out = out === p.count ? "all" : "some"; else delete now.dataset.out;
  now.replaceChildren(...[[p ? p.n : "—", "xp-n"], [p ? p.name : whole?.name ?? "", "xp-now-name"], [p && p.count > 1 ? `Qty ${p.count}` : "", "xp-qty"],
    [`${p ? mm(p.size) : whole ? mm(whole.size) : ""} mm`, ""]].map(([t, c]) => Object.assign(document.createElement("span"), { textContent: t, className: c })));
  if (state) statusEl.textContent = state.flying ? "Flying" : state.whole ? "Ready" : `${state.out} ${state.out === 1 ? "part" : "parts"} out${state.power ? "" : " · no power"}`;
}

function start(model: string, own: boolean) {
  ex?.dispose();
  callouts.clear();
  // a context once lost (dispose() ends it) can't come back: a new model gets a new canvas
  const old = root.querySelector<HTMLCanvasElement>(".xp-canvas")!;
  const canvas = own ? (old.cloneNode() as HTMLCanvasElement) : old;
  if (canvas !== old) old.replaceWith(canvas);
  root.dataset.gl = "loading";
  load.style.transform = "scaleX(0)";
  try {
    ex = createExploded({
      canvas, model, draco: "draco/", region, still,
      pixelRatio: Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2),
      onProgress: p => { load.style.transform = `scaleX(${p})`; },
      onReady: () => { root.dataset.gl = "on"; void document.fonts?.ready.then(() => ex?.refit()); ex?.apart(progress); },
      onFail: () => { root.dataset.gl = "off"; },
      onParts: (p, whole) => { parts = p; rows(whole); },
      onStatus: s => { state = s; show(); },
      onCallouts: c => callouts.update(c),
      onHot: id => { hot = id; show(); },
      onSeat: seated => sound.click(seated),
      onSpool: s => sound.spool(s),
    });
  } catch { root.dataset.gl = "off"; }
}
start(new URLSearchParams(location.search).get("model") ?? "terne.glb", false);
if (location.search.includes("debug")) Object.assign(window, { __ex: () => ex });

// the scroll takes it apart: the stage holds while the run passes under it
function onScroll() {
  const r = run.getBoundingClientRect();
  progress = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - innerHeight)));
  root.style.setProperty("--apart", progress.toFixed(4));
  ex?.apart(progress);
  show();
}
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// a phone keeps the drawing on the stage and the parts list after it
const after = Object.assign(document.createElement("section"), { className: "xp-after" });
run.after(after);
function place() {
  if (narrow.matches) after.prepend(list); else head.after(list);
  ex?.refit();
}
narrow.addEventListener("change", place);
place();

function showSound() {
  soundBtn.setAttribute("aria-pressed", String(soundOn));
  soundBtn.textContent = soundOn ? "Sound on" : "Sound off";
}
// the audio starts inside the tap itself: iOS Safari only lets a page make sound from a gesture
soundBtn.addEventListener("click", () => {
  soundOn = !soundOn;
  if (soundOn) sound.start(); else sound.stop();
  showSound();
});
reduced.addEventListener("change", e => { still = e.matches; ex?.setStill(still || hidden); });
new IntersectionObserver(([e]) => { hidden = !e.isIntersecting; ex?.setStill(still || hidden); }, { threshold: 0.02 }).observe(stage);
document.addEventListener("visibilitychange", () => { if (document.hidden && soundOn) { soundOn = false; sound.stop(); showSound(); } });

// drop a model of your own on the page
const drop = root.querySelector<HTMLElement>(".xp-drop")!;
addEventListener("dragover", e => { e.preventDefault(); drop.hidden = false; });
addEventListener("dragleave", e => { if (!e.relatedTarget) drop.hidden = true; });
addEventListener("drop", e => {
  e.preventDefault();
  drop.hidden = true;
  const file = [...(e.dataTransfer?.files ?? [])].find(f => /\.glb$/i.test(f.name));
  if (file) start(URL.createObjectURL(file), true);
});
showSound();
