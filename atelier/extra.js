/* Fliesenatelier – Speichern, Bibliothek, Boden-Vorschau, Foto-Import, Export, Start. */
"use strict";

// ------------------------------------------------------------------ Speicher
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code: "timeout" }), ms))]);
const Store = {
  mode: "memory", db: null, uid: null, idb: null,
  async init() {
    try {
      if (window.claude && typeof claude.use === "function") {
        const [db, user] = await Promise.all([claude.use("db"), claude.use("user")]);
        if (db && user) {
          const id = await user.id();
          if (id) { this.db = db; this.uid = id; this.mode = "cloud"; }
        }
      }
    } catch (e) { console.warn(e); }
    if (this.mode !== "cloud") await this.openIDB();
  },
  async openIDB() {
    try {
      this.idb = await new Promise((res, rej) => {
        const r = indexedDB.open("fliesenatelier", 1);
        r.onupgradeneeded = () => { r.result.createObjectStore("tiles"); r.result.createObjectStore("bgs"); };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      this.mode = "local";
    } catch (e) { this.idb = null; this.mode = "memory"; }
  },
  idbOp(store, mode, fn) {
    return new Promise((res, rej) => {
      const tx = this.idb.transaction(store, mode), st = tx.objectStore(store);
      const r = fn(st);
      tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error);
    });
  },
  tiles() { return this.db.doc(`data/users/${this.uid}/store`).collection("tiles"); },
  bgs() { return this.db.doc(`data/users/${this.uid}/store`).collection("bgs"); },
  async fallback(err) {
    console.warn("Speichern im Claude-Konto nicht möglich", err);
    await this.openIDB();
    toast("Im Claude-Konto kann hier nicht gespeichert werden – die Fliesen werden in diesem Browser gespeichert.", 5000);
    for (const t of App.lib) await this.saveTile(t).catch(() => {});
    setSaveState();
  },
  async listTiles() {
    if (this.mode === "cloud") {
      try { const snap = await withTimeout(this.tiles().get(), 12000); return snap.docs.map(d => d.data()).filter(Boolean).map(d => JSON.parse(JSON.stringify(d))); }
      catch (e) { await this.openIDB(); toast("Die gespeicherten Fliesen sind gerade nicht erreichbar – es wird lokal weitergearbeitet.", 5000); }
    }
    if (this.mode === "local") return (await this.idbOp("tiles", "readonly", st => st.getAll())) || [];
    return [];
  },
  async saveTile(t) {
    const doc = JSON.parse(JSON.stringify(t));
    if (JSON.stringify(doc).length > 240000) delete doc.render;
    if (this.mode === "cloud") {
      try { await this.tiles().doc(t.id).set(doc); return; }
      catch (e) { if (["invalid_argument", "not_granted", "revoked", "capability_disabled", "quota_exceeded"].includes(e.code)) { await this.fallback(e); } else throw e; }
    }
    if (this.mode === "local") await this.idbOp("tiles", "readwrite", st => st.put(doc, t.id));
  },
  async deleteTile(id) {
    if (this.mode === "cloud") { await this.tiles().doc(id).delete().catch(() => {}); await this.bgs().doc(id).delete().catch(() => {}); return; }
    if (this.mode === "local") { await this.idbOp("tiles", "readwrite", st => st.delete(id)); await this.idbOp("bgs", "readwrite", st => st.delete(id)); }
  },
  async getBg(id) {
    try {
      if (this.mode === "cloud") { const d = await withTimeout(this.bgs().doc(id).get(), 10000); return d.exists ? d.data().data : null; }
      if (this.mode === "local") { const v = await this.idbOp("bgs", "readonly", st => st.get(id)); return v || null; }
    } catch (e) { console.warn(e); }
    return null;
  },
  async saveBg(id, data) {
    if (this.mode === "cloud") {
      try { if (data) await this.bgs().doc(id).set({ data }); else await this.bgs().doc(id).delete(); return; }
      catch (e) { if (["invalid_argument", "not_granted", "revoked", "quota_exceeded"].includes(e.code)) await this.fallback(e); else throw e; }
    }
    if (this.mode === "local") await this.idbOp("bgs", "readwrite", st => data ? st.put(data, id) : st.delete(id));
  },
};
window.Store = Store;
App.lib = [];

function setSaveState(state) {
  const el = $("#save-state"), tx = $("#save-text");
  el.classList.remove("warn", "busy");
  if (state === "busy") { el.classList.add("busy"); tx.textContent = "Speichert …"; return; }
  if (state === "error") { el.classList.add("warn"); tx.textContent = "Nicht gespeichert – bitte als Datei sichern"; return; }
  if (Store.mode === "cloud") tx.textContent = "Gespeichert im Claude-Konto";
  else if (Store.mode === "local") { el.classList.add("warn"); tx.textContent = "Gespeichert in diesem Browser"; }
  else { el.classList.add("warn"); tx.textContent = "Nur vorübergehend – bitte sichern"; }
}

const d1 = (pts, closed) => pts.length ? "M" + pts.map(p => (Math.round(p[0] * 10) / 10) + " " + (Math.round(p[1] * 10) / 10)).join("L") + (closed ? "Z" : "") : "";
function makeRender(arr) {
  return {
    faces: arr.faces.map(f => ({ d: d1(f.ring, true) + f.holes.map(h => d1(h, true)).join(""), s: f.slot })),
    lines: arr.pieces.filter(p => !p.frame).map(p => d1(p.pts)).join(""),
  };
}
let saveTimer = 0, saving = Promise.resolve();
function scheduleSave(ms = 1200) { clearTimeout(saveTimer); setSaveState("busy"); saveTimer = setTimeout(saveCurrent, ms); }
async function saveCurrent() {
  clearTimeout(saveTimer);
  const t = App.tile;
  if (!t) return;
  try {
    ensureArrangement();
    t.render = makeRender(App.arr);
    delete t.sample;
    const i = App.lib.findIndex(x => x.id === t.id);
    if (i >= 0) App.lib[i] = t; else App.lib.push(t);
    saving = saving.then(() => Store.saveTile(t));
    await saving;
    try { localStorage.setItem("fa-last", t.id); } catch (e) {}
    setSaveState();
  } catch (e) { console.error(e); setSaveState("error"); }
}

// ------------------------------------------------------------------ Vorschaubilder
function tileArt(t, pal, opts = {}) {
  const S = t.size, colors = PALETTES[pal].colors;
  let faces = "", lines = "";
  if (t.render) {
    faces = t.render.faces.filter(f => f.s).map(f => `<path d="${f.d}" fill="${colors[f.s]}" fill-rule="evenodd"/>`).join("");
    lines = t.render.lines;
  } else lines = Core.tilePolylines(t).map(pl => Core.ptsToD(pl)).join("");
  const lw = opts.lw ?? S / 160;
  return `<rect width="${S}" height="${S}" fill="${colors[0]}"/>${faces}${opts.noLines ? "" : `<path d="${lines}" fill="none" stroke="#202225" stroke-width="${lw}" stroke-linejoin="round" stroke-opacity="${opts.lineOpacity ?? 1}"/>`}<rect width="${S}" height="${S}" fill="none" stroke="#202225" stroke-width="${lw * 1.5}"/>`;
}
const thumb = (t, pal = App.palette) => `<svg viewBox="0 0 ${t.size} ${t.size}" aria-hidden="true">${tileArt(t, pal)}</svg>`;

// ------------------------------------------------------------------ Bibliothek
async function openTile(id) {
  await saveCurrent();
  const t = App.lib.find(x => x.id === id);
  if (!t) return;
  const bg = await Store.getBg(id);
  loadTileIntoEditor(JSON.parse(JSON.stringify(t)), bg);
  setTool("select");
  try { localStorage.setItem("fa-last", id); } catch (e) {}
}
async function createTile(type) {
  await saveCurrent();
  const names = { mitte: "Neue Mittelfliese", rand: "Neue Randfliese", ecke: "Neue Eckfliese" };
  const t = newTile(type, names[type]);
  App.lib.push(t);
  loadTileIntoEditor(t, null);
  setTool("select");
  await saveCurrent();
  return t;
}
function openLibrary() {
  const groups = { mitte: "Mittelfliesen", rand: "Randfliesen", ecke: "Eckfliesen" };
  const fmtDate = ts => new Date(ts || Date.now()).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  let body = "";
  for (const k of ["mitte", "rand", "ecke"]) {
    const list = App.lib.filter(t => t.type === k).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    body += `<h3 class="lib-section label-sm">${groups[k]} (${list.length})</h3>`;
    body += list.length ? `<div class="lib-grid">${list.map(t => `
      <div class="lib-card ${t.id === App.tile.id ? "current" : ""}" data-id="${t.id}" role="button" tabindex="0" aria-label="${esc(t.name)} öffnen">
        ${thumb(t)}
        <span class="name">${esc(t.name)}</span>
        <span class="help">${fmtDate(t.updated)}${t.id === App.tile.id ? " · geöffnet" : ""}</span>
        <div class="row" style="gap:4px"><button class="btn" data-dup="${t.id}" style="padding:3px 8px">Kopie</button><button class="btn danger" data-del="${t.id}" style="padding:3px 8px">Löschen</button></div>
      </div>`).join("")}</div>` : `<p class="help">Noch keine ${groups[k]}.</p>`;
  }
  const where = Store.mode === "cloud" ? "Deine Fliesen werden automatisch in deinem Claude-Konto gespeichert." :
    Store.mode === "local" ? "Deine Fliesen werden in diesem Browser gespeichert. Sichere die Bibliothek ab und zu als Datei auf deinem PC." :
      "Speichern ist hier nicht möglich – sichere die Bibliothek als Datei.";
  const d = openModal(`<header><h2>Bibliothek</h2><button class="btn" data-close>Schließen</button></header>
    <div class="body">
      <div class="row" style="margin-bottom:6px">
        <button class="btn primary" data-new="mitte">+ Mittelfliese</button>
        <button class="btn primary" data-new="rand">+ Randfliese</button>
        <button class="btn primary" data-new="ecke">+ Eckfliese</button>
        <button class="btn" id="lib-photo">+ Neue Fliese aus Foto</button>
      </div>
      ${body}
    </div>
    <footer><span class="help" style="flex:1;align-self:center">${where}</span>
      <button class="btn" id="lib-load">Datei laden …</button>
      <button class="btn" id="lib-save">Bibliothek als Datei sichern</button></footer>`, { width: "980px", height: "86vh" });
  d.querySelectorAll(".lib-card").forEach(c => {
    const open = () => { closeModal(); openTile(c.dataset.id); };
    c.addEventListener("click", e => { if (!e.target.closest("button")) open(); });
    c.addEventListener("keydown", e => { if (e.key === "Enter") open(); });
  });
  d.querySelectorAll("[data-new]").forEach(b => b.onclick = () => { closeModal(); createTile(b.dataset.new); });
  d.querySelectorAll("[data-dup]").forEach(b => b.onclick = async () => {
    await saveCurrent();
    const src = App.lib.find(t => t.id === b.dataset.dup);
    const copy = { ...JSON.parse(JSON.stringify(src)), id: Core.uid("t"), name: src.name + " (Kopie)", updated: Date.now(), created: Date.now() };
    App.lib.push(copy); await Store.saveTile(copy);
    const bg = await Store.getBg(src.id); if (bg) await Store.saveBg(copy.id, bg);
    openLibrary();
  });
  d.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => {
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Wirklich?"; return; }
    const id = b.dataset.del;
    await Store.deleteTile(id);
    App.lib = App.lib.filter(t => t.id !== id);
    if (App.tile.id === id) {
      const next = App.lib[0];
      if (next) { const bg = await Store.getBg(next.id); loadTileIntoEditor(JSON.parse(JSON.stringify(next)), bg); }
      else { const t = newTile("mitte"); App.lib.push(t); loadTileIntoEditor(t, null); await saveCurrent(); }
    }
    openLibrary();
  });
  $("#lib-photo").onclick = async () => { closeModal(); await createTile("mitte"); openImport(); };
  $("#lib-save").onclick = exportLibrary;
  $("#lib-load").onclick = () => $("#file-json").click();
}
async function exportLibrary() {
  await saveCurrent();
  const bgs = {};
  for (const t of App.lib) { const b = await Store.getBg(t.id); if (b) bgs[t.id] = b; }
  const data = JSON.stringify({ format: "fliesenatelier-bibliothek/1", saved: new Date().toISOString(), tiles: App.lib, bgs });
  const date = new Date().toISOString().slice(0, 10);
  await saveFile(`Fliesen-Bibliothek ${date}.json`, new Blob([data], { type: "application/json" }));
}
$("#file-json").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    let tiles = [], bgs = {};
    if (data.format === "fliesenatelier-bibliothek/1") { tiles = data.tiles; bgs = data.bgs || {}; }
    else if (data.format === "fliesenatelier/1") { tiles = [data.tile]; if (data.bg) bgs[data.tile.id] = data.bg; }
    else throw new Error("Unbekanntes Format");
    let n = 0;
    for (const t of tiles) {
      if (!t || !Array.isArray(t.shapes)) continue;
      const exists = App.lib.some(x => x.id === t.id);
      const nt = { ...t, id: exists ? Core.uid("t") : t.id };
      App.lib.push(nt); await Store.saveTile(nt);
      if (bgs[t.id]) await Store.saveBg(nt.id, bgs[t.id]);
      n++;
    }
    toast(`${n} Fliese(n) geladen`);
    if (!$("#modal").hidden) openLibrary();
  } catch (err) { toast("Die Datei konnte nicht gelesen werden. Ist es eine Fliesenatelier-Datei?", 4500); }
});

