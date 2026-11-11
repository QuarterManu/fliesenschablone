/* Fliesenatelier – Geometrie-Kern: Formen, Symmetrie, Flächenaufteilung.
   Koordinaten in Millimetern, Ursprung oben links, y nach unten (wie SVG). */
"use strict";

const Core = (() => {
  const uid = (p = "s") => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const r3 = v => Math.round(v * 1000) / 1000;

  // ------------------------------------------------------------------ Symmetrie
  // Matrizen in zentrierten Koordinaten (u = x - c, v = y - c), y nach unten.
  const OPS = {
    id: [1, 0, 0, 1], v: [-1, 0, 0, 1], h: [1, 0, 0, -1], d1: [0, 1, 1, 0], d2: [0, -1, -1, 0],
    r90: [0, -1, 1, 0], r180: [-1, 0, 0, -1], r270: [0, 1, -1, 0],
  };
  const GROUPS = {
    none: { ops: ["id"], name: "Keine", desc: "Alles wird nur einmal gezeichnet." },
    v: { ops: ["id", "v"], name: "Links ↔ rechts", desc: "Spiegelung an der senkrechten Mittellinie." },
    h: { ops: ["id", "h"], name: "Oben ↔ unten", desc: "Spiegelung an der waagerechten Mittellinie." },
    vh: { ops: ["id", "v", "h", "r180"], name: "Vierfach gespiegelt", desc: "Beide Mittellinien – ein Viertel zeichnen." },
    d1: { ops: ["id", "d1"], name: "Diagonale ╲", desc: "Spiegelung von oben links nach unten rechts." },
    d2: { ops: ["id", "d2"], name: "Diagonale ╱", desc: "Spiegelung von unten links nach oben rechts." },
    dd: { ops: ["id", "d1", "d2", "r180"], name: "Beide Diagonalen", desc: "Spiegelung an beiden Diagonalen." },
    r2: { ops: ["id", "r180"], name: "Halbe Drehung", desc: "Alles wird um 180° gedreht wiederholt." },
    r4: { ops: ["id", "r90", "r180", "r270"], name: "Windrad (4× gedreht)", desc: "Viermal gedreht, ohne Spiegelung." },
    all: { ops: ["id", "v", "h", "d1", "d2", "r90", "r180", "r270"], name: "Kaleidoskop (8×)", desc: "Alle Spiegelungen – ein Achtel zeichnen." },
  };
  function opApply(op, p, S) {
    const m = OPS[op], c = S / 2, u = p[0] - c, v = p[1] - c;
    return [c + m[0] * u + m[1] * v, c + m[2] * u + m[3] * v];
  }
  function opApplyVec(op, d) { const m = OPS[op]; return [m[0] * d[0] + m[1] * d[1], m[2] * d[0] + m[3] * d[1]]; }
  function opInverse(op) {
    const m = OPS[op], t = [m[0], m[2], m[1], m[3]];
    return Object.keys(OPS).find(k => OPS[k].every((x, i) => x === t[i]));
  }
  const opDet = op => { const m = OPS[op]; return m[0] * m[3] - m[1] * m[2]; };
  // Achsen zum Anzeigen
  function groupAxes(g, S) {
    const ax = [];
    const ops = GROUPS[g].ops;
    if (ops.includes("v")) ax.push([[S / 2, 0], [S / 2, S]]);
    if (ops.includes("h")) ax.push([[0, S / 2], [S, S / 2]]);
    if (ops.includes("d1")) ax.push([[0, 0], [S, S]]);
    if (ops.includes("d2")) ax.push([[0, S], [S, 0]]);
    return ax;
  }

  // ------------------------------------------------------------------ Formen
  // line {p:[a,b]} · path {p:[...], c:[ecke?], closed} · poly {p, closed} (gerade Stücke)
  // ellipse {cx,cy,rx,ry,rot} · arc {cx,cy,r,a0,a1} (Winkel im Bogenmaß, im Uhrzeigersinn)
  function cubicPts(p0, c0, c1, p1, n) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n, mt = 1 - t;
      out.push([
        mt * mt * mt * p0[0] + 3 * mt * mt * t * c0[0] + 3 * mt * t * t * c1[0] + t * t * t * p1[0],
        mt * mt * mt * p0[1] + 3 * mt * mt * t * c0[1] + 3 * mt * t * t * c1[1] + t * t * t * p1[1],
      ]);
    }
    return out;
  }
  function pathBeziers(p, c, closed) {
    // Catmull-Rom-ähnlich: runde Punkte bekommen Tangenten, eckige nicht.
    const n = p.length;
    if (n < 2) return [];
    const T = p.map((pt, i) => {
      if (c && c[i]) return [0, 0];
      let prev = p[i - 1], next = p[i + 1];
      if (closed) { prev = p[(i - 1 + n) % n]; next = p[(i + 1) % n]; }
      if (!prev) return [(next[0] - pt[0]) * 0.5, (next[1] - pt[1]) * 0.5];
      if (!next) return [(pt[0] - prev[0]) * 0.5, (pt[1] - prev[1]) * 0.5];
      return [(next[0] - prev[0]) * 0.5, (next[1] - prev[1]) * 0.5];
    });
    const segs = [];
    const m = closed ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % n;
      const a = p[i], b = p[j];
      // Tangenten auf sinnvolle Länge begrenzen
      const L = dist(a, b);
      const scale = (t) => { const l = Math.hypot(t[0], t[1]); return l > L * 1.2 ? [t[0] * L * 1.2 / l, t[1] * L * 1.2 / l] : t; };
      const ta = scale(T[i]), tb = scale(T[j]);
      segs.push([a, [a[0] + ta[0] / 3, a[1] + ta[1] / 3], [b[0] - tb[0] / 3, b[1] - tb[1] / 3], b]);
    }
    return segs;
  }
  function flatten(s, step = 0.5) {
    switch (s.t) {
      case "line": return [s.p.map(q => q.slice())];
      case "poly": {
        const pts = s.p.map(q => q.slice());
        if (s.closed && pts.length > 2) pts.push(pts[0].slice());
        return [pts];
      }
      case "path": {
        const segs = pathBeziers(s.p, s.c, s.closed);
        if (!segs.length) return [];
        const out = [segs[0][0].slice()];
        for (const sg of segs) {
          const L = dist(sg[0], sg[1]) + dist(sg[1], sg[2]) + dist(sg[2], sg[3]);
          const straight = dist(sg[0], sg[1]) < 1e-9 && dist(sg[2], sg[3]) < 1e-9;
          const n = straight ? 1 : Math.max(2, Math.ceil(L / step));
          out.push(...cubicPts(sg[0], sg[1], sg[2], sg[3], n));
        }
        return [out];
      }
      case "ellipse": {
        const per = 2 * Math.PI * Math.sqrt((s.rx * s.rx + s.ry * s.ry) / 2);
        const n = clamp(Math.ceil(per / step), 24, 720);
        const out = [], cr = Math.cos(s.rot || 0), sr = Math.sin(s.rot || 0);
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * 2 * Math.PI, x = s.rx * Math.cos(t), y = s.ry * Math.sin(t);
          out.push([s.cx + x * cr - y * sr, s.cy + x * sr + y * cr]);
        }
        out[n] = out[0].slice();
        return [out];
      }
      case "arc": {
        let sweep = s.a1 - s.a0;
        const n = clamp(Math.ceil(Math.abs(sweep) * s.r / step), 4, 720);
        const out = [];
        for (let i = 0; i <= n; i++) {
          const t = s.a0 + sweep * i / n;
          out.push([s.cx + s.r * Math.cos(t), s.cy + s.r * Math.sin(t)]);
        }
        return [out];
      }
    }
    return [];
  }
  // Punkte, an denen man einrasten kann
  function keyPoints(s) {
    switch (s.t) {
      case "line": return s.p.slice();
      case "path": return s.p.slice();
      case "poly": return s.closed ? [] : [s.p[0], s.p[s.p.length - 1]];
      case "ellipse": {
        const cr = Math.cos(s.rot || 0), sr = Math.sin(s.rot || 0);
        return [[s.cx, s.cy], [s.cx + s.rx * cr, s.cy + s.rx * sr], [s.cx - s.rx * cr, s.cy - s.rx * sr],
          [s.cx - s.ry * sr, s.cy + s.ry * cr], [s.cx + s.ry * sr, s.cy - s.ry * cr]];
      }
      case "arc": return [[s.cx, s.cy], [s.cx + s.r * Math.cos(s.a0), s.cy + s.r * Math.sin(s.a0)], [s.cx + s.r * Math.cos(s.a1), s.cy + s.r * Math.sin(s.a1)]];
    }
    return [];
  }
  // Lineare Abbildung (2x2-Matrix M um Punkt c, danach Verschiebung t) auf eine Form anwenden
  function mapShape(s, M, c, t = [0, 0]) {
    const f = p => [c[0] + M[0] * (p[0] - c[0]) + M[1] * (p[1] - c[1]) + t[0], c[1] + M[2] * (p[0] - c[0]) + M[3] * (p[1] - c[1]) + t[1]];
    const det = M[0] * M[3] - M[1] * M[2];
    const k = Math.sqrt(Math.abs(det));
    const o = JSON.parse(JSON.stringify(s));
    if (o.p) o.p = o.p.map(f);
    if (o.t === "ellipse") {
      const [nx, ny] = f([o.cx, o.cy]);
      const dir = [M[0] * Math.cos(o.rot || 0) + M[1] * Math.sin(o.rot || 0), M[2] * Math.cos(o.rot || 0) + M[3] * Math.sin(o.rot || 0)];
      o.cx = nx; o.cy = ny; o.rx *= k; o.ry *= k; o.rot = Math.atan2(dir[1], dir[0]);
    }
    if (o.t === "arc") {
      const [nx, ny] = f([o.cx, o.cy]);
      const ang = a => { const d = [M[0] * Math.cos(a) + M[1] * Math.sin(a), M[2] * Math.cos(a) + M[3] * Math.sin(a)]; return Math.atan2(d[1], d[0]); };
      let a0 = ang(o.a0), a1 = ang(o.a1);
      const sweep = o.a1 - o.a0;
      // Bogenrichtung erhalten (bei Spiegelung umkehren)
      const sw = det < 0 ? -sweep : sweep;
      o.cx = nx; o.cy = ny; o.r *= k; o.a0 = a0; o.a1 = a0 + sw;
    }
    return o;
  }
  const rotM = a => [Math.cos(a), -Math.sin(a), Math.sin(a), Math.cos(a)];
  const moveShape = (s, dx, dy) => mapShape(s, [1, 0, 0, 1], [0, 0], [dx, dy]);
  function shapeBBox(s) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const pl of flatten(s, 1)) for (const p of pl) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    return [x0, y0, x1, y1];
  }
  function shapeImage(s, op, S) {
    if (op === "id") return s;
    const m = OPS[op];
    return mapShape(s, m, [S / 2, S / 2]);
  }

  // ------------------------------------------------------------------ Hilfsgeometrie
  function distToSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
    t = clamp(t, 0, 1);
    const q = [a[0] + t * dx, a[1] + t * dy];
    return [Math.hypot(p[0] - q[0], p[1] - q[1]), q, t];
  }
  function distToPolyline(p, pts) {
    let best = [Infinity, null, 0];
    for (let i = 0; i < pts.length - 1; i++) {
      const r = distToSeg(p, pts[i], pts[i + 1]);
      if (r[0] < best[0]) best = [r[0], r[1], i + r[2]];
    }
    return best;
  }
  function pointInRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  const pointInFace = (p, f) => pointInRing(p, f.ring) && !f.holes.some(h => pointInRing(p, h));
  function polylineLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; }
  function pointAtLength(pts, d) {
    for (let i = 1; i < pts.length; i++) {
      const L = dist(pts[i - 1], pts[i]);
      if (d <= L) return lerp(pts[i - 1], pts[i], L ? d / L : 0);
      d -= L;
    }
    return pts[pts.length - 1].slice();
  }
  function simplifyRDP(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let md = 0, mi = -1;
      for (let i = a + 1; i < b; i++) { const d = distToSeg(pts[i], pts[a], pts[b])[0]; if (d > md) { md = d; mi = i; } }
      if (md > eps && mi > 0) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; }
  const ptsToD = (pts, closed) => pts.length ? "M" + pts.map(p => r3(p[0]) + " " + r3(p[1])).join("L") + (closed ? "Z" : "") : "";

  // ------------------------------------------------------------------ Flächenaufteilung (JSTS)
  let GF = null, GF_SCALE = 1000;
  function gf() {
    if (!GF) GF = new jsts.geom.GeometryFactory(new jsts.geom.PrecisionModel(GF_SCALE));
    return GF;
  }
  function setScale(k) { if (k !== GF_SCALE) { GF_SCALE = k; GF = null; } }
  const JC = p => new jsts.geom.Coordinate(Math.round(p[0] * GF_SCALE) / GF_SCALE, Math.round(p[1] * GF_SCALE) / GF_SCALE);
  function toLS(pts) {
    const clean = [];
    for (const p of pts) {
      const q = [Math.round(p[0] * GF_SCALE) / GF_SCALE, Math.round(p[1] * GF_SCALE) / GF_SCALE];
      if (!clean.length || clean[clean.length - 1][0] !== q[0] || clean[clean.length - 1][1] !== q[1]) clean.push(q);
    }
    if (clean.length < 2) return null;
    return gf().createLineString(clean.map(p => new jsts.geom.Coordinate(p[0], p[1])));
  }
  // Linien an allen Kreuzungen aufteilen. Bei Rundungsproblemen mit gröberem Raster erneut versuchen.
  function nodeLines(polylines) {
    for (const k of [1000, 250, 50, 10]) {
      setScale(k);
      const lines = polylines.map(toLS).filter(Boolean);
      try { const r = jsts.operation.union.UnaryUnionOp.union(gf().createMultiLineString(lines)); setScale(1000); return { geom: r, scale: k }; }
      catch (e) { console.warn("Aufteilung: neuer Versuch mit Raster 1/" + k, e && e.message); }
    }
    // letzter Ausweg: Linie für Linie, Problemfälle werden ausgelassen
    setScale(10);
    let acc = null;
    for (const pl of polylines) {
      const ls = toLS(pl); if (!ls) continue;
      try { acc = acc ? jsts.operation.union.UnaryUnionOp.union(gf().createGeometryCollection([acc, ls])) : jsts.operation.union.UnaryUnionOp.union(ls); }
      catch (e) { console.warn("Linie ausgelassen", e && e.message); }
    }
    setScale(1000);
    return { geom: acc || gf().createMultiLineString([]), scale: 10 };
  }
  const coordsOf = g => g.getCoordinates().map(c => [c.x, c.y]);

  // Alle Linien einer Fliese (inkl. Spiegelbilder) als Polylinien
  // Liegt Polylinie b vollständig auf Polylinie a? (Spiegelbild, das mit dem Original zusammenfällt)
  function covers(a, b) {
    const n = Math.min(24, b.length);
    for (let k = 0; k < n; k++) {
      const p = b[Math.floor(k * (b.length - 1) / Math.max(1, n - 1))];
      if (distToPolyline(p, a)[0] > 0.02) return false;
    }
    return true;
  }
  function tilePolylines(tile) {
    const S = tile.size, ops = GROUPS[tile.sym].ops, out = [];
    for (const s of tile.shapes) {
      const base = flatten(s);
      const mine = [];
      for (const op of ops) for (const pl of base) {
        const img = op === "id" ? pl : pl.map(p => opApply(op, p, S));
        if (op !== "id" && mine.some(m => covers(m, img) && covers(img, m))) continue;
        mine.push(img);
      }
      out.push(...mine);
    }
    return out;
  }
  function expandPoints(list, tile) {
    const ops = GROUPS[tile.sym].ops, out = [];
    for (const e of list) for (const op of ops) out.push({ ...e, x: opApply(op, [e.x, e.y], tile.size)[0], y: opApply(op, [e.x, e.y], tile.size)[1] });
    return out;
  }

  // ------------------------------------------------------------------ Eigene Flächenaufteilung
  // Linien an allen Kreuzungen teilen, doppelte Stücke zusammenfassen, Flächen ablaufen.
  function planarize(polylines, S) {
    const EPS = 1e-9;
    // 1) Segmente
    const segs = [];
    for (const pl of polylines) for (let i = 0; i < pl.length - 1; i++) {
      const a = pl[i], b = pl[i + 1];
      if (Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7) continue;
      segs.push({ a, b, ts: [] });
    }
    // 2) Schnittpunkte über ein Raster suchen
    const cell = 4, grid = new Map();
    segs.forEach((sg, idx) => {
      const x0 = Math.floor((Math.min(sg.a[0], sg.b[0]) - 0.01) / cell), x1 = Math.floor((Math.max(sg.a[0], sg.b[0]) + 0.01) / cell);
      const y0 = Math.floor((Math.min(sg.a[1], sg.b[1]) - 0.01) / cell), y1 = Math.floor((Math.max(sg.a[1], sg.b[1]) + 0.01) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = x * 100003 + y;
        let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(idx);
      }
    });
    const seen = new Set();
    const TOL = 0.003;
    const segDist = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return [Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]), t]; };
    for (const list of grid.values()) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const A = list[i], B = list[j];
        const key = A < B ? A * 1e7 + B : B * 1e7 + A;
        if (seen.has(key)) continue; seen.add(key);
        const s1 = segs[A], s2 = segs[B];
        if (Math.max(s1.a[0], s1.b[0]) + TOL < Math.min(s2.a[0], s2.b[0]) || Math.max(s2.a[0], s2.b[0]) + TOL < Math.min(s1.a[0], s1.b[0])) continue;
        if (Math.max(s1.a[1], s1.b[1]) + TOL < Math.min(s2.a[1], s2.b[1]) || Math.max(s2.a[1], s2.b[1]) + TOL < Math.min(s1.a[1], s1.b[1])) continue;
        const r = [s1.b[0] - s1.a[0], s1.b[1] - s1.a[1]], q = [s2.b[0] - s2.a[0], s2.b[1] - s2.a[1]];
        const w = [s2.a[0] - s1.a[0], s2.a[1] - s1.a[1]];
        const den = r[0] * q[1] - r[1] * q[0];
        const lr = Math.hypot(r[0], r[1]), lq = Math.hypot(q[0], q[1]);
        let hit = false;
        if (Math.abs(den) > 1e-10 * lr * lq) {
          const t = (w[0] * q[1] - w[1] * q[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
          const et = TOL / lr, eu = TOL / lq;
          if (t > -et && t < 1 + et && u > -eu && u < 1 + eu) { s1.ts.push(Math.max(0, Math.min(1, t))); s2.ts.push(Math.max(0, Math.min(1, u))); hit = true; }
        }
        if (!hit) {
          // Berührung oder Überlappung (auch parallel): Endpunkte, die auf dem anderen Stück liegen
          for (const [p, other, own, ownT] of [[s1.a, s2, s1, 0], [s1.b, s2, s1, 1], [s2.a, s1, s2, 0], [s2.b, s1, s2, 1]]) {
            const [d, t] = segDist(p, other.a, other.b);
            if (d < TOL) { other.ts.push(t); own.ts.push(ownT); }
          }
        }
      }
    }
    // 3) Punkte zusammenfassen
    const verts = [], vgrid = new Map(), VT = 0.002;
    const vid = p => {
      const gx = Math.round(p[0] / VT), gy = Math.round(p[1] / VT);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const l = vgrid.get((gx + dx) * 1000003 + (gy + dy));
        if (l) for (const id of l) if (Math.abs(verts[id][0] - p[0]) <= VT && Math.abs(verts[id][1] - p[1]) <= VT) return id;
      }
      const id = verts.length; verts.push([p[0], p[1]]);
      const k = gx * 1000003 + gy; let l = vgrid.get(k); if (!l) vgrid.set(k, l = []); l.push(id);
      return id;
    };
    // 4) Kanten
    const edges = new Map(); // "u_v" -> [u, v]
    for (const sg of segs) {
      const ts = [0, 1, ...sg.ts].sort((x, y) => x - y);
      let prev = vid(sg.a);
      for (let i = 1; i < ts.length; i++) {
        if (ts[i] - ts[i - 1] < 1e-12 && i < ts.length - 1) continue;
        const t = ts[i];
        const p = t >= 1 ? sg.b : [sg.a[0] + (sg.b[0] - sg.a[0]) * t, sg.a[1] + (sg.b[1] - sg.a[1]) * t];
        const v = vid(p);
        if (v !== prev) { const k = prev < v ? prev + "_" + v : v + "_" + prev; if (!edges.has(k)) edges.set(k, prev < v ? [prev, v] : [v, prev]); }
        prev = v;
      }
    }
    return { verts, edges: [...edges.values()] };
  }
  function chains(verts, edges) {
    // Kanten zwischen Knoten (Grad ≠ 2) zu Linienstücken verbinden
    const adj = verts.map(() => []);
    for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u); }
    const used = new Set(), out = [];
    const ek = (u, v) => u < v ? u * 4194304 + v : v * 4194304 + u;
    const walk = (start, next) => {
      const ids = [start, next]; used.add(ek(start, next));
      let prev = start, cur = next;
      while (adj[cur].length === 2 && cur !== start) {
        const nx = adj[cur][0] === prev ? adj[cur][1] : adj[cur][0];
        if (used.has(ek(cur, nx))) break;
        used.add(ek(cur, nx)); ids.push(nx); prev = cur; cur = nx;
      }
      return ids;
    };
    for (let v = 0; v < verts.length; v++) if (adj[v].length !== 2) for (const n of adj[v]) if (!used.has(ek(v, n))) out.push(walk(v, n));
    for (const [u, v] of edges) if (!used.has(ek(u, v))) out.push(walk(u, v)); // reine Schleifen
    return out;
  }
  function facesOf(verts, edges) {
    const adj = verts.map(() => []);
    for (const [u, v] of edges) { adj[u].push(v); adj[v].push(u); }
    const ang = (u, v) => Math.atan2(verts[v][1] - verts[u][1], verts[v][0] - verts[u][0]);
    adj.forEach((l, u) => l.sort((a, b) => ang(u, a) - ang(u, b)));
    const pos = adj.map(l => { const m = new Map(); l.forEach((v, i) => m.set(v, i)); return m; });
    const visited = new Set(), cycles = [], K = 4194304;
    for (let u = 0; u < verts.length; u++) for (const v0 of adj[u]) {
      if (visited.has(u * K + v0)) continue;
      const ring = []; let a = u, b = v0, guard = 0;
      while (!visited.has(a * K + b) && guard++ < 2000000) {
        visited.add(a * K + b); ring.push(a);
        const l = adj[b], i = pos[b].get(a);
        const c = l[(i - 1 + l.length) % l.length];
        a = b; b = c;
      }
      cycles.push(ring);
    }
    return cycles;
  }

  function arrange(tile) {
    const S = tile.size;
    const polylines = tilePolylines(tile);
    polylines.push([[0, 0], [S, 0], [S, S], [0, S], [0, 0]]);
    const { verts, edges } = planarize(polylines, S);
    const inside = p => p[0] > -0.01 && p[1] > -0.01 && p[0] < S + 0.01 && p[1] < S + 0.01;
    // Linienstücke
    let pieces = chains(verts, edges).map(ids => {
      const pts = ids.map(i => verts[i]);
      const L = polylineLength(pts);
      const mid = pointAtLength(pts, L / 2);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const frame = pts.every(p => Math.min(Math.abs(p[0]), Math.abs(p[1]), Math.abs(S - p[0]), Math.abs(S - p[1])) < 0.01);
      return { ids, pts, mid, len: L, bbox: [x0, y0, x1, y1], frame };
    }).filter(pc => pc.len > 1e-4 && inside(pc.mid));
    // Gelöschte Stücke entfernen
    const erasers = expandPoints(tile.erasers || [], tile);
    pieces = pieces.filter(pc => {
      if (pc.frame) return true;
      for (const e of erasers) {
        const p = [e.x, e.y];
        if (p[0] < pc.bbox[0] - 0.5 || p[0] > pc.bbox[2] + 0.5 || p[1] < pc.bbox[1] - 0.5 || p[1] > pc.bbox[3] + 0.5) continue;
        if (distToPolyline(p, pc.pts)[0] < 0.35 && dist(p, pc.pts[0]) > 0.25 && dist(p, pc.pts[pc.pts.length - 1]) > 0.25) return false;
      }
      return true;
    });
    // Flächen aus den verbleibenden Kanten
    const kept = [];
    for (const pc of pieces) for (let i = 0; i < pc.ids.length - 1; i++) kept.push([pc.ids[i], pc.ids[i + 1]]);
    const cycles = facesOf(verts, kept);
    const faces = [], outers = [];
    for (const cyc of cycles) {
      const ring = cyc.map(i => verts[i]);
      const a = ringArea(ring);
      if (Math.abs(a) < 1e-4) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ring) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const rec = { ring, holes: [], slot: 0, bbox: [x0, y0, x1, y1], area: Math.abs(a), sign: Math.sign(a) };
      (a < 0 ? faces : outers).push(rec);
    }
    // Außenkonturen von Inseln als Löcher der umgebenden Fläche eintragen
    const isFrame = o => o.bbox[0] < 0.01 && o.bbox[1] < 0.01 && o.bbox[2] > S - 0.01 && o.bbox[3] > S - 0.01 && Math.abs(o.area - S * S) < 0.5;
    const facesByArea = faces.slice().sort((x, y) => x.area - y.area);
    for (const o of outers) {
      if (isFrame(o)) continue;
      const p = o.ring[0];
      const host = facesByArea.find(f => f.area > o.area && p[0] >= f.bbox[0] && p[0] <= f.bbox[2] && p[1] >= f.bbox[1] && p[1] <= f.bbox[3] && pointInRing(p, f.ring) && !f.ring.includes(p));
      if (host) host.holes.push(o.ring);
    }
    // Füllfarben zuordnen (kleinste Fläche zuerst)
    const fills = expandPoints(tile.fills || [], tile);
    for (const fl of fills) {
      const p = [fl.x, fl.y];
      const f = facesByArea.find(f => p[0] >= f.bbox[0] && p[0] <= f.bbox[2] && p[1] >= f.bbox[1] && p[1] <= f.bbox[3] && pointInFace(p, f));
      if (f) f.slot = fl.slot;
    }
    const nodeSet = new Map();
    for (const pc of pieces) for (const p of [pc.pts[0], pc.pts[pc.pts.length - 1]]) nodeSet.set(Math.round(p[0] * 20) + ":" + Math.round(p[1] * 20), p);
    return { pieces, faces, nodes: [...nodeSet.values()] };
  }

  function faceD(f) { return ptsToD(f.ring, true) + f.holes.map(h => ptsToD(h, true)).join(""); }

  // ------------------------------------------------------------------ Parallele (Versatz)
  function bufferRing(ring, d) {
    const poly = gf().createPolygon(gf().createLinearRing(ring.map(JC)));
    const bp = new jsts.operation.buffer.BufferParameters(16, jsts.operation.buffer.BufferParameters.CAP_FLAT, jsts.operation.buffer.BufferParameters.JOIN_MITRE, 4);
    const g = jsts.operation.buffer.BufferOp.bufferOp(poly, d, bp);
    const out = [];
    for (let i = 0; i < g.getNumGeometries(); i++) {
      const pg = g.getGeometryN(i);
      if (pg.getGeometryType() !== "Polygon" || pg.isEmpty()) continue;
      out.push(coordsOf(pg.getExteriorRing()));
    }
    return out;
  }
  function offsetPolyline(pts, d) {
    const n = pts.length, out = [];
    const nrm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; return [-dy / L, dx / L]; };
    for (let i = 0; i < n; i++) {
      let nv;
      if (i === 0) nv = nrm(pts[0], pts[1]);
      else if (i === n - 1) nv = nrm(pts[n - 2], pts[n - 1]);
      else {
        const a = nrm(pts[i - 1], pts[i]), b = nrm(pts[i], pts[i + 1]);
        let m = [a[0] + b[0], a[1] + b[1]]; const L = Math.hypot(m[0], m[1]);
        if (L < 1e-6) m = a; else m = [m[0] / L, m[1] / L];
        const cos = m[0] * a[0] + m[1] * a[1];
        const k = 1 / Math.max(cos, 0.3);
        nv = [m[0] * k, m[1] * k];
      }
      out.push([pts[i][0] + nv[0] * d, pts[i][1] + nv[1] * d]);
    }
    return out;
  }
  // Liefert neue Formen für die Parallele zu Form s im Abstand d, auf der Seite des Punktes q
  function offsetShape(s, d, q) {
    if (s.t === "ellipse" && Math.abs(s.rx - s.ry) < 1e-6) {
      const inside = dist(q, [s.cx, s.cy]) < s.rx;
      const r = s.rx + (inside ? -d : d);
      return r > 0.2 ? [{ ...s, id: uid(), rx: r, ry: r }] : [];
    }
    if (s.t === "arc") {
      const inside = dist(q, [s.cx, s.cy]) < s.r;
      const r = s.r + (inside ? -d : d);
      return r > 0.2 ? [{ ...s, id: uid(), r }] : [];
    }
    const pl = flatten(s, 0.4)[0];
    const closed = s.t === "ellipse" || s.closed;
    if (closed) {
      const ring = pl.slice();
      if (dist(ring[0], ring[ring.length - 1]) > 1e-6) ring.push(ring[0].slice());
      const inside = pointInRing(q, ring);
      return bufferRing(ring, inside ? -d : d).map(r => ({ id: uid(), t: "poly", p: simplifyRDP(r, 0.02).slice(0, -1), closed: true }));
    }
    const [, , ti] = distToPolyline(q, pl);
    const i = clamp(Math.floor(ti), 0, pl.length - 2);
    const a = pl[i], b = pl[i + 1];
    const side = Math.sign((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) || 1;
    return [{ id: uid(), t: "poly", p: simplifyRDP(offsetPolyline(pl, d * side), 0.02), closed: false }];
  }

  // ------------------------------------------------------------------ Grundformen erzeugen
  function regularPolygon(cx, cy, r, n, a0) {
    const p = [];
    for (let i = 0; i < n; i++) { const a = a0 + i * 2 * Math.PI / n; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return { t: "path", p, c: p.map(() => true), closed: true };
  }
  function star(cx, cy, r, n, ratio, a0) {
    const p = [];
    for (let i = 0; i < n * 2; i++) { const a = a0 + i * Math.PI / n, rr = i % 2 ? r * ratio : r; p.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
    return { t: "path", p, c: p.map(() => true), closed: true };
  }
  function leaf(a, b, widthPct) {
    const m = lerp(a, b, 0.5), dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const w = L * widthPct / 200, nx = -dy / L * w, ny = dx / L * w;
    return { t: "path", p: [a.slice(), [m[0] + nx, m[1] + ny], b.slice(), [m[0] - nx, m[1] - ny]], c: [true, false, true, false], closed: true };
  }

  // ------------------------------------------------------------------ Entzerrung (Homographie)
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let mx = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[mx][i])) mx = r;
      [A[i], A[mx]] = [A[mx], A[i]]; [b[i], b[mx]] = [b[mx], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
    return x;
  }
  // H bildet src-Punkte auf dst-Punkte ab (je 4)
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return [...h, 1];
  }
  function warpToSquare(srcCanvas, quad, size) {
    const sw = srcCanvas.width, sh = srcCanvas.height;
    const sdata = srcCanvas.getContext("2d").getImageData(0, 0, sw, sh).data;
    const H = homography([[0, 0], [size, 0], [size, size], [0, size]], quad);
    const out = document.createElement("canvas");
    out.width = out.height = size;
    const octx = out.getContext("2d");
    const img = octx.createImageData(size, size), d = img.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const w = H[6] * x + H[7] * y + 1;
      const sx = (H[0] * x + H[1] * y + H[2]) / w, sy = (H[3] * x + H[4] * y + H[5]) / w;
      const o = (y * size + x) * 4;
      if (sx < 0 || sy < 0 || sx >= sw - 1 || sy >= sh - 1) { d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = 255; continue; }
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        d[o + c] = (sdata[i00 + c] * (1 - fx) + sdata[i10 + c] * fx) * (1 - fy) + (sdata[i01 + c] * (1 - fx) + sdata[i11 + c] * fx) * fy;
      }
      d[o + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return out;
  }
  function orderQuad(q) {
    const c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
    const s = q.slice().sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
    // Start oben links (kleinste Summe x+y)
    let k = 0; s.forEach((p, i) => { if (p[0] + p[1] < s[k][0] + s[k][1]) k = i; });
    return [...s.slice(k), ...s.slice(0, k)];
  }

  return {
    uid, clamp, dist, lerp, r3, OPS, GROUPS, opApply, opApplyVec, opInverse, opDet, groupAxes,
    flatten, keyPoints, mapShape, rotM, moveShape, shapeBBox, shapeImage, pathBeziers,
    distToSeg, distToPolyline, pointInRing, pointInFace, polylineLength, pointAtLength, simplifyRDP, ringArea, ptsToD,
    arrange, faceD, tilePolylines, expandPoints, offsetShape, regularPolygon, star, leaf, warpToSquare, orderQuad,
  };
})();
