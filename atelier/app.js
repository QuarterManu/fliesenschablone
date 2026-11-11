/* Fliesenatelier – Zeichenbrett, Werkzeuge, Eigenschaften. */
"use strict";

const C = Core;
const $ = (s, el = document) => el.querySelector(s);
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = v => (Math.round(v * 10) / 10).toLocaleString("de-DE");

const PALETTES = [
  { name: "Klassisch", colors: ["#ece8df", "#2e3033", "#8e9091", "#7a2e26", "#cbb791"] },
  { name: "Andalusien", colors: ["#f0ede5", "#1f4e8c", "#d2992e", "#3c6e47", "#8db3d6"] },
  { name: "Marrakesch", colors: ["#e6d9c2", "#b4532a", "#1e5e63", "#c9a13b", "#242424"] },
  { name: "Nordisch", colors: ["#eeeeeb", "#9faf97", "#d8a9a0", "#b8bab7", "#4a4d50"] },
  { name: "Lissabon", colors: ["#f2f0eb", "#2c5da9", "#16325c", "#e0b33a", "#a2a6aa"] },
];
const TYPE_NAMES = { mitte: "Mitte", rand: "Rand", ecke: "Ecke" };

const App = {
  tile: null,
  palette: 0,
  tool: "select",
  arr: null, arrDirty: true, arrTimer: 0,
  view: { cx: 100, cy: 100, scale: 3 },
  sel: [], selOp: "id",
  hist: { undo: [], redo: [] },
  opts: { snap: true, grid: 10, color: true, thick: false },
  to: { sides: 6, points: 8, ratio: 45, leafW: 45, circleMode: "kreis", rectCenter: false, stab: 12, offset: 3, offsetBoth: false,
        corner: false, slot: 1, repN: 8, repCenter: "mitte", repFull: true, repStep: 45, rowN: 4, rowDx: 20, rowDy: 0 },
  st: null,          // laufende Werkzeug-Aktion
  hover: null,
  keyCache: null,
  space: false,
  bgImg: null,       // Daten-URL der Vorlage
};

// ------------------------------------------------------------------ Werkzeuge (Definition)
const I = { // 24er-Icons
  select: '<path d="M5 3l14 8-6 1.5L10 19z"/>',
  line: '<path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.8"/><circle cx="20" cy="4" r="1.8"/>',
  curve: '<path d="M3 18c4-12 8 4 12-6s5-6 6-6"/><circle cx="3" cy="18" r="1.6"/><circle cx="12" cy="9" r="1.6"/><circle cx="21" cy="6" r="1.6"/>',
  brush: '<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  polygon: '<path d="M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"/>',
  leaf: '<path d="M12 3c5 4 5 14 0 18-5-4-5-14 0-18z"/>',
  arc: '<path d="M4 20A16 16 0 0 1 20 4"/><circle cx="4" cy="4" r="1.6"/><path d="M4 4l3 3" stroke-dasharray="2 2"/>',
  offset: '<path d="M4 18C8 8 16 8 20 18"/><path d="M4 13C8 3 16 3 20 13" stroke-dasharray="3 2"/>',
  merge: '<rect x="3" y="8" width="12" height="9"/><rect x="9" y="4" width="12" height="9"/><path d="M6 21l12-14" stroke-width="2.4"/>',
  cut: '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8 16L19 3M16 16L5 3"/>',
  fill: '<path d="M5 11l7-7 7 7-7 7z"/><path d="M20 15c0 2-1.2 3-2 3s-2-1-2-3 2-4 2-4 2 2 2 4z"/>',
};
const TOOLS = [
  { group: "Wählen" },
  { id: "select", name: "Auswählen", key: "v" },
  { group: "Zeichnen" },
  { id: "line", name: "Linie", key: "l" },
  { id: "curve", name: "Kurve", key: "k" },
  { id: "brush", name: "Pinsel", key: "p" },
  { group: "Formen" },
  { id: "rect", name: "Rechteck", key: "r" },
  { id: "circle", name: "Kreis", key: "c" },
  { id: "polygon", name: "Vieleck", key: "n" },
  { id: "star", name: "Stern", key: "s" },
  { id: "leaf", name: "Blatt", key: "b" },
  { id: "arc", name: "Bogen", key: "a" },
  { group: "Ändern" },
  { id: "offset", name: "Parallele", key: "o" },
  { id: "merge", name: "Flächen verbinden", key: "m" },
  { id: "cut", name: "Stück löschen", key: "x" },
  { id: "fill", name: "Färben", key: "f" },
];

const HINTS = {
  select: "<b>Auswählen:</b> Form anklicken, dann ziehen zum Verschieben. Ecken des Rahmens = Größe, runder Griff = drehen. Punkte ziehen = Form ändern, Doppelklick auf Punkt = rund/eckig, Doppelklick auf Linie = Punkt einfügen. Leere Fläche ziehen = Ansicht verschieben.",
  line: "<b>Linie:</b> Anfang anklicken und bis zum Ende ziehen – oder zweimal klicken. <span class='kbd'>Umschalt</span> = in 15°-Schritten.",
  curve: "<b>Kurve:</b> Punkt für Punkt anklicken. Ersten Punkt anklicken = schließen. Doppelklick oder <span class='kbd'>Enter</span> = fertig, <span class='kbd'>Rücktaste</span> = letzten Punkt weg.",
  brush: "<b>Pinsel:</b> Frei zeichnen. Danach lässt sich die Linie mit einem Regler glätten.",
  rect: "<b>Rechteck:</b> Von Ecke zu Ecke ziehen. Einfach klicken = 40-mm-Quadrat. <span class='kbd'>Umschalt</span> = Quadrat.",
  circle: "<b>Kreis:</b> In der Mitte ansetzen und nach außen ziehen. Einfach klicken = Kreis mit 20 mm Radius.",
  polygon: "<b>Vieleck:</b> In der Mitte ansetzen und zu einer Ecke ziehen. Eckenzahl rechts einstellen.",
  star: "<b>Stern:</b> In der Mitte ansetzen und zu einer Spitze ziehen. Zacken und Tiefe rechts einstellen.",
  leaf: "<b>Blatt:</b> Von einer Spitze zur anderen ziehen. Breite rechts einstellen.",
  arc: "<b>Bogen:</b> 1. Mittelpunkt klicken (z. B. eine Fliesenecke), 2. Anfang des Bogens klicken, 3. bis zum Ende fahren und klicken.",
  offset: "<b>Parallele:</b> Linie oder Form anklicken – auf der Seite, wo die neue Linie hin soll. Abstand rechts einstellen.",
  merge: "<b>Flächen verbinden:</b> In eine Fläche klicken und mit gedrückter Maustaste in die Nachbarfläche(n) ziehen. Die Linien dazwischen verschwinden.",
  cut: "<b>Stück löschen:</b> Ein Linienstück zwischen zwei Kreuzungen anklicken – oder mit gedrückter Maustaste über mehrere Stücke fahren.",
  fill: "<b>Färben:</b> Farbe rechts wählen und in eine Fläche klicken. Die Farben zeigen nur, wie die Fliese später wirkt.",
};

// ------------------------------------------------------------------ Fliese
function newTile(type = "mitte", name) {
  return { id: C.uid("t"), name: name || "Neue Fliese", type, size: 200, sym: "none", shapes: [], erasers: [], fills: [],
    bg: null, bgOpacity: 0.5, bgShow: true, created: Date.now(), updated: Date.now() };
}
function sampleTile() {
  // Beispiel: Viertelrosette mit Diagonalspiegelung, ähnlich klassischer Eckmotive
  const t = newTile("mitte", "Beispiel – Viertelrosette");
  t.sym = "d1";
  const S = 200, sh = [];
  const arc = (r) => ({ id: C.uid(), t: "arc", cx: S, cy: S, r, a0: Math.PI, a1: 1.5 * Math.PI });
  [42, 50, 112, 120, 176].forEach(r => sh.push(arc(r)));
  for (let k = 0; k < 3; k++) {
    const a = Math.PI + (k + 0.5) * (Math.PI / 2) / 6;
    sh.push({ id: C.uid(), t: "ellipse", cx: S + 81 * Math.cos(a), cy: S + 81 * Math.sin(a), rx: 9, ry: 9, rot: 0 });
  }
  const l = C.leaf([18, 18], [70, 70], 52); l.id = C.uid(); sh.push(l);
  sh.push({ id: C.uid(), t: "ellipse", cx: S, cy: S, rx: 22, ry: 22, rot: 0 });
  t.shapes = sh;
  const at = (r, deg) => ({ x: C.r3(S + r * Math.cos(deg * Math.PI / 180)), y: C.r3(S + r * Math.sin(deg * Math.PI / 180)) });
  t.fills = [{ x: 44, y: 44, slot: 3 }, { ...at(150, 190), slot: 4 }, { ...at(116, 225), slot: 1 }, { ...at(46, 225), slot: 1 }, { ...at(8, 225), slot: 3 }];
  for (let k = 0; k < 3; k++) t.fills.push({ ...at(81, 180 + (k + 0.5) * 15), slot: 3 });
  t.sample = true;
  return t;
}