// ------------------------------------------------------------------ Boden-Vorschau
let floorCfg = { w: 6, h: 6, mid: null, mid2: null, rand: "", ecke: "", layout: "gleich", rot: 0, grout: true };
try { Object.assign(floorCfg, JSON.parse(localStorage.getItem("fa-floor") || "{}")); } catch (e) {}
async function openFloor() {
  ensureArrangement();
  App.tile.render = makeRender(App.arr);
  const i = App.lib.findIndex(x => x.id === App.tile.id); if (i >= 0) App.lib[i] = App.tile; else App.lib.push(App.tile);
  const by = k => App.lib.filter(t => t.type === k);
  if (!floorCfg.mid || !App.lib.some(t => t.id === floorCfg.mid)) floorCfg.mid = (by("mitte")[0] || App.lib[0] || {}).id;
  if (App.tile.type === "mitte") floorCfg.mid = floorCfg.mid || App.tile.id;
  const opt = (list, cur, none) => (none ? `<option value="">${none}</option>` : "") + list.map(t => `<option value="${t.id}" ${t.id === cur ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  const d = openModal(`<header><h2>Boden-Vorschau</h2><button class="btn" id="floor-jpg">Als Bild speichern</button><button class="btn" data-close>Schließen</button></header>
    <div class="body" style="flex:1;display:flex;min-height:0"><div id="floor-wrap" style="flex:1">
      <div class="sec" style="overflow:auto">
        <div class="grid2"><label class="field" style="grid-template-columns:1fr"><span>Fliesen breit</span><input type="number" id="fl-w" min="1" max="20" value="${floorCfg.w}"></label>
        <label class="field" style="grid-template-columns:1fr"><span>Fliesen hoch</span><input type="number" id="fl-h" min="1" max="20" value="${floorCfg.h}"></label></div>
        <label class="field" style="grid-template-columns:1fr"><span>Mittelfliese</span><select id="fl-mid">${opt(by("mitte").length ? by("mitte") : App.lib, floorCfg.mid)}</select></label>
        <label class="field" style="grid-template-columns:1fr"><span>Verlegung der Mitte</span><select id="fl-layout">
          ${[["gleich", "Alle gleich"], ["rosette", "Rosette (je 4 gedreht)"], ["schach", "Schachbrett mit 2. Fliese"], ["zufall", "Zufällig gedreht"]].map(([k, n]) => `<option value="${k}" ${floorCfg.layout === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="field" style="grid-template-columns:1fr" ${floorCfg.layout === "schach" ? "" : "hidden"} id="fl-mid2-wrap"><span>2. Mittelfliese</span><select id="fl-mid2">${opt(by("mitte").length ? by("mitte") : App.lib, floorCfg.mid2 || floorCfg.mid)}</select></label>
        <button class="btn" id="fl-rot">Mitte drehen ↻</button>
        <label class="field" style="grid-template-columns:1fr"><span>Randfliese</span><select id="fl-rand">${opt(by("rand"), floorCfg.rand, "– kein Rand –")}</select></label>
        <label class="field" style="grid-template-columns:1fr"><span>Eckfliese</span><select id="fl-ecke">${opt(by("ecke"), floorCfg.ecke, "– keine Ecke –")}</select></label>
        <label class="row"><input type="checkbox" id="fl-grout" ${floorCfg.grout ? "checked" : ""}> Fugen zeigen</label>
        <div class="sec"><span class="label-sm">Farbpalette</span><div class="palettes" id="fl-pal" style="flex-wrap:wrap"></div></div>
        <p class="help">Randfliesen werden so gedreht, dass ihre Außenkante (unten gezeichnet) immer nach außen zeigt. Eckfliesen ebenso (Ecke unten links gezeichnet).</p>
      </div>
      <svg id="floor-svg" xmlns="http://www.w3.org/2000/svg"></svg>
    </div></div>`, { width: "min(1300px, 96vw)", height: "92vh" });
  const rerender = () => { try { localStorage.setItem("fa-floor", JSON.stringify(floorCfg)); } catch (e) {} drawFloor(); };
  const bind = (id, key, num) => $("#" + id).addEventListener("change", e => { floorCfg[key] = num ? Core.clamp(+e.target.value || 1, 1, 20) : e.target.value; if (key === "layout") $("#fl-mid2-wrap").hidden = e.target.value !== "schach"; rerender(); });
  bind("fl-w", "w", true); bind("fl-h", "h", true); bind("fl-mid", "mid"); bind("fl-mid2", "mid2"); bind("fl-layout", "layout"); bind("fl-rand", "rand"); bind("fl-ecke", "ecke");
  $("#fl-grout").onchange = e => { floorCfg.grout = e.target.checked; rerender(); };
  $("#fl-rot").onclick = () => { floorCfg.rot = (floorCfg.rot + 90) % 360; rerender(); };
  const palRow = () => {
    $("#fl-pal").innerHTML = PALETTES.map((p, i) => `<button class="pal" data-fp="${i}" title="${p.name}" aria-pressed="${i === App.palette}">${p.colors.map(c => `<span style="background:${c}"></span>`).join("")}</button>`).join("");
    document.querySelectorAll("[data-fp]").forEach(b => b.onclick = () => { App.palette = +b.dataset.fp; buildPalettes(); renderAll(); palRow(); drawFloor(); });
  };
  palRow();
  $("#floor-jpg").onclick = saveFloorJpg;
  drawFloor();
}
function floorLayout() {
  const c = floorCfg, W = c.w, H = c.h, cells = [];
  const get = id => App.lib.find(t => t.id === id);
  const mid = get(c.mid), mid2 = get(c.mid2) || mid, rand = get(c.rand), ecke = get(c.ecke);
  const border = !!rand && W >= 3 && H >= 3;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let tile = mid, rot = 0;
    const L = x === 0, R = x === W - 1, T = y === 0, B = y === H - 1;
    if (border && (L || R || T || B)) {
      if ((L || R) && (T || B)) { tile = ecke || rand; rot = ecke ? (L && B ? 0 : L && T ? 90 : R && T ? 180 : 270) : (B ? 0 : 180); }
      else { tile = rand; rot = B ? 0 : L ? 90 : T ? 180 : 270; }
    } else {
      const ix = border ? x - 1 : x, iy = border ? y - 1 : y;
      if (c.layout === "rosette") rot = [[0, 90], [270, 180]][iy % 2][ix % 2];
      if (c.layout === "schach" && (ix + iy) % 2) tile = mid2;
      if (c.layout === "zufall") rot = Math.floor(rnd() * 4) * 90;
      rot = (rot + c.rot) % 360;
    }
    cells.push({ x, y, tile, rot });
  }
  return cells;
}
function floorSVGString(cellPx = 100) {
  const c = floorCfg, cells = floorLayout(), gap = c.grout ? cellPx * 0.03 : 0, step = cellPx + gap;
  const used = [...new Set(cells.map(x => x.tile).filter(Boolean))];
  const defs = used.map(t => `<symbol id="fs-${t.id}" viewBox="0 0 ${t.size} ${t.size}">${tileArt(t, App.palette, { noLines: true })}</symbol>`).join("");
  const W = c.w * step - gap, H = c.h * step - gap;
  const items = cells.map(cl => cl.tile ? `<use href="#fs-${cl.tile.id}" x="${cl.x * step}" y="${cl.y * step}" width="${cellPx}" height="${cellPx}" transform="rotate(${cl.rot} ${cl.x * step + cellPx / 2} ${cl.y * step + cellPx / 2})"/>` : "").join("");
  return { svg: `<defs>${defs}</defs><rect x="${-gap}" y="${-gap}" width="${W + gap * 2}" height="${H + gap * 2}" fill="#b9b5ae"/>${items}`, W, H, gap };
}
function drawFloor() {
  const el = $("#floor-svg"); if (!el) return;
  const r = floorSVGString(100);
  el.setAttribute("viewBox", `${-10} ${-10} ${r.W + 20} ${r.H + 20}`);
  el.innerHTML = r.svg;
}
async function svgToCanvas(svgStr, w, h) {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml" }));
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);
  return cv;
}
async function saveFloorJpg() {
  const r = floorSVGString(300);
  const k = Math.min(1, 4000 / Math.max(r.W, r.H));
  const s = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${r.W} ${r.H}" width="${r.W * k}" height="${r.H * k}">${r.svg}</svg>`;
  const cv = await svgToCanvas(s, Math.round(r.W * k), Math.round(r.H * k));
  const blob = await new Promise(res => cv.toBlob(res, "image/jpeg", 0.9));
  await saveFile(`Boden ${floorCfg.w}x${floorCfg.h} – ${App.tile.name}.jpg`, blob);
}

