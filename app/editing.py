"""Bearbeitungsfunktionen: Linien biegen, Linien zeichnen, Rückgängig."""
from __future__ import annotations

import copy

import numpy as np
from scipy.interpolate import splprep, splev
from shapely.geometry import LineString, Point

from . import symmetry as sym
from .geometry import curve_geom, transform_geom
from .pattern import Curve, resample, path_length


# ----------------------------------------------------------------------------- Rückgängig

class History:
    def __init__(self, limit: int = 60):
        self.undo_stack: list = []
        self.redo_stack: list = []
        self.limit = limit

    @staticmethod
    def snapshot(project):
        return (copy.deepcopy(project.curves), list(project.struts), list(project.group))

    def push(self, project):
        self.undo_stack.append(self.snapshot(project))
        if len(self.undo_stack) > self.limit:
            self.undo_stack.pop(0)
        self.redo_stack.clear()

    def _restore(self, project, snap):
        project.curves, project.struts, project.group = copy.deepcopy(snap[0]), list(snap[1]), list(snap[2])

    def undo(self, project) -> bool:
        if not self.undo_stack:
            return False
        self.redo_stack.append(self.snapshot(project))
        self._restore(project, self.undo_stack.pop())
        return True

    def redo(self, project) -> bool:
        if not self.redo_stack:
            return False
        self.undo_stack.append(self.snapshot(project))
        self._restore(project, self.redo_stack.pop())
        return True

    def clear(self):
        self.undo_stack.clear()
        self.redo_stack.clear()


# ----------------------------------------------------------------------------- Symmetrie-Partner

def orbit(curves: list[Curve], idx: int, group, tol: float = 1.0):
    """Alle Linien, die Spiegelbilder von Linie idx sind: Liste von (index, operation)."""
    base = curve_geom(curves[idx])
    out = []
    for g in group:
        img = transform_geom(base, g)
        best = None
        for j, c in enumerate(curves):
            gj = curve_geom(c)
            if abs(gj.length - img.length) > max(2.0, 0.05 * img.length):
                continue
            d = gj.hausdorff_distance(img)
            if d < tol and (best is None or d < best[1]):
                best = (j, d)
        if best is not None and all(best[0] != o[0] for o in out):
            out.append((best[0], g))
    return out


def densify(c: Curve, step: float = 0.4) -> np.ndarray:
    pts = c.pts
    if c.closed and not np.allclose(pts[0], pts[-1]):
        pts = np.r_[pts, pts[:1]]
    q = resample(pts, step)
    if c.closed:
        q = q[:-1]
    return q


# ----------------------------------------------------------------------------- Biegen

def _w(d, R):
    t = np.clip(d / R, 0, 1)
    return (1 - t ** 2) ** 2


def bend_field(x: np.ndarray, p: np.ndarray, delta: np.ndarray, R: float, group) -> np.ndarray:
    """Verschiebungsfeld, das an allen Spiegelpunkten von p gleichzeitig zieht
    (dadurch bleibt alles exakt symmetrisch). x: Nx2."""
    D = np.zeros_like(x, dtype=float)
    norm = 0.0
    for g in group:
        gp = sym.apply_points(p, g)
        gd = sym.apply_points(delta, g)
        D += _w(np.linalg.norm(x - gp, axis=1), R)[:, None] * gd
        norm += float(_w(np.linalg.norm(p - gp), R))
    return D / max(norm, 1e-9)


def bend(curves: list[Curve], struts: list, idx: int, p, delta, R: float, group, members=None,
         preview=False):
    """Biegt Linie idx am Punkt p um delta (mm). Gibt neue Listen (Linien, Haltestege) zurück."""
    p = np.asarray(p, float)
    delta = np.asarray(delta, float)
    if members is None:
        members = [j for j, _ in orbit(curves, idx, group)] or [idx]
    if preview:  # nur die betroffenen Linien berechnen (schnell, für die Vorschau)
        out = {}
        for j in members:
            c = copy.deepcopy(curves[j])
            pts = densify(c)
            c.pts = pts + bend_field(pts, p, delta, R, group)
            out[j] = c
        return out
    new = copy.deepcopy(curves)
    moved_ends = []  # (alte Position, Verschiebung)
    for j in members:
        c = new[j]
        pts = densify(c)
        old_ends = [pts[0].copy(), pts[-1].copy()] if not c.closed else []
        D = bend_field(pts, p, delta, R, group)
        pts = pts + D
        if not c.closed:
            moved_ends += [(old_ends[0], D[0]), (old_ends[1], D[-1])]
        c.pts = pts
        c.kind = "spline"
        c.center, c.radius = None, None
    # Angeschlossene Linien am Knoten mitziehen
    member_set = set(members)
    for j, c in enumerate(new):
        if j in member_set or c.closed:
            continue
        for end in (0, -1):
            for pos, D in moved_ends:
                if np.linalg.norm(D) < 1e-6 or np.linalg.norm(c.pts[end] - pos) > 0.05:
                    continue
                pts = densify(c)
                s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
                dist = s if end == 0 else s[-1] - s
                pts = pts + _w(dist, R)[:, None] * D
                c.pts = pts
                c.kind = "spline"
                c.center, c.radius = None, None
                break
    # Haltesteg-Enden, die auf gebogenen Linien sitzen, mitnehmen
    geoms = [curve_geom(curves[j]) for j in members]
    new_struts = []
    for a, b in struts:
        ends = []
        for q in (np.array(a), np.array(b)):
            if any(g.distance(Point(q)) < 0.5 for g in geoms):
                q = q + bend_field(q[None], p, delta, R, group)[0]
            ends.append((float(q[0]), float(q[1])))
        new_struts.append(tuple(ends))
    return new, new_struts


# ----------------------------------------------------------------------------- Zeichnen

def make_curve(points: list) -> Curve:
    pts = np.array(points, float)
    keep = [0] + [i for i in range(1, len(pts)) if np.linalg.norm(pts[i] - pts[i - 1]) > 0.05]
    pts = pts[keep]
    if len(pts) <= 2:
        return Curve(pts if len(pts) == 2 else np.r_[pts, pts], "line")
    k = min(3, len(pts) - 1)
    try:
        tck, _ = splprep([pts[:, 0], pts[:, 1]], s=0, k=k)
    except Exception:
        return Curve(pts, "spline")
    L = path_length(pts)
    u = np.linspace(0, 1, max(20, int(L / 0.4)))
    x, y = splev(u, tck)
    out = np.c_[x, y]
    out[0], out[-1] = pts[0], pts[-1]
    return Curve(out, "spline")


def add_curve_symmetric(curves: list[Curve], c: Curve, group) -> list[Curve]:
    out = list(curves)
    base = curve_geom(c)
    for g in group:
        pts = sym.apply_points(c.pts, g)
        img = LineString(pts)
        if any(curve_geom(d).hausdorff_distance(img) < 0.5 for d in out):
            continue
        out.append(Curve(pts, c.kind, c.closed,
                         None if c.center is None else tuple(sym.apply_points(np.array(c.center), g)),
                         c.radius))
    return out