// ------------------------------------------------------------------ SVG-Aufbau
const svg = $("#canvas");
const L = {};
function buildCanvas() {
  svg.innerHTML = "";
  L.outside = svgEl("rect", { fill: "var(--bg)" }, svg);
  L.bg = svgEl("g", {}, svg);
  L.paper = svgEl("rect", { x: 0, y: 0, fill: "var(--paper)", stroke: "none" }, svg);
  L.bgimg = svgEl("image", { x: 0, y: 0, preserveAspectRatio: "none" }, svg);
  L.faces = svgEl("g", {}, svg);
  L.grid = svgEl("path", { fill: "none", stroke: "#8a8f96", "stroke-opacity": .28, "vector-effect": "non-scaling-stroke", "stroke-width": 1 }, svg);
  L.axes = svgEl("g", { fill: "none", stroke: "var(--accent)", "stroke-dasharray": "6 5", "vector-effect": "non-scaling-stroke", "stroke-width": 1.4, "stroke-opacity": .8 }, svg);
  L.type = svgEl("g", {}, svg);
  L.lines = svgEl("path", { fill: "none", stroke: "var(--ink)", "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
  L.frame = svgEl("rect", { x: 0, y: 0, fill: "none", stroke: "var(--ink)", "vector-effect": "non-scaling-stroke", "stroke-width": 2 }, svg);
  L.over = svgEl("g", {}, svg);
}

function canvasSize() { const r = svg.getBoundingClientRect(); return [Math.max(r.width, 10), Math.max(r.height, 10)]; }
function applyView() {
  const [w, h] = canvasSize(), v = App.view;
  const vw = w / v.scale, vh = h / v.scale;
  svg.setAttribute("viewBox", `${v.cx - vw / 2} ${v.cy - vh / 2} ${vw} ${vh}`);
  L.outside.setAttribute("x", v.cx - vw); L.outside.setAttribute("y", v.cy - vh);
  L.outside.setAttribute("width", vw * 2); L.outside.setAttribute("height", vh * 2);
  renderOverlay();
}
function fitView() {
  const [w, h] = canvasSize(), S = App.tile.size, m = 40;
  App.view.scale = Math.min((w - m * 2) / S, (h - m * 2) / S);
  App.view.cx = S / 2; App.view.cy = S / 2 + 4;
  applyView();
}
function zoomAt(f, px, py) {
  const v = App.view;
  const p = px === undefined ? [v.cx, v.cy] : toMM({ clientX: px, clientY: py });
  const ns = C.clamp(v.scale * f, 0.4, 80);
  const k = v.scale / ns;
  v.cx = p[0] + (v.cx - p[0]) * k; v.cy = p[1] + (v.cy - p[1]) * k; v.scale = ns;
  applyView();
}
function toMM(e) {
  const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
  const m = svg.getScreenCTM();
  if (!m) return [0, 0];
  const q = pt.matrixTransform(m.inverse());
  return [q.x, q.y];
}
const px = n => n / App.view.scale; // Bildschirmpixel -> mm

// ------------------------------------------------------------------ Darstellung
function allImages(s) {
  const t = App.tile;
  return C.GROUPS[t.sym].ops.map(op => ({ op, s: C.shapeImage(s, op, t.size) }));
}
// Zwischenspeicher für Polylinien der Spiegelbilder (wird bei jeder Änderung geleert)
let flatCache = new WeakMap();
function imagePolys(s) {
  let m = flatCache.get(s);
  if (!m) { m = []; for (const im of allImages(s)) m.push({ op: im.op, pls: C.flatten(im.s, 0.8) }); flatCache.set(s, m); }
  return m;
}
function renderAll() {
  const t = App.tile, S = t.size;
  L.paper.setAttribute("width", S); L.paper.setAttribute("height", S);
  L.frame.setAttribute("width", S); L.frame.setAttribute("height", S);
  L.paper.setAttribute("fill", App.opts.color ? PALETTES[App.palette].colors[0] : "var(--paper)");
  // Vorlage
  if (App.bgImg && t.bgShow) {
    L.bgimg.setAttribute("href", App.bgImg);
    L.bgimg.setAttribute("width", S); L.bgimg.setAttribute("height", S);
    L.bgimg.setAttribute("opacity", t.bgOpacity);
    L.bgimg.removeAttribute("display");
  } else L.bgimg.setAttribute("display", "none");
  // Raster
  const g = App.opts.grid;
  let d = "";
  if (g > 0) for (let x = g; x < S - 1e-6; x += g) d += `M${x} 0V${S}M0 ${x}H${S}`;
  L.grid.setAttribute("d", d);
  // Achsen
  L.axes.innerHTML = "";
  for (const [a, b] of C.groupAxes(t.sym, S)) svgEl("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, L.axes);
  // Art der Fliese markieren
  L.type.innerHTML = "";
  const mark = (x1, y1, x2, y2) => svgEl("line", { x1, y1, x2, y2, stroke: "var(--accent)", "stroke-width": 3.2, "stroke-linecap": "round" }, L.type);
  const label = (x, y, txt, rot = 0) => { const e = svgEl("text", { x, y, "font-size": 5, fill: "var(--accent)", "font-family": "Barlow Condensed, sans-serif", "font-weight": 600, "text-anchor": "middle", transform: rot ? `rotate(${rot} ${x} ${y})` : "" }, L.type); e.textContent = txt; };
  if (t.type === "rand" || t.type === "ecke") { mark(0, S + 4, S, S + 4); label(S / 2, S + 11, "Außenkante der Fläche"); }
  if (t.type === "ecke") { mark(-4, 0, -4, S); label(-9, S / 2, "Außenkante der Fläche", -90); }
  renderFaces();
  renderLines();
  renderOverlay();
}
function renderFaces() {
  L.faces.innerHTML = "";
  if (!App.opts.color || !App.arr || App.arrDirty) return;
  const pal = PALETTES[App.palette].colors;
  const bySlot = {};
  for (const f of App.arr.faces) if (f.slot) (bySlot[f.slot] = bySlot[f.slot] || []).push(C.faceD(f));
  for (const k in bySlot) svgEl("path", { d: bySlot[k].join(""), fill: pal[k], "fill-rule": "evenodd", opacity: App.bgImg && App.tile.bgShow ? .75 : 1 }, L.faces);
}
function renderLines() {
  let d = "";
  if (App.arr && !App.arrDirty) d = App.arr.pieces.filter(p => !p.frame).map(p => C.ptsToD(p.pts)).join("");
  else d = C.tilePolylines(App.tile).map(pl => C.ptsToD(pl)).join("");
  L.lines.setAttribute("d", d);
  if (App.opts.thick) { L.lines.removeAttribute("vector-effect"); L.lines.setAttribute("stroke-width", 1); L.frame.setAttribute("stroke-width", 2); }
  else { L.lines.setAttribute("vector-effect", "non-scaling-stroke"); L.lines.setAttribute("stroke-width", 2); }
}

// Überlagerung: Auswahl, Vorschau, Einrastpunkt
function renderOverlay() {
  if (!L.over) return;
  L.over.innerHTML = "";
  const t = App.tile;
  if (!t) return;
  const sw = { "vector-effect": "non-scaling-stroke" };
  const drawShape = (s, attrs) => {
    for (const im of imagePolys(s)) for (const pl of im.pls)
      svgEl("path", { d: C.ptsToD(pl), fill: "none", ...sw, ...attrs }, L.over);
  };
  // Hervorhebung beim Überfahren
  const h = App.hover;
  if (h) {
    if (h.kind === "face") svgEl("path", { d: C.faceD(h.face), fill: h.color || "var(--sel)", "fill-opacity": h.color ? .9 : .22, "fill-rule": "evenodd", stroke: "var(--sel)", "stroke-width": 1.5, ...sw }, L.over);
    if (h.kind === "piece") svgEl("path", { d: C.ptsToD(h.piece.pts), fill: "none", stroke: "var(--danger)", "stroke-width": 6, "stroke-linecap": "round", "stroke-opacity": .8, ...sw }, L.over);
    if (h.kind === "shape") drawShape(h.shape, { stroke: "var(--sel)", "stroke-width": 4, "stroke-opacity": .55 });
  }
  // Auswahl
  const sel = selectedShapes();
  for (const s of sel) drawShape(s, { stroke: "var(--sel)", "stroke-width": 3 });
  if (App.tool === "select" && sel.length) drawHandles(sel);
  // Laufende Aktion
  const st = App.st;
  if (st && st.preview) {
    for (const s of [].concat(st.preview)) drawShape(s, { stroke: "var(--accent)", "stroke-width": 2.5, "stroke-dasharray": st.dash ? "5 4" : "" });
  }
  if (st && st.touched) for (const f of st.touched) svgEl("path", { d: C.faceD(f), fill: "var(--accent)", "fill-opacity": .35, "fill-rule": "evenodd", ...sw }, L.over);
  if (st && st.points) for (const p of st.points) svgEl("circle", { cx: p[0], cy: p[1], r: px(4), fill: "var(--paper)", stroke: "var(--accent)", "stroke-width": 2, ...sw }, L.over);
  if (st && st.center) svgEl("circle", { cx: st.center[0], cy: st.center[1], r: px(5), fill: "var(--accent)" }, L.over);
  if (st && st.guide) svgEl("path", { d: C.ptsToD(st.guide), fill: "none", stroke: "var(--accent)", "stroke-dasharray": "3 3", ...sw }, L.over);
  // Einrastpunkt
  if (App.snapMark) {
    const p = App.snapMark.p, r = px(6);
    svgEl("circle", { cx: p[0], cy: p[1], r, fill: "none", stroke: "var(--sel)", "stroke-width": 2, ...sw }, L.over);
    if (App.snapMark.label) {
      const tx = svgEl("text", { x: p[0] + px(9), y: p[1] - px(8), "font-size": px(12), fill: "var(--sel)", "font-family": "Barlow, sans-serif", "font-weight": 600 }, L.over);
      tx.textContent = App.snapMark.label;
    }
  }
}

// ------------------------------------------------------------------ Auswahl & Griffe
const selectedShapes = () => App.sel.map(id => App.tile.shapes.find(s => s.id === id)).filter(Boolean);
const viewShape = s => C.shapeImage(s, App.selOp, App.tile.size); // sichtbare Ausgabe der gewählten Instanz
const toSrc = p => C.opApply(C.opInverse(App.selOp), p, App.tile.size);
function selBox(sel) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of sel) { const q = C.shapeBBox(viewShape(s)); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; }
  return b;
}
function pointHandles(s) {
  // Griffe in Quell-Koordinaten
  if (s.t === "line" || s.t === "path") return s.p.map((p, i) => ({ k: "pt", i, p }));
  if (s.t === "poly" && s.p.length <= 40) return s.p.map((p, i) => ({ k: "pt", i, p }));
  if (s.t === "ellipse") {
    const cr = Math.cos(s.rot || 0), sr = Math.sin(s.rot || 0);
    return [{ k: "center", p: [s.cx, s.cy] }, { k: "rx", p: [s.cx + s.rx * cr, s.cy + s.rx * sr] }, { k: "ry", p: [s.cx - s.ry * sr, s.cy + s.ry * cr] }];
  }
  if (s.t === "arc") return [{ k: "center", p: [s.cx, s.cy] }, { k: "a0", p: [s.cx + s.r * Math.cos(s.a0), s.cy + s.r * Math.sin(s.a0)] }, { k: "a1", p: [s.cx + s.r * Math.cos(s.a1), s.cy + s.r * Math.sin(s.a1)] }];
  return [];
}
function handleList() {
  const sel = selectedShapes();
  if (!sel.length) return [];
  const S = App.tile.size, out = [];
  const b = selBox(sel), pad = px(8);
  const bx = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  [[bx[0], bx[1]], [bx[2], bx[1]], [bx[2], bx[3]], [bx[0], bx[3]]].forEach((p, i) => out.push({ k: "scale", p, i }));
  out.push({ k: "rotate", p: [(bx[0] + bx[2]) / 2, bx[1] - px(26)] });
  if (sel.length === 1) for (const h of pointHandles(sel[0])) out.push({ ...h, p: C.opApply(App.selOp, h.p, S), shape: sel[0].id });
  out.box = bx;
  return out;
}
function drawHandles(sel) {
  const hl = handleList(), bx = hl.box, sw = { "vector-effect": "non-scaling-stroke" };
  svgEl("rect", { x: bx[0], y: bx[1], width: bx[2] - bx[0], height: bx[3] - bx[1], fill: "none", stroke: "var(--sel)", "stroke-dasharray": "4 3", ...sw }, L.over);
  svgEl("line", { x1: (bx[0] + bx[2]) / 2, y1: bx[1], x2: (bx[0] + bx[2]) / 2, y2: bx[1] - px(26), stroke: "var(--sel)", ...sw }, L.over);
  for (const h of hl) {
    const r = px(h.k === "pt" ? 4.5 : 6);
    if (h.k === "rotate") svgEl("circle", { cx: h.p[0], cy: h.p[1], r: px(7), fill: "var(--paper)", stroke: "var(--sel)", "stroke-width": 2, ...sw }, L.over);
    else if (h.k === "scale") svgEl("rect", { x: h.p[0] - r, y: h.p[1] - r, width: r * 2, height: r * 2, fill: "var(--paper)", stroke: "var(--sel)", "stroke-width": 2, ...sw }, L.over);
    else {
      const s = App.tile.shapes.find(q => q.id === h.shape);
      const corner = s && s.c && s.c[h.i];
      if (corner) svgEl("rect", { x: h.p[0] - r, y: h.p[1] - r, width: r * 2, height: r * 2, fill: "var(--sel)", stroke: "var(--paper)", "stroke-width": 1.5, ...sw }, L.over);
      else svgEl("circle", { cx: h.p[0], cy: h.p[1], r, fill: h.k === "center" ? "var(--paper)" : "var(--sel)", stroke: h.k === "center" ? "var(--sel)" : "var(--paper)", "stroke-width": 1.5, ...sw }, L.over);
    }
  }
}

// ------------------------------------------------------------------ Treffer & Einrasten
function hitShape(p) {
  const tol = px(8), t = App.tile;
  let best = null;
  for (let i = t.shapes.length - 1; i >= 0; i--) {
    const s = t.shapes[i];
    for (const im of imagePolys(s)) {
      for (const pl of im.pls) {
        const d = C.distToPolyline(p, pl)[0];
        if (d < tol && (!best || d < best.d)) best = { s, op: im.op, d };
      }
    }
  }
  if (best) return best;
  // Innerhalb einer geschlossenen Form (kleinste zuerst)
  let inside = null;
  for (const s of t.shapes) {
    if (!(s.closed || s.t === "ellipse")) continue;
    for (const im of imagePolys(s)) {
      const pl = im.pls[0];
      if (pl && C.pointInRing(p, pl)) {
        const a = Math.abs(C.ringArea(pl));
        if (!inside || a < inside.a) inside = { s, op: im.op, a, d: 0 };
      }
    }
  }
  return inside;
}
function hitPiece(p) {
  if (!App.arr || App.arrDirty) return null;
  const tol = px(7);
  let best = null;
  for (const pc of App.arr.pieces) {
    if (pc.frame) continue;
    if (p[0] < pc.bbox[0] - tol || p[0] > pc.bbox[2] + tol || p[1] < pc.bbox[1] - tol || p[1] > pc.bbox[3] + tol) continue;
    const d = C.distToPolyline(p, pc.pts)[0];
    if (d < tol && (!best || d < best.d)) best = { piece: pc, d };
  }
  return best && best.piece;
}
function hitFace(p) {
  if (!App.arr || App.arrDirty) return null;
  let best = null;
  for (const f of App.arr.faces) {
    if (p[0] < f.bbox[0] || p[0] > f.bbox[2] || p[1] < f.bbox[1] || p[1] > f.bbox[3]) continue;
    if (C.pointInFace(p, f) && (!best || f.area < best.area)) best = f;
  }
  return best;
}
function buildKeyCache() {
  const t = App.tile, S = t.size, pts = [];
  const add = (p, label, prio) => pts.push({ p, label, prio });
  add([0, 0], "Ecke", 0); add([S, 0], "Ecke", 0); add([S, S], "Ecke", 0); add([0, S], "Ecke", 0);
  add([S / 2, S / 2], "Mitte", 0);
  for (const [x, y] of [[S / 2, 0], [S, S / 2], [S / 2, S], [0, S / 2]]) add([x, y], "Kantenmitte", 0);
  for (const f of [0.25, 0.75]) for (const [x, y] of [[S * f, 0], [S, S * f], [S * f, S], [0, S * f]]) add([x, y], "Viertel", 1);
  for (const s of t.shapes) for (const im of allImages(s)) {
    const k = C.keyPoints(im.s);
    k.forEach((p, i) => add(p, (s.t === "ellipse" || s.t === "arc") && i === 0 ? "Mittelpunkt" : "Punkt", 1));
  }
  if (App.arr && !App.arrDirty) for (const n of App.arr.nodes) add(n, "Schnittpunkt", 1);
  App.keyCache = pts;
}
function snap(p, opt = {}) {
  App.snapMark = null;
  if (!App.opts.snap || opt.free) return p;
  if (!App.keyCache) buildKeyCache();
  const tol = px(11);
  let best = null;
  for (const k of App.keyCache) {
    if (opt.exclude && opt.exclude(k)) continue;
    const d = C.dist(p, k.p) + k.prio * px(2);
    if (d < tol && (!best || d < best.d)) best = { d, p: k.p, label: k.label };
  }
  if (!best && App.opts.grid > 0) {
    const g = App.opts.grid, q = [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
    if (C.dist(p, q) < tol * 0.8) best = { p: q, label: "" };
  }
  if (!best && !opt.noLine) {
    // auf einer vorhandenen Linie
    const lines = App.arr && !App.arrDirty ? App.arr.pieces.map(x => x.pts) : C.tilePolylines(App.tile);
    let bd = tol * 0.7, bq = null;
    for (const pl of lines) { const [d, q] = C.distToPolyline(p, pl); if (d < bd) { bd = d; bq = q; } }
    if (bq) best = { p: bq, label: "auf Linie" };
  }
  if (best) { App.snapMark = { p: best.p, label: best.label }; return best.p.slice(); }
  return p;
}
function snapAngle(a, p) {
  const ang = Math.atan2(p[1] - a[1], p[0] - a[0]), L = C.dist(a, p);
  const s = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
  return [a[0] + L * Math.cos(s), a[1] + L * Math.sin(s)];
}

// ------------------------------------------------------------------ Verlauf & Änderungen
function snapshot() {
  const t = App.tile;
  return JSON.stringify({ shapes: t.shapes, erasers: t.erasers, fills: t.fills, sym: t.sym, size: t.size, type: t.type, name: t.name });
}
function pushHistory() {
  App.hist.undo.push(snapshot());
  if (App.hist.undo.length > 120) App.hist.undo.shift();
  App.hist.redo = [];
  updateUndoButtons();
}
function restore(s) { Object.assign(App.tile, JSON.parse(s)); App.sel = []; flatCache = new WeakMap(); changed(true); syncTop(); }
function undo() { if (!App.hist.undo.length) return; App.hist.redo.push(snapshot()); restore(App.hist.undo.pop()); updateUndoButtons(); }
function redo() { if (!App.hist.redo.length) return; App.hist.undo.push(snapshot()); restore(App.hist.redo.pop()); updateUndoButtons(); }
function updateUndoButtons() { $("#btn-undo").disabled = !App.hist.undo.length; $("#btn-redo").disabled = !App.hist.redo.length; }
function edit(fn) { pushHistory(); fn(); changed(); }
function changed(full) {
  App.arrDirty = true; App.keyCache = null; flatCache = new WeakMap(); App.hover = null;
  App.tile.updated = Date.now();
  renderAll();
  if (full !== "nosave") renderSide();
  scheduleArrange();
  if (window.Store) scheduleSave();
}
function scheduleArrange(delay = 160) {
  clearTimeout(App.arrTimer);
  $("#busy-chip").classList.add("on");
  App.arrTimer = setTimeout(() => {
    requestAnimationFrame(() => setTimeout(computeArrangement, 0));
  }, delay);
}
function computeArrangement() {
  try { App.arr = C.arrange(App.tile); App.arrDirty = false; }
  catch (e) { console.error(e); }
  $("#busy-chip").classList.remove("on");
  App.keyCache = null;
  renderFaces(); renderLines(); renderOverlay();
}
function ensureArrangement() { if (App.arrDirty || !App.arr) { clearTimeout(App.arrTimer); computeArrangement(); } return App.arr; }
// Radierpunkte entfernen, die auf einer veränderten Form lagen
function dropErasersOn(shapes) {
  const t = App.tile;
  if (!t.erasers.length) return;
  const lines = [];
  for (const s of shapes) for (const im of allImages(s)) lines.push(...C.flatten(im.s, 0.5));
  const ops = C.GROUPS[t.sym].ops;
  t.erasers = t.erasers.filter(e => !ops.some(op => { const q = C.opApply(op, [e.x, e.y], t.size); return lines.some(pl => C.distToPolyline(q, pl)[0] < 0.6); }));
}
function addShapes(list) {
  edit(() => { for (const s of list) { s.id = s.id || C.uid(); App.tile.shapes.push(s); } });
}

// ------------------------------------------------------------------ Werkzeug-Logik
function setTool(id) {
  cancelAction();
  App.tool = id;
  if (id !== "select") App.sel = [];
  document.querySelectorAll(".tool").forEach(b => b.setAttribute("aria-pressed", b.dataset.tool === id));
  $("#hint-text").innerHTML = HINTS[id];
  svg.className.baseVal = { select: "cur-grab", merge: "cur-cell", fill: "cur-cell", cut: "cur-cross" }[id] || "cur-cross";
  if (["merge", "cut", "fill"].includes(id)) ensureArrangement();
  renderSide(); renderOverlay();
}
function cancelAction() { App.st = null; App.snapMark = null; App.hover = null; closePopover(); renderOverlay(); }

function shapeFromDrag(tool, a, b, shift) {
  const to = App.to;
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
  switch (tool) {
    case "rect": {
      let x0, y0, x1, y1;
      if (to.rectCenter) { let w = Math.abs(dx), h = Math.abs(dy); if (shift) w = h = Math.max(w, h); x0 = a[0] - w; x1 = a[0] + w; y0 = a[1] - h; y1 = a[1] + h; }
      else { let w = dx, h = dy; if (shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; } x0 = a[0]; y0 = a[1]; x1 = a[0] + w; y1 = a[1] + h; }
      const p = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      return { t: "path", p, c: [true, true, true, true], closed: true };
    }
    case "circle":
      if (to.circleMode === "oval") return { t: "ellipse", cx: a[0], cy: a[1], rx: Math.max(Math.abs(dx), 0.5), ry: Math.max(Math.abs(dy), 0.5), rot: 0 };
      return { t: "ellipse", cx: a[0], cy: a[1], rx: L, ry: L, rot: 0 };
    case "polygon": return C.regularPolygon(a[0], a[1], L, to.sides, ang);
    case "star": return C.star(a[0], a[1], L, to.points, to.ratio / 100, ang);
    case "leaf": return C.leaf(a, b, to.leafW);
  }
}
function defaultShape(tool, p) {
  const r = 20;
  if (tool === "rect") return { t: "path", p: [[p[0] - r, p[1] - r], [p[0] + r, p[1] - r], [p[0] + r, p[1] + r], [p[0] - r, p[1] + r]], c: [true, true, true, true], closed: true };
  if (tool === "circle") return { t: "ellipse", cx: p[0], cy: p[1], rx: r, ry: App.to.circleMode === "oval" ? r * 0.6 : r, rot: 0 };
  if (tool === "polygon") return C.regularPolygon(p[0], p[1], r, App.to.sides, -Math.PI / 2);
  if (tool === "star") return C.star(p[0], p[1], r, App.to.points, App.to.ratio / 100, -Math.PI / 2);
  if (tool === "leaf") return C.leaf([p[0], p[1] - r], [p[0], p[1] + r], App.to.leafW);
}

const Tools = {};
// --- Auswählen
Tools.select = {
  down(p, e) {
    const hl = handleList(), tol = px(9);
    const h = hl.find(h => C.dist(h.p, p) < tol && h.k !== "scale" && h.k !== "rotate") || hl.find(h => C.dist(h.p, p) < tol);
    if (h) {
      App.st = { mode: "handle", h, start: p, orig: JSON.parse(JSON.stringify(selectedShapes())), box: hl.box, moved: false };
      return;
    }
    const hit = hitShape(p);
    if (hit) {
      if (e.shiftKey) { App.sel = App.sel.includes(hit.s.id) ? App.sel.filter(i => i !== hit.s.id) : [...App.sel, hit.s.id]; }
      else if (!App.sel.includes(hit.s.id)) App.sel = [hit.s.id];
      App.selOp = hit.op;
      App.st = { mode: "move", start: snap(p, { exclude: k => false, noLine: true }), orig: JSON.parse(JSON.stringify(selectedShapes())), moved: false };
      App.snapMark = null;
      renderSide(); renderOverlay();
      return;
    }
    if (!e.shiftKey && App.sel.length) { App.sel = []; renderSide(); }
    App.st = { mode: "pan", startClient: [e.clientX, e.clientY], v0: { ...App.view } };
    svg.className.baseVal = "cur-grabbing";
    renderOverlay();
  },
  move(p, e) {
    const st = App.st, S = App.tile.size;
    if (!st) { const hit = hitShape(p); App.hover = hit ? { kind: "shape", shape: hit.s } : null; renderOverlay(); return; }
    if (st.mode === "pan") {
      App.view.cx = st.v0.cx - (e.clientX - st.startClient[0]) / App.view.scale;
      App.view.cy = st.v0.cy - (e.clientY - st.startClient[1]) / App.view.scale;
      applyView(); return;
    }
    st.moved = true;
    const inv = C.opInverse(App.selOp);
    const replace = (list) => { for (const s of list) { const i = App.tile.shapes.findIndex(q => q.id === s.id); if (i >= 0) App.tile.shapes[i] = s; } };
    if (st.mode === "move") {
      const q = snap(p, { noLine: true });
      const dv = C.opApplyVec(inv, [q[0] - st.start[0], q[1] - st.start[1]]);
      replace(st.orig.map(s => C.moveShape(s, dv[0], dv[1])));
    } else if (st.mode === "handle") {
      const h = st.h;
      if (h.k === "scale" || h.k === "rotate") {
        const b = st.box, cv = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], cs = C.opApply(inv, cv, S);
        if (h.k === "scale") {
          let k = C.dist(p, cv) / Math.max(C.dist(st.start, cv), 1e-6);
          k = Math.max(k, 0.02);
          replace(st.orig.map(s => C.mapShape(s, [k, 0, 0, k], cs)));
        } else {
          let a = Math.atan2(p[1] - cv[1], p[0] - cv[0]) - Math.atan2(st.start[1] - cv[1], st.start[0] - cv[0]);
          if (e.shiftKey || App.opts.snap) a = Math.round(a / (Math.PI / 24)) * (Math.PI / 24);
          const as = a * C.opDet(App.selOp);
          replace(st.orig.map(s => C.mapShape(s, C.rotM(as), cs)));
        }
      } else {
        const q = snap(p, { exclude: k => C.dist(k.p, h.p) < 1e-6 });
        const qs = C.opApply(inv, q, S);
        const s = JSON.parse(JSON.stringify(st.orig[0]));
        if (h.k === "pt") s.p[h.i] = qs;
        else if (h.k === "center") { const d = [qs[0] - s.cx, qs[1] - s.cy]; s.cx = qs[0]; s.cy = qs[1]; }
        else if (h.k === "rx" || h.k === "ry") {
          const cr = Math.cos(s.rot || 0), sr = Math.sin(s.rot || 0), dx = qs[0] - s.cx, dy = qs[1] - s.cy;
          const lx = dx * cr + dy * sr, ly = -dx * sr + dy * cr;
          if (s.rx === s.ry && !e.altKey) { const r = Math.max(Math.hypot(dx, dy), 0.3); s.rx = s.ry = r; }
          else if (h.k === "rx") s.rx = Math.max(Math.abs(lx), 0.3); else s.ry = Math.max(Math.abs(ly), 0.3);
        } else if (h.k === "a0" || h.k === "a1") {
          const a = Math.atan2(qs[1] - s.cy, qs[0] - s.cx);
          s.r = Math.max(C.dist(qs, [s.cx, s.cy]), 0.3);
          if (h.k === "a0") { const sw = s.a1 - s.a0; s.a0 = a; let n = s.a1 - a; while (Math.sign(n) !== Math.sign(sw) && Math.abs(n) > 1e-9) n += Math.sign(sw) * 2 * Math.PI; s.a1 = a + n; }
          else { const sw = s.a1 - s.a0; let n = a - s.a0; while (Math.sign(n) !== Math.sign(sw) && Math.abs(n) > 1e-9) n += Math.sign(sw) * 2 * Math.PI; s.a1 = s.a0 + n; }
        }
        replace([s]);
      }
    }
    App.arrDirty = true; App.keyCache = null; flatCache = new WeakMap();
    renderLines(); renderFaces(); renderOverlay();
  },
  up() {
    const st = App.st; App.st = null;
    svg.className.baseVal = "cur-grab";
    if (!st || st.mode === "pan") { renderOverlay(); return; }
    if (!st.moved) { App.snapMark = null; renderOverlay(); return; }
    // Änderung übernehmen: Verlauf mit dem Zustand vor dem Ziehen
    const now = selectedShapes().map(s => JSON.parse(JSON.stringify(s)));
    for (const o of st.orig) { const i = App.tile.shapes.findIndex(q => q.id === o.id); if (i >= 0) App.tile.shapes[i] = o; }
    pushHistory();
    dropErasersOn(st.orig);
    for (const s of now) { const i = App.tile.shapes.findIndex(q => q.id === s.id); if (i >= 0) App.tile.shapes[i] = s; }
    App.snapMark = null;
    changed();
  },
  dbl(p) {
    const hl = handleList(), tol = px(9);
    const h = hl.find(h => h.k === "pt" && C.dist(h.p, p) < tol);
    const sel = selectedShapes();
    if (h && sel[0] && sel[0].t === "path") { edit(() => { const s = sel[0]; s.c[h.i] = !s.c[h.i]; }); return; }
    // Punkt einfügen
    if (sel.length === 1 && (sel[0].t === "path" || sel[0].t === "line" || sel[0].t === "poly")) {
      const s = sel[0], q = toSrc(p);
      if (s.t === "line") { edit(() => { s.t = "path"; s.p = [s.p[0], q, s.p[1]]; s.c = [true, true, true]; s.closed = false; }); return; }
      let best = { d: Infinity, i: -1 };
      if (s.t === "path") {
        C.pathBeziers(s.p, s.c, s.closed).forEach((sg, i) => {
          for (let k = 0; k <= 20; k++) {
            const tt = k / 20, mt = 1 - tt;
            const x = mt ** 3 * sg[0][0] + 3 * mt * mt * tt * sg[1][0] + 3 * mt * tt * tt * sg[2][0] + tt ** 3 * sg[3][0];
            const y = mt ** 3 * sg[0][1] + 3 * mt * mt * tt * sg[1][1] + 3 * mt * tt * tt * sg[2][1] + tt ** 3 * sg[3][1];
            const d = Math.hypot(x - q[0], y - q[1]); if (d < best.d) best = { d, i, pt: [x, y] };
          }
        });
      } else {
        const n = s.closed ? s.p.length : s.p.length - 1;
        for (let i = 0; i < n; i++) { const r = C.distToSeg(q, s.p[i], s.p[(i + 1) % s.p.length]); if (r[0] < best.d) best = { d: r[0], i, pt: r[1] }; }
      }
      if (best.i >= 0 && best.d < px(10)) edit(() => { s.p.splice(best.i + 1, 0, best.pt); if (s.c) s.c.splice(best.i + 1, 0, false); });
    }
  },
};
// --- Linie
Tools.line = {
  down(p, e) {
    let q = snap(p);
    const st = App.st;
    if (st && st.a) { if (e.shiftKey) q = snapAngle(st.a, q); this.commit(st.a, q); return; }
    App.st = { a: q, dragging: true, preview: null };
  },
  move(p, e) {
    let q = snap(p);
    const st = App.st;
    if (st && st.a) { if (e.shiftKey) q = snapAngle(st.a, q); st.preview = { t: "line", p: [st.a, q] }; st.points = [st.a]; }
    renderOverlay();
  },
  up(p, e) {
    const st = App.st; if (!st || !st.dragging) return;
    st.dragging = false;
    let q = snap(p); if (e.shiftKey) q = snapAngle(st.a, q);
    if (C.dist(st.a, q) > 1) this.commit(st.a, q);
  },
  commit(a, b) { App.st = null; App.snapMark = null; if (C.dist(a, b) > 0.3) addShapes([{ t: "line", p: [a, b] }]); else renderOverlay(); },
};
// --- Kurve
Tools.curve = {
  down(p, e) {
    const q = snap(p);
    let st = App.st;
    if (!st) st = App.st = { pts: [], corners: [], points: [] };
    if (st.pts.length >= 3 && C.dist(q, st.pts[0]) < px(10)) { this.finish(true); return; }
    if (st.pts.length && C.dist(q, st.pts[st.pts.length - 1]) < 0.2) return;
    st.pts.push(q); st.corners.push(App.to.corner !== !!e.shiftKey);
    st.points = st.pts;
    this.move(p, e);
  },
  move(p) {
    const st = App.st, q = snap(p);
    if (st && st.pts.length) {
      const pts = [...st.pts, q], c = [...st.corners, false];
      st.preview = { t: "path", p: pts, c, closed: false };
    }
    renderOverlay();
  },
  dbl() { this.finish(false); },
  key(k) { if (k === "Enter") this.finish(false); if (k === "Backspace" && App.st) { App.st.pts.pop(); App.st.corners.pop(); if (!App.st.pts.length) App.st = null; renderOverlay(); } },
  finish(closed) {
    const st = App.st; App.st = null; App.snapMark = null;
    if (!st || st.pts.length < 2) { renderOverlay(); return; }
    const c = st.corners.slice();
    if (!closed) { c[0] = true; c[c.length - 1] = true; }
    addShapes([{ t: "path", p: st.pts, c, closed }]);
  },
};
// --- Pinsel mit Stabilisator
Tools.brush = {
  down(p) {
    closePopover();
    App.st = { raw: [p.slice()], pos: p.slice(), drawing: true, dash: false };
    App.st.preview = { t: "poly", p: App.st.raw, closed: false };
  },
  move(p) {
    const st = App.st;
    if (!st || !st.drawing) return;
    const R = px(App.to.stab * 1.5);
    const d = [p[0] - st.pos[0], p[1] - st.pos[1]], L = Math.hypot(d[0], d[1]);
    if (L > R) {
      const k = (L - R) / L;
      st.pos = [st.pos[0] + d[0] * k, st.pos[1] + d[1] * k];
      if (C.dist(st.pos, st.raw[st.raw.length - 1]) > 0.25) st.raw.push(st.pos.slice());
    }
    st.guide = [st.pos, p];
    renderOverlay();
  },
  up() {
    const st = App.st;
    if (!st || !st.drawing) return;
    st.drawing = false; st.guide = null;
    if (st.raw.length < 3 || C.polylineLength(st.raw) < 2) { App.st = null; renderOverlay(); return; }
    openSmoothing(st.raw);
  },
};
function smoothStroke(raw, level) {
  // level 0..100: wie stark begradigt wird
  const closed = C.dist(raw[0], raw[raw.length - 1]) < 4 && C.polylineLength(raw) > 20;
  let pts = raw.slice();
  // leichte Mittelung gegen Zittern
  const passes = Math.round(level / 25);
  for (let k = 0; k < passes; k++) pts = pts.map((p, i) => i === 0 || i === pts.length - 1 ? p : [(pts[i - 1][0] + p[0] * 2 + pts[i + 1][0]) / 4, (pts[i - 1][1] + p[1] * 2 + pts[i + 1][1]) / 4]);
  const eps = 0.08 + Math.pow(level / 100, 1.6) * 3.2;
  let s = C.simplifyRDP(pts, eps);
  if (closed && s.length > 3) s = s.slice(0, -1);
  if (s.length < 2) s = [raw[0], raw[raw.length - 1]];
  const n = s.length;
  const c = s.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return true;
    const a = s[(i - 1 + n) % n], b = s[(i + 1) % n];
    const v1 = [p[0] - a[0], p[1] - a[1]], v2 = [b[0] - p[0], b[1] - p[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1);
    return cos < Math.cos(Math.PI * 0.36);
  });
  return { t: "path", p: s, c, closed: closed && n >= 3 };
}
// --- Formen ziehen
for (const id of ["rect", "circle", "polygon", "star", "leaf"]) {
  Tools[id] = {
    down(p) { App.st = { a: snap(p), preview: null }; },
    move(p, e) {
      const st = App.st, q = snap(p);
      if (st) { st.preview = C.dist(st.a, q) > 0.5 ? shapeFromDrag(id, st.a, q, e.shiftKey) : null; st.points = [st.a]; }
      renderOverlay();
    },
    up(p, e) {
      const st = App.st; App.st = null; App.snapMark = null;
      if (!st) return;
      const q = snap(p);
      const s = C.dist(st.a, q) > 1.5 ? shapeFromDrag(id, st.a, q, e.shiftKey) : defaultShape(id, st.a);
      App.snapMark = null;
      addShapes([s]);
    },
  };
}
// --- Bogen
Tools.arc = {
  down(p) {
    const q = snap(p), st = App.st;
    if (!st) { App.st = { stage: 1, center: q }; return; }
    if (st.stage === 1) {
      const r = C.dist(q, st.center); if (r < 0.5) return;
      st.stage = 2; st.r = r; st.a0 = Math.atan2(q[1] - st.center[1], q[0] - st.center[0]); st.sweep = 0; st.last = st.a0;
      return;
    }
    if (st.stage === 2) {
      App.st = null; App.snapMark = null;
      if (Math.abs(st.sweep) < 0.01) { renderOverlay(); return; }
      addShapes([{ t: "arc", cx: st.center[0], cy: st.center[1], r: st.r, a0: st.a0, a1: st.a0 + st.sweep }]);
    }
  },
  move(p) {
    const st = App.st;
    const q = snap(p, st && st.stage === 2 ? { exclude: k => k.label === "auf Linie" } : {});
    if (st && st.stage === 1) { st.guide = [st.center, q]; st.preview = { t: "ellipse", cx: st.center[0], cy: st.center[1], rx: C.dist(q, st.center), ry: C.dist(q, st.center), rot: 0 }; st.dash = true; }
    if (st && st.stage === 2) {
      const a = Math.atan2(q[1] - st.center[1], q[0] - st.center[0]);
      let d = a - st.last; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      st.sweep += d; st.last = a;
      if (App.snapMark) { // eingerasteten Endpunkt exakt treffen
        let full = Math.atan2(App.snapMark.p[1] - st.center[1], App.snapMark.p[0] - st.center[0]) - st.a0;
        while (full - st.sweep > Math.PI) full -= 2 * Math.PI; while (st.sweep - full > Math.PI) full += 2 * Math.PI;
        st.sweep = full;
      }
      st.dash = false; st.guide = [st.center, q];
      st.preview = { t: "arc", cx: st.center[0], cy: st.center[1], r: st.r, a0: st.a0, a1: st.a0 + st.sweep };
    }
    renderOverlay();
  },
};
// --- Parallele
Tools.offset = {
  move(p) {
    const hit = hitShape(p);
    App.hover = null;
    if (hit) {
      const q = C.opApply(C.opInverse(hit.op), p, App.tile.size);
      const res = this.make(hit.s, q);
      App.st = { preview: res, dash: true, target: hit.s, q };
    } else App.st = null;
    renderOverlay();
  },
  make(s, q) {
    const d = App.to.offset;
    let res = C.offsetShape(s, d, q);
    if (App.to.offsetBoth) {
      // gegenüberliegende Seite: Punkt spiegeln an der Linie
      const pl = C.flatten(s, 0.5)[0], [, near] = C.distToPolyline(q, pl);
      const q2 = [near[0] * 2 - q[0], near[1] * 2 - q[1]];
      res = res.concat(C.offsetShape(s, d, q2));
    }
    return res;
  },
  down() {
    const st = App.st;
    if (st && st.preview && st.preview.length) { const list = st.preview; App.st = null; addShapes(list); }
  },
};
// --- Flächen verbinden
Tools.merge = {
  down(p) { ensureArrangement(); const f = hitFace(p); if (!f) return; App.st = { touched: [f] }; App.hover = null; renderOverlay(); },
  move(p) {
    const st = App.st, f = hitFace(p);
    if (st) { if (f && !st.touched.includes(f)) st.touched.push(f); }
    else App.hover = f ? { kind: "face", face: f } : null;
    renderOverlay();
  },
  up() {
    const st = App.st; App.st = null;
    if (!st || st.touched.length < 2) { renderOverlay(); return; }
    const set = new Set(st.touched), add = [];
    for (const pc of App.arr.pieces) {
      if (pc.frame) continue;
      const i = Math.max(1, Math.floor(pc.pts.length / 2));
      const a = pc.pts[i - 1], b = pc.pts[i];
      const m = C.lerp(a, b, 0.5), L = C.dist(a, b) || 1, n = [-(b[1] - a[1]) / L * 0.25, (b[0] - a[0]) / L * 0.25];
      const fa = App.arr.faces.find(f => C.pointInFace([m[0] + n[0], m[1] + n[1]], f) && set.has(f));
      const fb = App.arr.faces.find(f => C.pointInFace([m[0] - n[0], m[1] - n[1]], f) && set.has(f));
      // jeweils kleinste Fläche nehmen
      const pick = (q) => { let best = null; for (const f of set) if (C.pointInFace(q, f) && (!best || f.area < best.area)) best = f; return best; };
      const A = pick([m[0] + n[0], m[1] + n[1]]), B = pick([m[0] - n[0], m[1] - n[1]]);
      if (A && B && A !== B && fa && fb) add.push({ x: C.r3(m[0]), y: C.r3(m[1]) });
    }
    if (add.length) edit(() => App.tile.erasers.push(...add));
    else renderOverlay();
  },
};
// --- Linienstück löschen
Tools.cut = {
  down(p) { ensureArrangement(); App.st = { erased: [] }; this.erase(p); },
  move(p) {
    if (App.st) { this.erase(p); return; }
    const pc = hitPiece(p); App.hover = pc ? { kind: "piece", piece: pc } : null; renderOverlay();
  },
  erase(p) {
    const pc = hitPiece(p);
    if (pc && !App.st.erased.includes(pc)) { App.st.erased.push(pc); App.hover = { kind: "piece", piece: pc }; }
    App.st.preview = null;
    renderOverlay();
    for (const e of App.st.erased) svgEl("path", { d: C.ptsToD(e.pts), fill: "none", stroke: "var(--danger)", "stroke-width": 5, "vector-effect": "non-scaling-stroke" }, L.over);
  },
  up() {
    const st = App.st; App.st = null; App.hover = null;
    if (!st || !st.erased.length) { renderOverlay(); return; }
    edit(() => { for (const pc of st.erased) { const m = C.pointAtLength(pc.pts, pc.len / 2); App.tile.erasers.push({ x: C.r3(m[0]), y: C.r3(m[1]) }); } });
  },
};
// --- Färben
Tools.fill = {
  move(p) {
    const f = hitFace(p);
    App.hover = f ? { kind: "face", face: f, color: App.to.slot ? PALETTES[App.palette].colors[App.to.slot] : PALETTES[App.palette].colors[0] } : null;
    renderOverlay();
  },
  down(p) {
    ensureArrangement();
    const f = hitFace(p); if (!f) return;
    const t = App.tile, ops = C.GROUPS[t.sym].ops;
    edit(() => {
      t.fills = t.fills.filter(fl => !ops.some(op => C.pointInFace(C.opApply(op, [fl.x, fl.y], t.size), f)));
      if (App.to.slot) t.fills.push({ x: C.r3(p[0]), y: C.r3(p[1]), slot: App.to.slot });
    });
  },
};