// ------------------------------------------------------------------ Datei speichern
const inClaude = () => !!(window.claude && typeof window.claude.use === "function");
async function browserDownload(name, blob) {
  // Außerhalb von Claude (eigene HTML-Datei auf dem PC)
  if (window.showSaveFilePicker) {
    // Chrome/Edge: normales "Speichern unter"-Fenster, merkt sich den zuletzt gewählten Ordner
    const ext = name.split(".").pop().toLowerCase();
    const types = { pdf: ["PDF-Datei", "application/pdf"], svg: ["SVG-Datei", "image/svg+xml"], jpg: ["JPG-Bild", "image/jpeg"], json: ["Sicherungsdatei", "application/json"] };
    try {
      const t = types[ext];
      const h = await showSaveFilePicker({ suggestedName: name, id: "fliesenatelier", types: t ? [{ description: t[0], accept: { [t[1]]: ["." + ext] } }] : undefined });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      toast("Gespeichert: " + h.name);
      return true;
    } catch (e) {
      if (e && e.name === "AbortError") return false;
      console.warn("Speichern-Dialog nicht verfügbar, normaler Download", e);
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("Gespeichert: " + name + " (Ordner „Downloads“)");
  return true;
}
async function saveFile(name, blob) {
  name = name.replace(/[\\/:*?"<>|]/g, "-").replace(/[–—]/g, "-");
  if (!inClaude()) return browserDownload(name, blob);
  let dl = null;
  try { dl = await claude.use("downloads"); } catch (e) {}
  if (!dl) { toast("In dieser Ansicht kann Claude keine Dateien speichern. Nutze die Datei „Fliesenatelier.html“ auf dem PC.", 6000); return false; }
  try { await dl.save({ filename: name, data: blob }); toast("Gespeichert: " + name); return true; }
  catch (e) { if (e && e.code === "declined") return false; toast("Die Datei konnte nicht gespeichert werden (" + (e && e.code || "Fehler") + ").", 4500); return false; }
}

// ------------------------------------------------------------------ Export
function tileCanvas(tile, arr, pxSize, withLines = true) {
  const S = tile.size, k = pxSize / S, cv = document.createElement("canvas");
  cv.width = cv.height = pxSize;
  const ctx = cv.getContext("2d"), pal = PALETTES[App.palette].colors;
  ctx.fillStyle = pal[0]; ctx.fillRect(0, 0, pxSize, pxSize);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  for (const f of arr.faces) if (f.slot) { ctx.fillStyle = pal[f.slot]; ctx.fill(new Path2D(Core.faceD(f)), "evenodd"); }
  if (withLines) {
    ctx.strokeStyle = "#1e2023"; ctx.lineWidth = 0.6; ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.stroke(new Path2D(arr.pieces.map(p => Core.ptsToD(p.pts)).join("")));
  }
  return cv;
}
function exportData(tile) {
  return { format: "fliesenatelier/1", name: tile.name, type: tile.type, size: tile.size, sym: tile.sym, shapes: tile.shapes, erasers: tile.erasers, fills: tile.fills };
}
async function exportPDF() {
  const arr = ensureArrangement(), t = App.tile, S = t.size, m = 15;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: [S + 2 * m, S + 2 * m + 12], orientation: "portrait", compress: true });
  doc.setProperties({ title: t.name, subject: "Fliesenatelier – Trennlinien 1:1 in Millimetern", creator: "Fliesenatelier", keywords: `fliesenatelier;typ=${t.type};groesse=${S};symmetrie=${t.sym}` });
  doc.setLineWidth(0.25); doc.setDrawColor(0, 0, 0); doc.setLineCap("round"); doc.setLineJoin("round");
  for (const pc of arr.pieces) {
    if (pc.frame) continue;
    const pts = pc.pts, deltas = [];
    for (let i = 1; i < pts.length; i++) deltas.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    doc.lines(deltas, pts[0][0] + m, pts[0][1] + m, [1, 1], "S", false);
  }
  doc.setLineWidth(0.35); doc.rect(m, m, S, S, "S");
  doc.setFontSize(9); doc.setTextColor(60);
  doc.text(`${t.name}  ·  ${TYPE_NAMES[t.type]}fliese  ·  ${S} × ${S} mm  ·  Maßstab 1:1  ·  Symmetrie: ${Core.GROUPS[t.sym].name}`, m, m + S + 8);
  doc.addPage([S + 2 * m, S + 2 * m + 12], "portrait");
  const cv = tileCanvas(t, arr, 1600, true);
  doc.addImage(cv.toDataURL("image/jpeg", 0.88), "JPEG", m, m, S, S);
  doc.text(`Farbvorschau – Palette „${PALETTES[App.palette].name}“`, m, m + S + 8);
  await saveFile(`${t.name}.pdf`, doc.output("blob"));
}
async function exportSVG() {
  const arr = ensureArrangement(), t = App.tile, S = t.size;
  const lines = arr.pieces.filter(p => !p.frame).map(p => Core.ptsToD(p.pts)).join("");
  const meta = JSON.stringify(exportData(t)).replace(/]]>/g, "]]]]><![CDATA[>");
  const s = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${S}mm" height="${S}mm" viewBox="0 0 ${S} ${S}">
<title>${esc(t.name)}</title>
<metadata id="fliesenatelier"><![CDATA[${meta}]]></metadata>
<rect id="rahmen" x="0" y="0" width="${S}" height="${S}" fill="none" stroke="#000" stroke-width="0.3"/>
<path id="trennlinien" d="${lines}" fill="none" stroke="#000" stroke-width="0.3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  await saveFile(`${t.name}.svg`, new Blob([s], { type: "image/svg+xml" }));
}
async function exportJPG() {
  const arr = ensureArrangement();
  const cv = tileCanvas(App.tile, arr, 2000, true);
  const blob = await new Promise(res => cv.toBlob(res, "image/jpeg", 0.92));
  await saveFile(`${App.tile.name}.jpg`, blob);
}
async function exportTileJSON() {
  await saveCurrent();
  const bg = App.bgImg;
  const data = JSON.stringify({ format: "fliesenatelier/1", tile: App.tile, bg });
  await saveFile(`${App.tile.name}.json`, new Blob([data], { type: "application/json" }));
}
function openExportMenu(btn) {
  closeMenu();
  const r = btn.getBoundingClientRect();
  const m = document.createElement("div");
  m.className = "menu"; m.id = "export-menu";
  m.style.top = (r.bottom + 6) + "px"; m.style.right = Math.max(8, innerWidth - r.right) + "px";
  m.innerHTML = `
    <button data-x="pdf">PDF – Linien im Maßstab 1:1<small>Für die Schablonen-Software und zum Ausdrucken</small></button>
    <button data-x="svg">SVG – Linien als Vektordatei<small>Die genaueste Datei für die Weiterverarbeitung</small></button>
    <button data-x="jpg">JPG – Bild in Farbe<small>Zum Zeigen und Verschicken</small></button>
    <button data-x="json">Fliese als Sicherungsdatei<small>Mit Vorlage, zum späteren Weiterbearbeiten</small></button>`;
  document.body.appendChild(m);
  m.querySelectorAll("[data-x]").forEach(b => b.onclick = () => { closeMenu(); ({ pdf: exportPDF, svg: exportSVG, jpg: exportJPG, json: exportTileJSON })[b.dataset.x](); });
  setTimeout(() => document.addEventListener("pointerdown", menuAway), 0);
}
function menuAway(e) { if (!e.target.closest("#export-menu")) closeMenu(); }
function closeMenu() { const m = $("#export-menu"); if (m) m.remove(); document.removeEventListener("pointerdown", menuAway); }

