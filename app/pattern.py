"""Aus dem Linien-Graph saubere Kurven machen: Geraden, Kreisbögen, Kreise, glatte Splines."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

import numpy as np
from scipy.interpolate import splprep, splev
from scipy.optimize import least_squares

from . import symmetry as sym
from .vision import PX_PER_MM, Rectified, SkelGraph


@dataclass
class Curve:
    pts: np.ndarray                 # Nx2, mm
    kind: str = "spline"            # line | arc | circle | spline
    closed: bool = False
    center: tuple | None = None
    radius: float | None = None

    def to_json(self):
        return {"pts": np.round(self.pts, 4).tolist(), "kind": self.kind, "closed": self.closed,
                "center": None if self.center is None else list(self.center), "radius": self.radius}

    @staticmethod
    def from_json(d):
        return Curve(np.array(d["pts"], float), d["kind"], d["closed"],
                     None if d["center"] is None else tuple(d["center"]), d["radius"])


# ----------------------------------------------------------------------------- Hilfsfunktionen

def path_length(p):
    return float(np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1)))


def resample(p, step):
    d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))]
    if d[-1] < 1e-9:
        return p[:1].copy()
    n = max(2, int(np.ceil(d[-1] / step)) + 1)
    t = np.linspace(0, d[-1], n)
    return np.c_[np.interp(t, d, p[:, 0]), np.interp(t, d, p[:, 1])]


def smooth(p, win, closed=False):
    if len(p) < 5 or win < 3:
        return p
    win = int(win) | 1
    k = np.ones(win) / win
    if closed:
        ext = np.r_[p[-win:], p, p[:win]]
        out = np.c_[np.convolve(ext[:, 0], k, "same"), np.convolve(ext[:, 1], k, "same")][win:-win]
        return out
    h = win // 2
    ext = np.r_[np.repeat(p[:1], h, 0) * 2 - p[h:0:-1], p, np.repeat(p[-1:], h, 0) * 2 - p[-2:-h - 2:-1]]
    out = np.c_[np.convolve(ext[:, 0], k, "valid"), np.convolve(ext[:, 1], k, "valid")]
    out[0], out[-1] = p[0], p[-1]
    return out


def fit_line(p):
    c = p.mean(0)
    u, s, vt = np.linalg.svd(p - c)
    d = vt[0]
    nrm = np.array([-d[1], d[0]])
    res = np.abs((p - c) @ nrm)
    return c, d, float(res.max())


def fit_circle(p, center=None):
    if center is not None:
        r = np.linalg.norm(p - center, axis=1)
        R = float(r.mean())
        return np.asarray(center, float), R, float(np.abs(r - R).max())
    x, y = p[:, 0], p[:, 1]
    A = np.c_[2 * x, 2 * y, np.ones_like(x)]
    b = x ** 2 + y ** 2
    try:
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    except np.linalg.LinAlgError:
        return None, None, np.inf
    cx, cy = sol[0], sol[1]
    R = np.sqrt(max(sol[2] + cx ** 2 + cy ** 2, 1e-12))
    f = lambda q: np.linalg.norm(p - q[:2], axis=1) - q[2]
    r = least_squares(f, [cx, cy, R])
    c = r.x[:2]
    R = abs(r.x[2])
    return c, float(R), float(np.abs(f(r.x)).max())


def sample_arc(c, R, p0, p1, pm, step=0.4):
    a0 = np.arctan2(*(p0 - c)[::-1])
    a1 = np.arctan2(*(p1 - c)[::-1])
    am = np.arctan2(*(pm - c)[::-1])
    tau = 2 * np.pi
    d = (a1 - a0) % tau
    dm = (am - a0) % tau
    sweep = d if dm < d else -(tau - d)
    n = max(3, int(abs(sweep) * R / step) + 1)
    t = a0 + np.linspace(0, sweep, n)
    return np.c_[c[0] + R * np.cos(t), c[1] + R * np.sin(t)]


def sample_circle(c, R, step=0.4):
    n = max(24, int(2 * np.pi * R / step))
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.c_[c[0] + R * np.cos(t), c[1] + R * np.sin(t)]


def spline_curve(p, tol, closed=False, step=0.4):
    m = len(p)
    if m < 6:
        return p
    try:
        s = m * (tol * 0.45) ** 2
        tck, _ = splprep([p[:, 0], p[:, 1]], s=s, per=1 if closed else 0, k=3)
        L = path_length(p)
        u = np.linspace(0, 1, max(8, int(L / step)), endpoint=not closed)
        x, y = splev(u, tck)
        out = np.c_[x, y]
        if not closed:
            out[0], out[-1] = p[0], p[-1]
        return out
    except Exception:
        return p


def project_on(prim, q):
    kind = prim[0]
    if kind == "line":
        _, c, d = prim
        return c + d * np.dot(q - c, d)
    if kind == "arc":
        _, c, R = prim
        v = q - c
        n = np.linalg.norm(v)
        return c + v / n * R if n > 1e-9 else q
    return q


def _edge_intersection(prim, ax, s, near):
    """Schnittpunkt einer Geraden/eines Kreises mit der Rahmenkante (Koordinate ax = s)."""
    o = 1 - ax
    if prim[0] == "line":
        _, c, d = prim
        if abs(d[ax]) < 1e-9:
            return None
        t = (s - c[ax]) / d[ax]
        q = c + t * d
        return q
    _, c, R = prim
    dd = R ** 2 - (s - c[ax]) ** 2
    if dd < 0:
        return None
    sols = []
    for sg in (-1, 1):
        q = np.zeros(2)
        q[ax] = s
        q[o] = c[o] + sg * np.sqrt(dd)
        sols.append(q)
    return min(sols, key=lambda q: np.linalg.norm(q - near))


def ray_square(p, d, half):
    """Schnittpunkt Strahl p + t d (t>0) mit dem Fliesenrand."""
    best = None
    for axis in (0, 1):
        for s in (-half, half):
            if abs(d[axis]) < 1e-9:
                continue
            t = (s - p[axis]) / d[axis]
            if t <= 0:
                continue
            q = p + t * d
            if abs(q[1 - axis]) <= half + 1e-6 and (best is None or t < best[0]):
                best = (t, q)
    return best


# ----------------------------------------------------------------------------- Hauptfunktion

@dataclass
class FitParams:
    tol_mm: float = 0.6           # erlaubte Abweichung der Zeichnung von Gerade/Bogen
    snap_mm: float = 3.0          # Bogenmittelpunkte an Ecken/Mitte einrasten


def build_curves(graph: SkelGraph, rect: Rectified, params: FitParams) -> list[Curve]:
    half = rect.tile_mm / 2
    lw = max(rect.line_width_mm, 0.4)
    pad = rect.pad_px
    to_mm = lambda rc: np.c_[(rc[:, 1] - pad) / PX_PER_MM - half, half - (rc[:, 0] - pad) / PX_PER_MM]

    nodes = [to_mm(n[None])[0] for n in graph.nodes]
    edges = [[a, b, to_mm(p)] for a, b, p in graph.edges]
    edges = [e for e in edges if len(e[2]) >= 2]

    # 0) Den gezeichneten Außenrahmen entfernen (wird parametrisch erzeugt)
    frame_band = lw * 0.5 + 1.2
    def on_frame(pts):
        d = half - np.maximum(np.abs(pts[:, 0]), np.abs(pts[:, 1]))
        return np.mean(np.abs(d) < frame_band) > 0.7
    edges = [e for e in edges if not on_frame(e[2])]
    graph = SkelGraph(graph.nodes, graph.edges,
                      [l for l in graph.loops if not on_frame(to_mm(l))])
    near_frame_dist = lw + 3.0

    def near_frame(q):
        return half - max(abs(q[0]), abs(q[1])) < near_frame_dist

    def degrees():
        deg = np.zeros(len(nodes), int)
        for a, b, _ in edges:
            deg[a] += 1
            deg[b] += 1
        return deg

    # 1) Kurze Stummel (Strichenden, Kreuzungsartefakte) entfernen
    spur = max(3 * lw, 2.5)
    for _ in range(3):
        deg = degrees()
        keep = []
        for a, b, p in edges:
            L = path_length(p)
            free_a = deg[a] == 1 and not near_frame(nodes[a])
            free_b = deg[b] == 1 and not near_frame(nodes[b])
            if L < spur and (free_a or free_b) and not (deg[a] == 1 and deg[b] == 1 and L > 1.0):
                continue
            if a == b and L < spur * 2:
                continue
            keep.append([a, b, p])
        edges = keep

    # 2) Dicht beieinander liegende Kreuzungsknoten zusammenfassen
    merge_d = max(1.5 * lw, 1.2)
    parent = list(range(len(nodes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b, p in edges:
        if a != b and path_length(p) < merge_d:
            parent[find(a)] = find(b)
    groups = {}
    for i in range(len(nodes)):
        groups.setdefault(find(i), []).append(i)
    new_nodes = {}
    for r, members in groups.items():
        new_nodes[r] = np.mean([nodes[m] for m in members], axis=0)
    nodes = [new_nodes.get(find(i)) for i in range(len(nodes))]
    edges = [[find(a), find(b), p] for a, b, p in edges if not (find(a) == find(b) and path_length(p) < merge_d)]

    # 3) Knoten vom Grad 2 auflösen (zwei Kanten zu einer verbinden)
    for _ in range(len(edges)):
        deg = degrees()
        idx = [i for i in range(len(nodes)) if deg[i] == 2]
        changed = False
        for n in idx:
            inc = [k for k, e in enumerate(edges) if e[0] == n or e[1] == n]
            if len(inc) != 2 or inc[0] == inc[1]:
                continue
            e1, e2 = edges[inc[0]], edges[inc[1]]
            if e1[0] == n and e1[1] == n:
                continue
            p1 = e1[2] if e1[1] == n else e1[2][::-1]
            o1 = e1[0] if e1[1] == n else e1[1]
            p2 = e2[2] if e2[0] == n else e2[2][::-1]
            o2 = e2[1] if e2[0] == n else e2[0]
            merged = [o1, o2, np.r_[p1, p2[1:]]]
            edges = [e for k, e in enumerate(edges) if k not in inc] + [merged]
            changed = True
            break
        if not changed:
            break

    # Kanten-Pfade an die Knotenpositionen anheften
    for e in edges:
        e[2] = e[2].copy()
        e[2][0] = nodes[e[0]]
        e[2][-1] = nodes[e[1]]

    # 4) Linienenden nahe am Rahmen bis zum Rahmen verlängern
    deg = degrees()
    for e in edges:
        for end in (0, 1):
            n = e[end]
            if deg[n] != 1 or not near_frame(nodes[n]):
                continue
            p = e[2] if end == 1 else e[2][::-1]
            # Das letzte Stück am Rahmen ist durch die T-Kreuzung verbogen -> abschneiden
            dist_e = half - np.maximum(np.abs(p[:, 0]), np.abs(p[:, 1]))
            cut = np.nonzero(dist_e > lw + 1.5)[0]
            if len(cut) >= 2 and cut[-1] < len(p) - 1:
                p = p[:cut[-1] + 1]
            q = p[-1]
            back = p[max(0, len(p) - 1 - int(3.0 * PX_PER_MM)):]
            d = back[-1] - back[0]
            if np.linalg.norm(d) < 1e-6:
                continue
            d = d / np.linalg.norm(d)
            hit = ray_square(q, d, half)
            dist_edge = half - max(abs(q[0]), abs(q[1]))
            if hit is not None and hit[0] < 3 * near_frame_dist:
                tgt = hit[1]
            else:
                tgt = q.copy()
                ax = 0 if abs(q[0]) > abs(q[1]) else 1
                tgt[ax] = np.sign(q[ax]) * half
            ext = np.linspace(q, tgt, max(2, int(np.linalg.norm(tgt - q) / 0.3) + 1))[1:]
            p = np.r_[p, ext]
            nodes[n] = tgt
            e[2] = p if end == 1 else p[::-1]

    # 5) Jede Kante einzeln ausgleichen
    tol = params.tol_mm
    fits = []  # (edge, prim, smoothed points)
    for a, b, p in edges:
        if a == b:
            fits.append((a, b, ("loop",), p))
            continue
        q = resample(p, 0.3)
        q = smooth(q, max(3, int(round(lw * 2 / 0.3))))
        L = path_length(q)
        c, d, rl = fit_line(q)
        if rl <= tol * 0.6 or L < 4 * lw:
            fits.append((a, b, ("line", c, d), q))
            continue
        cc, R, rc = fit_circle(q)
        chord = np.linalg.norm(q[-1] - q[0])
        if cc is not None and rc <= tol and R < 5 * rect.tile_mm and L > 3:
            fits.append((a, b, ("arc", cc, R), q))
        else:
            fits.append((a, b, ("spline",), q))

    # Mittelpunkte einrasten: Ecken, Mitte, Kantenmitten, gemeinsame Zentren
    cands = [np.array(v, float) for v in
             [(0, 0), (-half, -half), (half, -half), (half, half), (-half, half),
              (0, half), (0, -half), (half, 0), (-half, 0)]]
    arcs = [i for i, f in enumerate(fits) if f[2][0] == "arc"]
    # gemeinsame Zentren sammeln
    centers = []
    for i in arcs:
        c = fits[i][2][1]
        for k, (cc, w) in enumerate(centers):
            if np.linalg.norm(cc - c) < params.snap_mm:
                L = path_length(fits[i][3])
                centers[k] = ((cc * w + c * L) / (w + L), w + L)
                break
        else:
            centers.append((c.copy(), path_length(fits[i][3])))
    for i in arcs:
        a, b, prim, q = fits[i]
        c = prim[1]
        best = None
        for cand in cands + [cc for cc, w in centers]:
            if np.linalg.norm(cand - c) < params.snap_mm:
                c2, R2, r2 = fit_circle(q, cand)
                if r2 <= tol * 1.5 and (best is None or r2 < best[2]):
                    best = (c2, R2, r2)
                    if any(np.allclose(cand, x) for x in cands):
                        break  # feste Kandidaten bevorzugen
        if best is not None:
            fits[i] = (a, b, ("arc", best[0], best[1]), q)
    # gleiche Radien um gleiche Mitte angleichen (ein Kreis, der von Kreuzungen geteilt wird)
    arcs = [i for i, f in enumerate(fits) if f[2][0] == "arc"]
    used = set()
    for i in arcs:
        if i in used:
            continue
        ci, Ri = fits[i][2][1], fits[i][2][2]
        grp = [j for j in arcs if j not in used and np.linalg.norm(fits[j][2][1] - ci) < 1e-6
               and abs(fits[j][2][2] - Ri) < max(tol, 0.5)]
        if len(grp) > 1:
            Ls = np.array([path_length(fits[j][3]) for j in grp])
            Rm = float(np.sum([fits[j][2][2] for j in grp] * Ls) / Ls.sum())
            for j in grp:
                a, b, prim, q = fits[j]
                fits[j] = (a, b, ("arc", prim[1], Rm), q)
        used |= set(grp)

    # 6) Knoten auf die ausgeglichenen Kurven ziehen
    for _ in range(2):
        acc = {}
        for a, b, prim, q in fits:
            if prim[0] in ("line", "arc"):
                for n in (a, b):
                    acc.setdefault(n, []).append(project_on(prim, nodes[n]))
        for n, ps in acc.items():
            newp = np.mean(ps, axis=0)
            if half - max(abs(nodes[n][0]), abs(nodes[n][1])) < 0.05:
                ax = 0 if abs(nodes[n][0]) > abs(nodes[n][1]) else 1
                s = np.sign(nodes[n][ax]) * half
                prims = [f[2] for f in fits if n in (f[0], f[1]) and f[2][0] in ("line", "arc")]
                hit = _edge_intersection(prims[0], ax, s, nodes[n]) if len(prims) == 1 else None
                if hit is not None and np.linalg.norm(hit - nodes[n]) < 3.0:
                    newp = hit
                else:
                    newp[ax] = s
            nodes[n] = newp

    # 7) Endgültige Kurven erzeugen
    curves: list[Curve] = []
    for a, b, prim, q in fits:
        p0, p1 = nodes[a], nodes[b]
        if prim[0] == "line":
            pts = np.array([p0, p1])
            curves.append(Curve(pts, "line"))
        elif prim[0] == "arc":
            c, R = prim[1], prim[2]
            pts = sample_arc(c, R, p0, p1, q[len(q) // 2])
            pts[0], pts[-1] = p0, p1
            curves.append(Curve(pts, "arc", center=(float(c[0]), float(c[1])), radius=float(R)))
        elif prim[0] == "loop":
            loop = resample(np.r_[q, q[:1]], 0.3)
            curves.extend(_fit_loop(loop, tol, lw))
        else:
            qq = q.copy()
            qq[0], qq[-1] = p0, p1
            curves.append(Curve(spline_curve(qq, tol), "spline"))

    for loop in graph.loops:
        lp = to_mm(loop)
        lp = resample(np.r_[lp, lp[:1]], 0.3)
        curves.extend(_fit_loop(lp, tol, lw))

    # Gleich große Kreise bekommen exakt denselben Radius
    circ = [c for c in curves if c.kind == "circle"]
    done = set()
    for c in circ:
        if id(c) in done:
            continue
        grp = [d for d in circ if id(d) not in done and abs(d.radius - c.radius) < max(0.5 * tol, 0.3)]
        Rm = float(np.mean([d.radius for d in grp]))
        for d in grp:
            d.radius = Rm
            d.pts = sample_circle(np.array(d.center), Rm)
            done.add(id(d))
    return curves


def _fit_loop(lp, tol, lw):
    lp = smooth(lp[:-1], max(3, int(round(lw * 2 / 0.3))), closed=True)
    c, R, r = fit_circle(lp)
    if c is not None and r <= tol:
        return [Curve(sample_circle(c, R), "circle", True, (float(c[0]), float(c[1])), float(R))]
    return [Curve(spline_curve(lp, tol, closed=True), "spline", True)]