// ------------------------------------------------------------------ Glätten-Dialog (Pinsel)
let popoverEl = null;
function closePopover() { if (popoverEl) { popoverEl.remove(); popoverEl = null; } }
function openSmoothing(raw) {
  closePopover();
  const level = App.to.smoothLevel ?? 40;
  popoverEl = document.createElement("div");
  popoverEl.className = "popover";
  popoverEl.innerHTML = `<div class="row"><strong style="flex:1">Linie glätten</strong><span class="label-sm" id="sm-val"></span></div>
    <input type="range" id="sm-range" min="0" max="100" value="${level}" aria-label="Wie stark geglättet wird">
    <div class="row" style="justify-content:space-between"><span class="help">zittrig</span><span class="help">ganz glatt</span></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" id="sm-cancel">Verwerfen</button><button class="btn primary" id="sm-ok">Übernehmen <span class="kbd">Enter</span></button></div>`;
  $("#stage").appendChild(popoverEl);
  const upd = () => {
    const v = +$("#sm-range").value; App.to.smoothLevel = v;
    $("#sm-val").textContent = v + " %";
    const s = smoothStroke(raw, v);
    App.st = { preview: s, smoothing: s };
    renderOverlay();
  };
  $("#sm-range").addEventListener("input", upd);
  $("#sm-cancel").onclick = () => { App.st = null; closePopover(); renderOverlay(); };
  $("#sm-ok").onclick = () => { const s = App.st && App.st.smoothing; App.st = null; closePopover(); if (s) addShapes([s]); };
  upd();
}