// ------------------------------------------------------------------ Foto-Import
let cvPromise = null;
function loadOpenCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
    s.async = true;
    s.onload = async () => {
      try {
        const cv = window.cv;
        if (!cv) throw new Error("OpenCV fehlt");
        if (!cv.Mat) {
          // Nicht direkt "await cv": das Modul ist selbst "then-fähig" und würde endlos auflösen
          await new Promise(r => {
            const t = setInterval(() => { if (window.cv && window.cv.Mat) { clearInterval(t); r(); } }, 100);
            const prev = cv.onRuntimeInitialized;
            cv.onRuntimeInitialized = () => { if (prev) prev(); clearInterval(t); r(); };
          });
        }
        res({ cv: window.cv });
      } catch (e) { rej(e); }
    };
    s.onerror = () => rej(new Error("OpenCV konnte nicht geladen werden"));
    document.head.appendChild(s);
    setTimeout(() => rej(new Error("Zeitüberschreitung")), 60000);
  });
  cvPromise.catch(() => { cvPromise = null; });
  return cvPromise;
}
function detectTiles(cv, canvas) {
  const W = canvas.width, H = canvas.height, quads = [];
  const src = cv.imread(canvas), gray = new cv.Mat(), blur = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  const minArea = W * H * 0.015;
  const collect = bin => {
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      if (cv.contourArea(c) >= minArea) {
        const peri = cv.arcLength(c, true);
        for (const f of [0.02, 0.035]) {
          const ap = new cv.Mat();
          cv.approxPolyDP(c, ap, f * peri, true);
          if (ap.rows === 4 && cv.isContourConvex(ap)) {
            const q = []; for (let k = 0; k < 4; k++) q.push([ap.data32S[k * 2], ap.data32S[k * 2 + 1]]);
            quads.push(Core.orderQuad(q)); ap.delete(); break;
          }
          ap.delete();
        }
      }
      c.delete();
    }
    contours.delete(); hier.delete();
  };
  const tmp = new cv.Mat(), k3 = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.Canny(blur, tmp, 40, 120); cv.dilate(tmp, tmp, k3); collect(tmp);
  cv.adaptiveThreshold(blur, tmp, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 7); collect(tmp);
  cv.threshold(blur, tmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); collect(tmp);
  cv.threshold(blur, tmp, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU); collect(tmp);
  [src, gray, blur, tmp, k3].forEach(mm => mm.delete());
  // bewerten
  const diag = Math.hypot(W, H);
  const scored = quads.map(q => {
    const side = i => Core.dist(q[i], q[(i + 1) % 4]);
    const w = (side(0) + side(2)) / 2, h = (side(1) + side(3)) / 2;
    const sq = Math.min(w, h) / Math.max(w, h);
    let ang = 1;
    for (let i = 0; i < 4; i++) {
      const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
      const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const sin = Math.abs(v1[0] * v2[1] - v1[1] * v2[0]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
      ang = Math.min(ang, sin);
    }
    const area = Math.abs(Core.ringArea(q)) / (W * H);
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    const cent = 1 - 0.5 * Math.hypot(cx - W / 2, cy - H / 2) / (diag / 2);
    const edge = q.some(p => p[0] < 3 || p[1] < 3 || p[0] > W - 4 || p[1] > H - 4) ? 0.5 : 1;
    return { q, score: Math.sqrt(area) * sq * sq * ang * cent * edge, sq, area, cx, cy };
  }).filter(s => s.sq > 0.6 && s.area < 0.985).sort((a, b) => b.score - a.score);
  // Liegt ein Viereck ziemlich formatfüllend in einem anderen (gezeichneter Rahmen auf Papier,
  // Fliese mit Fuge), ist meist das innere gemeint.
  for (const a of scored) for (const b of scored) {
    if (a === b || a.area >= b.area) continue;
    const ratio = a.area / b.area;
    if (ratio > 0.35 && ratio < 0.9 && a.q.every(p => Core.pointInRing(p, b.q))) a.score *= 1.7;
  }
  scored.sort((x, y) => y.score - x.score);
  const out = [];
  for (const s of scored) {
    if (out.some(o => Math.hypot(o.cx - s.cx, o.cy - s.cy) < diag * 0.03 && Math.min(o.area, s.area) / Math.max(o.area, s.area) > 0.8)) continue;
    out.push(s);
    if (out.length >= 8) break;
  }
  return out.map(s => s.q);
}
function openImport() { $("#file-img").click(); }
window.openImport = openImport;
$("#file-img").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const img = new Image();
  const url = URL.createObjectURL(f);
  try { await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; }); }
  catch (err) { toast("Das Bild konnte nicht geöffnet werden."); return; }
  const k = Math.min(1, 2400 / Math.max(img.width, img.height));
  const work = document.createElement("canvas");
  work.width = Math.round(img.width * k); work.height = Math.round(img.height * k);
  work.getContext("2d").drawImage(img, 0, 0, work.width, work.height);
  URL.revokeObjectURL(url);
  importDialog(work);
});
function importDialog(work) {
  const W = work.width, H = work.height;
  const maxW = Math.min(innerWidth * 0.92, 1100) - 40, maxH = innerHeight * 0.92 - 190;
  const ds = Math.min(maxW / W, maxH / H, 1);
  const dw = Math.round(W * ds), dh = Math.round(H * ds);
  let quad = [[W * .1, H * .1], [W * .9, H * .1], [W * .9, H * .9], [W * .1, H * .9]];
  let cands = [], ci = 0;
  const d = openModal(`<header><h2>Fliese im Bild finden</h2><button class="btn" data-close>Abbrechen</button></header>
    <div class="body" style="display:flex;flex-direction:column;gap:10px;align-items:center">
      <p class="help" id="imp-msg" style="align-self:stretch;font-size:14px">Die Fliese wird gesucht … (beim ersten Mal wird die Bilderkennung geladen, das kann einen Moment dauern)</p>
      <div class="import-stage" style="width:${dw}px;height:${dh}px">
        <canvas id="imp-cv" width="${dw}" height="${dh}"></canvas>
        <svg id="imp-svg" viewBox="0 0 ${dw} ${dh}" width="${dw}" height="${dh}"></svg>
      </div>
    </div>
    <footer><button class="btn" id="imp-next" hidden>Andere Fliese zeigen</button><span class="spacer"></span><button class="btn primary" id="imp-ok">Ja, das ist die Fliese</button></footer>`, { width: Math.max(dw + 40, 520) + "px", sticky: true });
  const cvs = $("#imp-cv"); cvs.getContext("2d").drawImage(work, 0, 0, dw, dh);
  const ov = $("#imp-svg");
  const draw = () => {
    const P = quad.map(p => [p[0] * ds, p[1] * ds]);
    ov.innerHTML = `<defs><mask id="imp-mask"><rect width="${dw}" height="${dh}" fill="#fff"/><polygon points="${P.map(p => p.join(",")).join(" ")}" fill="#000"/></mask></defs>
      <rect width="${dw}" height="${dh}" fill="#000" fill-opacity=".45" mask="url(#imp-mask)"/>
      <polygon points="${P.map(p => p.join(",")).join(" ")}" fill="none" stroke="#e8b84a" stroke-width="3"/>
      ${P.map((p, i) => `<circle data-h="${i}" cx="${p[0]}" cy="${p[1]}" r="11" fill="#e8b84a" fill-opacity=".85" stroke="#111" stroke-width="2" style="cursor:grab"/>`).join("")}`;
  };
  draw();
  let drag = -1;
  ov.addEventListener("pointerdown", e => { const h = e.target.getAttribute && e.target.getAttribute("data-h"); if (h !== null) { drag = +h; ov.setPointerCapture(e.pointerId); } });
  ov.addEventListener("pointermove", e => {
    if (drag < 0) return;
    const r = ov.getBoundingClientRect();
    quad[drag] = [Core.clamp((e.clientX - r.left) / ds, 0, W), Core.clamp((e.clientY - r.top) / ds, 0, H)];
    draw();
  });
  ov.addEventListener("pointerup", () => { drag = -1; });
  $("#imp-next").onclick = () => { ci = (ci + 1) % cands.length; quad = cands[ci].map(p => p.slice()); draw(); $("#imp-msg").textContent = `Vorschlag ${ci + 1} von ${cands.length}. Ist das die richtige Fliese?`; };
  $("#imp-ok").onclick = async () => {
    const q = Core.orderQuad(quad);
    $("#imp-ok").disabled = true; $("#imp-msg").textContent = "Fliese wird entzerrt …";
    await new Promise(r => setTimeout(r, 30));
    const sq = Core.warpToSquare(work, q, 1000);
    let data = "", qual = 0.85;
    do { data = sq.toDataURL("image/jpeg", qual); qual -= 0.1; } while (data.length > 230000 && qual > 0.3);
    closeModal();
    await setBackground(data);
    toast("Vorlage gesetzt – jetzt kannst du darauf nachzeichnen.");
  };
  // Erkennung
  loadOpenCV().then(({ cv }) => {
    const k = Math.min(1, 1000 / Math.max(W, H));
    const small = document.createElement("canvas");
    small.width = Math.round(W * k); small.height = Math.round(H * k);
    small.getContext("2d").drawImage(work, 0, 0, small.width, small.height);
    let found = [];
    try { found = detectTiles(cv, small); } catch (err) { console.warn(err); }
    if (!$("#imp-msg")) return;
    cands = found.map(q => q.map(p => [p[0] / k, p[1] / k]));
    if (cands.length) {
      quad = cands[0].map(p => p.slice()); ci = 0; draw();
      $("#imp-msg").innerHTML = "<b>Ist das die Fliese?</b> Wenn nicht ganz: die gelben Ecken mit der Maus auf die Fliesenecken ziehen.";
      $("#imp-next").hidden = cands.length < 2;
    } else $("#imp-msg").innerHTML = "<b>Keine Fliese sicher erkannt.</b> Bitte die vier gelben Ecken auf die Ecken der Fliese ziehen.";
  }).catch(() => {
    if ($("#imp-msg")) $("#imp-msg").innerHTML = "<b>Die automatische Erkennung ist gerade nicht verfügbar.</b> Bitte die vier gelben Ecken auf die Ecken der Fliese ziehen.";
  });
}
async function setBackground(data) {
  App.bgImg = data;
  App.tile.bgShow = true; App.tile.bg = !!data;
  if (data && !App.tile.bgOpacity) App.tile.bgOpacity = 0.5;
  renderAll(); renderSide();
  try { await Store.saveBg(App.tile.id, data); } catch (e) { console.warn(e); }
  scheduleSave();
}
function removeBackground() { setBackground(null); }
async function rotateBackground() {
  if (!App.bgImg) return;
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = App.bgImg; });
  const cv = document.createElement("canvas"); cv.width = img.height; cv.height = img.width;
  const ctx = cv.getContext("2d"); ctx.translate(cv.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(img, 0, 0);
  await setBackground(cv.toDataURL("image/jpeg", 0.85));
}

// ------------------------------------------------------------------ Start
(async function boot() {
  initUI();
  $("#btn-library").onclick = openLibrary;
  $("#btn-floor").onclick = openFloor;
  $("#btn-export").onclick = e => openExportMenu(e.currentTarget);
  const startTile = sampleTile();
  loadTileIntoEditor(startTile, null);
  setTool("select");
  setSaveState("busy");
  await Store.init();
  let lib = [];
  try { lib = await Store.listTiles(); } catch (e) { console.warn(e); }
  App.lib = lib;
  if (!lib.length) {
    App.lib = [startTile];
    await saveCurrent();
  } else {
    let last = null;
    try { last = localStorage.getItem("fa-last"); } catch (e) {}
    const pick = lib.find(t => t.id === last) || lib.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    const bg = await Store.getBg(pick.id);
    loadTileIntoEditor(JSON.parse(JSON.stringify(pick)), bg);
    setTool("select");
  }
  setSaveState();
})();