// ------------------------------------------------------------------ Zeiger-Ereignisse
let pointerDown = false, panState = null;
svg.addEventListener("pointerdown", e => {
  svg.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || App.space) {
    panState = { start: [e.clientX, e.clientY], v0: { ...App.view } };
    svg.className.baseVal = "cur-grabbing";
    e.preventDefault(); return;
  }
  if (e.button !== 0) return;
  if (popoverEl && App.tool === "brush" && App.st && App.st.smoothing) { const s = App.st.smoothing; App.st = null; closePopover(); addShapes([s]); }
  pointerDown = true;
  const p = toMM(e);
  const T = Tools[App.tool];
  if (T && T.down) T.down(p, e);
});
svg.addEventListener("pointermove", e => {
  const p = toMM(e);
  $("#cursor-pos").textContent = `x ${fmt(p[0])}  y ${fmt(p[1])} mm`;
  if (panState) {
    App.view.cx = panState.v0.cx - (e.clientX - panState.start[0]) / App.view.scale;
    App.view.cy = panState.v0.cy - (e.clientY - panState.start[1]) / App.view.scale;
    applyView(); return;
  }
  const T = Tools[App.tool];
  if (T && T.move) T.move(p, e);
  else if (["line", "curve", "rect", "circle", "polygon", "star", "leaf", "arc"].includes(App.tool)) { snap(p); renderOverlay(); }
});
svg.addEventListener("pointerup", e => {
  if (panState) { panState = null; svg.className.baseVal = App.tool === "select" ? "cur-grab" : "cur-cross"; return; }
  if (!pointerDown) return;
  pointerDown = false;
  const T = Tools[App.tool];
  if (T && T.up) T.up(toMM(e), e);
});
svg.addEventListener("pointerleave", () => { if (!pointerDown) { App.snapMark = null; App.hover = null; renderOverlay(); } });
svg.addEventListener("dblclick", e => { const T = Tools[App.tool]; if (T && T.dbl) T.dbl(toMM(e), e); });
svg.addEventListener("contextmenu", e => e.preventDefault());
svg.addEventListener("wheel", e => { e.preventDefault(); zoomAt(Math.pow(1.0018, -e.deltaY), e.clientX, e.clientY); }, { passive: false });

window.addEventListener("keydown", e => {
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSel(); return; }
  if (!$("#modal").hidden) { if (e.key === "Escape") closeModal(); return; }
  if (e.key === " ") { App.space = true; svg.className.baseVal = "cur-grab"; e.preventDefault(); return; }
  if (e.key === "Escape") { if (App.st) cancelAction(); else if (App.sel.length) { App.sel = []; renderSide(); renderOverlay(); } else setTool("select"); return; }
  if (e.key === "Enter" && popoverEl) { $("#sm-ok").click(); return; }
  const T = Tools[App.tool];
  if (T && T.key && (e.key === "Enter" || e.key === "Backspace")) { e.preventDefault(); T.key(e.key); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && App.sel.length) { e.preventDefault(); deleteSel(); return; }
  if (e.key === "+" || e.key === "=") { zoomAt(1.25); return; }
  if (e.key === "-") { zoomAt(0.8); return; }
  if (e.key === "0") { fitView(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tool = TOOLS.find(t => t.key === e.key.toLowerCase());
  if (tool) setTool(tool.id);
});
window.addEventListener("keyup", e => { if (e.key === " ") { App.space = false; svg.className.baseVal = App.tool === "select" ? "cur-grab" : "cur-cross"; } });
window.addEventListener("resize", () => applyView());

// ------------------------------------------------------------------ Auswahl-Aktionen
function deleteSel() {
  const ids = new Set(App.sel);
  edit(() => { dropErasersOn(selectedShapes()); App.tile.shapes = App.tile.shapes.filter(s => !ids.has(s.id)); App.sel = []; });
}
function duplicateSel() {
  const sel = selectedShapes(); if (!sel.length) return;
  const copies = sel.map(s => ({ ...C.moveShape(s, 10, 10), id: C.uid() }));
  edit(() => { App.tile.shapes.push(...copies); App.sel = copies.map(s => s.id); });
}
function transformSel(M) {
  const sel = selectedShapes(); if (!sel.length) return;
  const b = selBox(sel), cv = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2], cs = toSrc(cv);
  // Matrix in Quell-Koordinaten der gewählten Instanz umrechnen: G^-1 M G
  const G = C.OPS[App.selOp], Gi = C.OPS[C.opInverse(App.selOp)];
  const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
  const Ms = mul(Gi, mul(M, G));
  edit(() => { dropErasersOn(sel); for (const s of sel) { const i = App.tile.shapes.findIndex(q => q.id === s.id); App.tile.shapes[i] = { ...C.mapShape(s, Ms, cs), id: s.id }; } });
}
function repeatCircular() {
  const sel = selectedShapes(); if (!sel.length) return;
  const S = App.tile.size, to = App.to;
  const centers = { mitte: [S / 2, S / 2], ol: [0, 0], or: [S, 0], ur: [S, S], ul: [0, S] };
  let c = centers[to.repCenter];
  if (to.repCenter === "form") { const b = selBox(sel); c = toSrc([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]); }
  const n = Math.max(2, to.repN | 0);
  const step = to.repFull ? 2 * Math.PI / n : to.repStep * Math.PI / 180;
  const add = [];
  for (let k = 1; k < n; k++) for (const s of sel) add.push({ ...C.mapShape(s, C.rotM(step * k), c), id: C.uid() });
  edit(() => App.tile.shapes.push(...add));
  toast(`${add.length} Kopien angelegt`);
}
function repeatRow() {
  const sel = selectedShapes(); if (!sel.length) return;
  const to = App.to, n = Math.max(2, to.rowN | 0), add = [];
  const dv = C.opApplyVec(C.opInverse(App.selOp), [to.rowDx, to.rowDy]);
  for (let k = 1; k < n; k++) for (const s of sel) add.push({ ...C.moveShape(s, dv[0] * k, dv[1] * k), id: C.uid() });
  edit(() => App.tile.shapes.push(...add));
  toast(`${add.length} Kopien angelegt`);
}

// ------------------------------------------------------------------ Seitenleiste
function numField(label, key, min, max, step = 1, unit = "") {
  return `<label class="field"><span>${label}</span><input type="number" id="to-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${App.to[key]}" aria-label="${label}${unit ? " in " + unit : ""}"></label>`;
}
function renderSide() {
  const t = App.tile, to = App.to, side = $("#side");
  if (!t) return;
  let h = "";
  const tool = TOOLS.find(x => x.id === App.tool);
  const sec = (title, body) => `<section class="sec"><h3>${title}</h3>${body}</section>`;
  // Werkzeug-Optionen
  if (App.tool === "polygon") h += sec("Vieleck", numField("Ecken", "sides", 3, 24) + `<p class="help">3 = Dreieck, 4 = Raute, 6 = Sechseck.</p>`);
  if (App.tool === "star") h += sec("Stern", numField("Zacken", "points", 3, 32) + `<label class="sec"><span>Tiefe der Zacken: <b id="ratio-v">${to.ratio} %</b></span><input type="range" id="to-ratio" data-key="ratio" min="15" max="90" value="${to.ratio}"></label>`);
  if (App.tool === "leaf") h += sec("Blatt", `<label class="sec"><span>Breite: <b id="leafW-v">${to.leafW} %</b></span><input type="range" id="to-leafW" data-key="leafW" min="10" max="110" value="${to.leafW}"></label>`);
  if (App.tool === "circle") h += sec("Kreis", `<div class="seg" role="group"><button data-opt="circleMode" data-val="kreis" aria-pressed="${to.circleMode === "kreis"}">Kreis</button><button data-opt="circleMode" data-val="oval" aria-pressed="${to.circleMode === "oval"}">Oval</button></div>`);
  if (App.tool === "rect") h += sec("Rechteck", `<label class="row"><input type="checkbox" id="to-rectCenter" ${to.rectCenter ? "checked" : ""}> Von der Mitte aus ziehen</label>`);
  if (App.tool === "curve") h += sec("Kurve", `<p class="help">Art des nächsten Punktes:</p><div class="seg" role="group"><button data-opt="corner" data-val="0" aria-pressed="${!to.corner}">● rund</button><button data-opt="corner" data-val="1" aria-pressed="${to.corner}">■ eckig</button></div><p class="help">Mit gedrückter <span class="kbd">Umschalt</span>-Taste wird ein Punkt andersherum gesetzt.</p>`);
  if (App.tool === "brush") h += sec("Pinsel", `<label class="sec"><span>Stabilisator: <b id="stab-v">${to.stab}</b></span><input type="range" id="to-stab" data-key="stab" min="0" max="40" value="${to.stab}"></label><p class="help">Je höher, desto ruhiger wird die Linie. Die Linie läuft dem Mauszeiger dann wie an einer Schnur hinterher.</p>`);
  if (App.tool === "offset") h += sec("Parallele", numField("Abstand", "offset", 0.5, 60, 0.5, "mm") + `<label class="row"><input type="checkbox" id="to-offsetBoth" ${to.offsetBoth ? "checked" : ""}> Auf beiden Seiten</label><p class="help">Ideal für Doppellinien, Ränder und Bänder.</p>`);
  if (App.tool === "fill") {
    const pal = PALETTES[App.palette].colors;
    h += sec("Farbe", `<div class="swatches">${pal.map((c, i) => `<button class="sw" data-slot="${i}" style="background:${c}" aria-pressed="${to.slot === i}" title="${i ? "Farbe " + i : "Grundfarbe (Füllung entfernen)"}"><small>${i || "G"}</small></button>`).join("")}</div><p class="help">G = Grundfarbe. Die Farben folgen der Palette oben rechts – wechselst du die Palette, färbt sich alles mit um.</p>`);
  }
  if (App.tool === "merge") h += sec("Flächen verbinden", `<p class="help">Beispiel: Zwei überlappende Rechtecke zeichnen, dann durch alle Teile des Pluszeichens ziehen – übrig bleibt nur die Außenlinie.</p>`);
  if (App.tool === "cut") h += sec("Stück löschen", `<p class="help">Gelöscht wird immer nur das Stück zwischen zwei Kreuzungen. Mit <b>Zurück</b> kommt es wieder.</p>`);
  // Auswahl
  const sel = selectedShapes();
  if (App.tool === "select") {
    if (sel.length) {
      const s = sel[0];
      let extra = "";
      if (sel.length === 1 && s.t === "ellipse") extra = `<div class="grid2"><label class="field" style="grid-template-columns:1fr"><span>Radius waagerecht</span><input type="number" step="0.5" id="sel-rx" value="${C.r3(s.rx)}"></label><label class="field" style="grid-template-columns:1fr"><span>Radius senkrecht</span><input type="number" step="0.5" id="sel-ry" value="${C.r3(s.ry)}"></label></div>`;
      if (sel.length === 1 && s.t === "arc") extra = `<label class="field"><span>Radius (mm)</span><input type="number" step="0.5" id="sel-r" value="${C.r3(s.r)}"></label>`;
      if (sel.length === 1 && s.t === "path") extra += `<p class="help">Doppelklick auf einen Punkt: rund ↔ eckig. Doppelklick auf die Linie: neuer Punkt.</p>`;
      h += sec(sel.length === 1 ? "Ausgewählte Form" : `${sel.length} Formen ausgewählt`, `${extra}
        <div class="grid2">
          <button class="btn" data-act="dup">Duplizieren</button>
          <button class="btn danger" data-act="del">Löschen</button>
          <button class="btn" data-act="mirv">Spiegeln ↔</button>
          <button class="btn" data-act="mirh">Spiegeln ↕</button>
          <button class="btn" data-act="rot90">Drehen 90°</button>
          <button class="btn" data-act="rot45">Drehen 45°</button>
        </div>`);
      h += sec("Im Kreis vervielfältigen", `${numField("Anzahl gesamt", "repN", 2, 72)}
        <label class="field"><span>Um welchen Punkt?</span><select id="to-repCenter" data-key="repCenter">
          ${[["mitte", "Fliesenmitte"], ["ol", "Ecke oben links"], ["or", "Ecke oben rechts"], ["ur", "Ecke unten rechts"], ["ul", "Ecke unten links"], ["form", "Mitte der Form"]].map(([k, n]) => `<option value="${k}" ${to.repCenter === k ? "selected" : ""}>${n}</option>`).join("")}
        </select></label>
        <label class="row"><input type="checkbox" id="to-repFull" ${to.repFull ? "checked" : ""}> Gleichmäßig über den Vollkreis</label>
        ${to.repFull ? "" : numField("Winkel-Schritt", "repStep", 1, 180, 1, "Grad")}
        <button class="btn primary" data-act="repc">Kopien anlegen</button>`);
      h += sec("In Reihe vervielfältigen", `${numField("Anzahl gesamt", "rowN", 2, 60)}${numField("Abstand nach rechts (mm)", "rowDx", -200, 200, 0.5, "mm")}${numField("Abstand nach unten (mm)", "rowDy", -200, 200, 0.5, "mm")}<button class="btn primary" data-act="repr">Kopien anlegen</button>`);
    } else h += sec("Auswählen", `<p class="help">Klicke eine Linie oder Form an, um sie zu verschieben, zu drehen, zu spiegeln oder zu vervielfältigen.</p>`);
  }
  // Vorlage
  h += sec("Vorlage (Foto oder Zeichnung)", App.bgImg ? `
      <label class="row"><input type="checkbox" id="bg-show" ${t.bgShow ? "checked" : ""}> Vorlage zeigen</label>
      <label class="sec"><span>Deckkraft</span><input type="range" id="bg-op" min="5" max="100" value="${Math.round(t.bgOpacity * 100)}"></label>
      <div class="grid2"><button class="btn" data-act="bgrot">Drehen 90°</button><button class="btn" data-act="bgnew">Neue Vorlage</button></div>
      <button class="btn danger" data-act="bgdel">Vorlage entfernen</button>` :
    `<p class="help">Foto einer Fliese oder deine Papierzeichnung laden – sie liegt dann halb durchsichtig unter dem Zeichenbrett zum Nachzeichnen.</p><button class="btn primary" data-act="bgnew">Foto oder Zeichnung laden</button>`);
  // Fliese
  h += sec("Fliese", `<label class="field"><span>Größe (mm)</span><select id="tile-size">${[100, 150, 200, 250, 300].map(v => `<option ${t.size === v ? "selected" : ""}>${v}</option>`).join("")}${[100, 150, 200, 250, 300].includes(t.size) ? "" : `<option selected>${t.size}</option>`}</select></label>
    <button class="btn" data-act="sym">Symmetrie: ${esc(C.GROUPS[t.sym].name)}</button>
    <button class="btn danger" data-act="clear">Alles löschen …</button><div id="clear-confirm"></div>`);
  side.innerHTML = h;
  bindSide();
}
function bindSide() {
  const side = $("#side");
  side.querySelectorAll("input[data-key], select[data-key]").forEach(inp => {
    inp.addEventListener("input", () => {
      const k = inp.dataset.key;
      App.to[k] = inp.type === "number" || inp.type === "range" ? +inp.value : inp.value;
      const lbl = $("#" + k + "-v"); if (lbl) lbl.textContent = App.to[k] + (k === "ratio" || k === "leafW" ? " %" : "");
    });
  });
  side.querySelectorAll("[data-opt]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.opt; App.to[k] = k === "corner" ? b.dataset.val === "1" : b.dataset.val; renderSide();
  }));
  side.querySelectorAll("[data-slot]").forEach(b => b.addEventListener("click", () => { App.to.slot = +b.dataset.slot; renderSide(); }));
  const chk = (id, key, re) => { const el = $("#" + id); if (el) el.addEventListener("change", () => { App.to[key] = el.checked; if (re) renderSide(); }); };
  chk("to-rectCenter", "rectCenter"); chk("to-offsetBoth", "offsetBoth"); chk("to-repFull", "repFull", true);
  const num = (id, fn) => { const el = $("#" + id); if (el) el.addEventListener("change", () => { const v = parseFloat(el.value); if (v > 0) fn(v); }); };
  num("sel-rx", v => edit(() => { selectedShapes()[0].rx = v; }));
  num("sel-ry", v => edit(() => { selectedShapes()[0].ry = v; }));
  num("sel-r", v => edit(() => { selectedShapes()[0].r = v; }));
  const bs = $("#bg-show"); if (bs) bs.addEventListener("change", () => { App.tile.bgShow = bs.checked; renderAll(); scheduleSave(); });
  const bo = $("#bg-op"); if (bo) bo.addEventListener("input", () => { App.tile.bgOpacity = bo.value / 100; renderAll(); scheduleSave(); });
  const ts = $("#tile-size"); if (ts) ts.addEventListener("change", () => resizeTile(+ts.value));
  side.querySelectorAll("[data-act]").forEach(b => b.addEventListener("click", () => sideAction(b.dataset.act)));
}
function sideAction(a) {
  const r90 = C.rotM(Math.PI / 2), r45 = C.rotM(Math.PI / 4);
  switch (a) {
    case "dup": duplicateSel(); break;
    case "del": deleteSel(); break;
    case "mirv": transformSel([-1, 0, 0, 1]); break;
    case "mirh": transformSel([1, 0, 0, -1]); break;
    case "rot90": transformSel(r90); break;
    case "rot45": transformSel(r45); break;
    case "repc": repeatCircular(); break;
    case "repr": repeatRow(); break;
    case "sym": openSymmetry(); break;
    case "bgnew": window.openImport && openImport(); break;
    case "bgdel": removeBackground(); break;
    case "bgrot": rotateBackground(); break;
    case "clear": {
      $("#clear-confirm").innerHTML = `<div class="row" style="margin-top:4px"><span class="help" style="flex:1">Alle Linien dieser Fliese löschen?</span><button class="btn danger" id="clear-yes">Ja, löschen</button></div>`;
      $("#clear-yes").onclick = () => edit(() => { App.tile.shapes = []; App.tile.erasers = []; App.tile.fills = []; App.sel = []; });
      break;
    }
  }
}
function resizeTile(S) {
  const t = App.tile, k = S / t.size;
  edit(() => {
    t.shapes = t.shapes.map(s => ({ ...C.mapShape(s, [k, 0, 0, k], [0, 0]), id: s.id }));
    t.erasers = t.erasers.map(e => ({ x: e.x * k, y: e.y * k }));
    t.fills = t.fills.map(f => ({ ...f, x: f.x * k, y: f.y * k }));
    t.size = S;
  });
  fitView();
}

// ------------------------------------------------------------------ Kopfleiste
function syncTop() {
  const t = App.tile;
  $("#tile-name").value = t.name;
  document.querySelectorAll("#tile-type button").forEach(b => b.setAttribute("aria-pressed", b.dataset.type === t.type));
  $("#btn-sym").innerHTML = symIcon(t.sym, 22) + " Symmetrie: " + esc(C.GROUPS[t.sym].name);
}
function symIcon(g, size = 80) {
  // kleine Vorschau: ein Motiv im Quadrat mit allen Spiegelbildern
  const S = 100, motif = "M18 30 Q28 12 40 22 L34 38 Z";
  const ops = C.GROUPS[g].ops;
  const tf = { id: "", v: "matrix(-1 0 0 1 100 0)", h: "matrix(1 0 0 -1 0 100)", d1: "matrix(0 1 1 0 0 0)", d2: "matrix(0 -1 -1 0 100 100)", r90: "rotate(90 50 50)", r180: "rotate(180 50 50)", r270: "rotate(270 50 50)" };
  const axes = C.groupAxes(g, S).map(([a, b]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="var(--accent)" stroke-width="3" stroke-dasharray="7 5"/>`).join("");
  return `<svg viewBox="-4 -4 108 108" width="${size}" height="${size}" aria-hidden="true"><rect x="0" y="0" width="100" height="100" rx="4" fill="var(--paper)" stroke="currentColor" stroke-width="4"/>${axes}${ops.map((op, i) => `<path d="${motif}" transform="${tf[op]}" fill="${i ? "#6b6e72" : "var(--fg)"}" fill-opacity="${i ? .55 : 1}"/>`).join("")}</svg>`;
}

// ------------------------------------------------------------------ Dialoge (allgemein)
function openModal(html, opts = {}) {
  const m = $("#modal");
  m.innerHTML = `<div class="dialog" style="width:${opts.width || "760px"};${opts.height ? "height:" + opts.height : ""}">${html}</div>`;
  m.hidden = false;
  m.onclick = e => { if (e.target === m && !opts.sticky) closeModal(); };
  m.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
  return m.firstChild;
}
function closeModal() { const m = $("#modal"); m.hidden = true; m.innerHTML = ""; if (window.onModalClose) { const f = window.onModalClose; window.onModalClose = null; f(); } }
let toastTimer = 0;
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms); }

function openSymmetry() {
  const cur = App.tile.sym;
  const d = openModal(`<header><h2>Symmetrie wählen</h2><button class="btn" data-close>Schließen</button></header>
    <div class="body"><p class="help" style="margin:0 0 12px">Was du zeichnest, wird automatisch gespiegelt bzw. gedreht. Die gestrichelten Linien zeigen die Spiegelachsen.</p>
    <div class="sym-grid">${Object.entries(C.GROUPS).map(([k, g]) => `<button class="sym-card" data-sym="${k}" aria-pressed="${k === cur}">${symIcon(k)}<span>${esc(g.name)}</span><span class="help">${esc(g.desc)}</span></button>`).join("")}</div></div>`, { width: "820px" });
  d.querySelectorAll("[data-sym]").forEach(b => b.onclick = () => { const k = b.dataset.sym; closeModal(); if (k !== App.tile.sym) { edit(() => { App.tile.sym = k; }); syncTop(); } });
}

// ------------------------------------------------------------------ Start
function buildToolbar() {
  const nav = $("#tools");
  nav.innerHTML = TOOLS.map(t => t.group ? `<div class="tool-group">${t.group}</div>` :
    `<button class="tool" data-tool="${t.id}" aria-pressed="false" title="${t.name} (Taste ${t.key.toUpperCase()})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[t.id]}</svg>${t.name}</button>`).join("");
  nav.querySelectorAll(".tool").forEach(b => b.onclick = () => setTool(b.dataset.tool));
}
function buildPalettes() {
  $("#palettes").innerHTML = `<span class="label-sm">Farben</span>` + PALETTES.map((p, i) => `<button class="pal" data-pal="${i}" title="${p.name}" aria-pressed="${i === App.palette}">${p.colors.map(c => `<span style="background:${c}"></span>`).join("")}</button>`).join("");
  document.querySelectorAll("[data-pal]").forEach(b => b.onclick = () => {
    App.palette = +b.dataset.pal; buildPalettes(); renderAll(); renderSide();
    try { localStorage.setItem("fa-palette", App.palette); } catch (e) {}
    toast("Palette: " + PALETTES[App.palette].name);
  });
}
function initUI() {
  try { const v = localStorage.getItem("fa-palette"); if (v !== null) App.palette = +v || 0; } catch (e) {}
  buildCanvas(); buildToolbar(); buildPalettes();
  $("#tile-name").addEventListener("change", e => { App.tile.name = e.target.value.trim() || "Fliese"; scheduleSave(); });
  document.querySelectorAll("#tile-type button").forEach(b => b.onclick = () => { edit(() => { App.tile.type = b.dataset.type; }); syncTop(); });
  $("#btn-sym").onclick = openSymmetry;
  $("#btn-undo").onclick = undo; $("#btn-redo").onclick = redo;
  $("#btn-zoom-in").onclick = () => zoomAt(1.25); $("#btn-zoom-out").onclick = () => zoomAt(0.8); $("#btn-fit").onclick = fitView;
  $("#opt-color").onchange = e => { App.opts.color = e.target.checked; renderAll(); };
  $("#opt-thick").onchange = e => { App.opts.thick = e.target.checked; renderLines(); };
  $("#opt-snap").onchange = e => { App.opts.snap = e.target.checked; };
  $("#opt-grid").onchange = e => { App.opts.grid = +e.target.value; App.keyCache = null; renderAll(); };
  updateUndoButtons();
}
function loadTileIntoEditor(tile, bgData) {
  App.tile = tile;
  App.bgImg = bgData || null;
  App.sel = []; App.st = null; App.arr = null; App.arrDirty = true;
  App.hist = { undo: [], redo: [] };
  flatCache = new WeakMap();
  updateUndoButtons();
  syncTop(); renderAll(); renderSide();
  requestAnimationFrame(fitView);
  scheduleArrange(0);
}
