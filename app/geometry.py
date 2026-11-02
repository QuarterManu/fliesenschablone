"""2D-Geometrie der Schablone: Musterstege, Rückseite mit Haltestegen, Nut, Mausohren."""
from __future__ import annotations

from dataclasses import dataclass, asdict, field

import numpy as np
from shapely import affinity
from shapely.geometry import LineString, LinearRing, Point, Polygon, box, MultiLineString
from shapely.ops import nearest_points, unary_union

from . import symmetry as sym
from .pattern import Curve


@dataclass
class Params:
    tile_mm: float = 200.0
    # Musterseite (liegt später auf der Fliese)
    pattern_height: float = 12.0
    pattern_wall: float = 1.0
    pattern_frame: float = 0.95
    # Rückseite / Versteifung
    back_height: float = 12.0
    back_wall: float = 3.0
    strut_wall: float = 3.0
    back_frame: float = 3.0
    lip_width: float = 6.0
    lip_height: float = 2.0
    # Nut für den Metallring
    groove_on: bool = True
    groove_inner_diameter: float = 151.0
    groove_width: float = 2.0
    groove_depth: float = 6.0
    groove_cx: float = 0.0
    groove_cy: float = 0.0
    # Druckhilfe
    ears_on: bool = True
    ear_radius: float = 18.0
    ears_per_side: int = 5
    ear_height: float = 0.2
    # Haltestege-Vorschlag
    strut_max_span: float = 45.0
    strut_max_len: float = 40.0
    # Export
    mirror: bool = False

    def to_json(self):
        return asdict(self)

    @staticmethod
    def from_json(d):
        p = Params()
        for k, v in d.items():
            if hasattr(p, k):
                setattr(p, k, type(getattr(p, k))(v))
        return p


Strut = tuple  # ((x0, y0), (x1, y1))


def curve_geom(c: Curve):
    if c.closed and len(c.pts) >= 3:
        return LinearRing(c.pts)
    return LineString(c.pts)


def transform_geom(geom, name):
    M = sym.OPS[name]
    return affinity.affine_transform(geom, [M[0, 0], M[0, 1], M[1, 0], M[1, 1], 0, 0])


def symmetrize_geom(geom, group):
    if len(group) <= 1:
        return geom
    return unary_union([transform_geom(geom, g) for g in group])


def _seg_key(a, b, q=0.5):
    ka = (round(a[0] / q), round(a[1] / q))
    kb = (round(b[0] / q), round(b[1] / q))
    return tuple(sorted([ka, kb]))


def symmetric_copies(strut: Strut, group) -> list[Strut]:
    out, seen = [], set()
    a, b = np.array(strut[0], float), np.array(strut[1], float)
    for g in group:
        ga, gb = sym.apply_points(a, g), sym.apply_points(b, g)
        k = _seg_key(ga, gb)
        if k not in seen:
            seen.add(k)
            out.append(((float(ga[0]), float(ga[1])), (float(gb[0]), float(gb[1]))))
    return out


def add_struts(existing: list[Strut], new: Strut, group) -> list[Strut]:
    keys = {_seg_key(*s) for s in existing}
    out = list(existing)
    for s in symmetric_copies(new, group):
        k = _seg_key(*s)
        if k not in keys:
            keys.add(k)
            out.append(s)
    return out


def remove_strut(existing: list[Strut], idx: int, group) -> list[Strut]:
    kill = {_seg_key(*s) for s in symmetric_copies(existing[idx], group)}
    return [s for s in existing if _seg_key(*s) not in kill]


# ----------------------------------------------------------------------------- Haltestege-Vorschlag

def _frame_line(p: Params):
    h = p.tile_mm / 2 - p.back_frame / 2
    return LinearRing([(-h, -h), (h, -h), (h, h), (-h, h)])


def _ray_hit(p0, d, targets, max_len, min_len):
    ray = LineString([p0, p0 + d * max_len])
    inter = ray.intersection(targets)
    if inter.is_empty:
        return None
    pts = []
    for g in getattr(inter, "geoms", [inter]):
        if g.geom_type == "Point":
            pts.append(np.array(g.coords[0]))
        elif hasattr(g, "coords"):
            pts.extend(np.array(c) for c in g.coords)
    best = None
    for q in pts:
        dd = np.linalg.norm(q - p0)
        if dd > min_len and (best is None or dd < best[0]):
            best = (dd, q)
    return best


def auto_struts(curves: list[Curve], p: Params, group, existing: list[Strut] | None = None) -> list[Strut]:
    """Schlägt Haltestege vor: Inseln anbinden, lange freie Stege abstützen."""
    struts = list(existing or [])
    frame = _frame_line(p)
    lines = [curve_geom(c) for c in curves]
    min_len = p.back_wall * 0.8

    # --- Regel 1: jede Insel (z. B. Kreise) mit mindestens zwei Stegen anbinden
    for _ in range(12):
        net = unary_union([g.buffer(0.3) for g in lines + [frame]] +
                          [LineString(s).buffer(0.3) for s in struts])
        comps = list(getattr(net, "geoms", [net]))
        fr = frame.buffer(0.3)
        islands = [c for c in comps if not c.intersects(fr)]
        if not islands:
            break
        islands.sort(key=lambda c: c.area)
        isl = islands[0]
        rest = unary_union([c for c in comps if c is not isl])
        pi, pr = nearest_points(isl.exterior, rest)
        a, b = np.array(pi.coords[0]), np.array(pr.coords[0])
        new = [(tuple(a), tuple(b))]
        ctr = np.array(isl.centroid.coords[0])
        d = ctr - b
        if np.linalg.norm(d) > 1e-6:
            d /= np.linalg.norm(d)
            far = _ray_hit(ctr, d, isl.exterior, p.tile_mm, 0.0)
            if far is not None:
                start = far[1]
                hit = _ray_hit(start, d, rest.boundary, p.strut_max_len * 1.5, 0.5)
                if hit is not None:
                    new.append((tuple(start), tuple(hit[1])))
        for s in new:
            struts = add_struts(struts, s, group)

    # --- Regel 2: lange Stege ohne Abstützung bekommen Querstege
    for _ in range(6):
        targets = unary_union(lines + [frame] + [LineString(s) for s in struts])
        support_pts = []
        for s in struts:
            support_pts += [np.array(s[0]), np.array(s[1])]
        for c in curves:
            if not c.closed:
                support_pts += [c.pts[0], c.pts[-1]]
        added = False
        for c, g in zip(curves, lines):
            L = g.length
            if L < p.strut_max_span:
                continue
            ts = sorted({g.project(Point(q)) for q in support_pts if g.distance(Point(q)) < 0.8})
            if c.closed:
                if not ts:
                    ts = [0.0]
                ts = ts + [ts[0] + L]
            else:
                ts = sorted(set([0.0, L] + ts))
            for t0, t1 in zip(ts[:-1], ts[1:]):
                if t1 - t0 <= p.strut_max_span:
                    continue
                n_new = int(np.floor((t1 - t0) / p.strut_max_span))
                for k in range(1, n_new + 1):
                    t = (t0 + (t1 - t0) * k / (n_new + 1)) % L
                    q = np.array(g.interpolate(t).coords[0])
                    q2 = np.array(g.interpolate(min(L, t + 0.5)).coords[0])
                    q1 = np.array(g.interpolate(max(0, t - 0.5)).coords[0])
                    tan = q2 - q1
                    if np.linalg.norm(tan) < 1e-9:
                        continue
                    tan /= np.linalg.norm(tan)
                    nrm = np.array([-tan[1], tan[0]])
                    hits = [h for h in (_ray_hit(q, nrm, targets, p.strut_max_len, min_len),
                                        _ray_hit(q, -nrm, targets, p.strut_max_len, min_len)) if h]
                    if not hits:
                        continue
                    h = min(hits, key=lambda x: x[0])
                    struts = add_struts(struts, (tuple(q), tuple(h[1])), group)
                    added = True
            if added:
                break  # Abstützungen neu berechnen
        if not added:
            break
    return struts


# ----------------------------------------------------------------------------- Flächen

@dataclass
class Layers:
    pattern: object
    back: object
    lip: object
    groove: object | None
    ears: object | None


def build_layers(curves: list[Curve], struts: list[Strut], p: Params, group) -> Layers:
    h = p.tile_mm / 2
    Q = box(-h, -h, h, h)
    ring = lambda t: Q.difference(Q.buffer(-t, join_style="mitre"))
    lines = [curve_geom(c) for c in curves]
    pat = unary_union([g.buffer(p.pattern_wall / 2, quad_segs=6) for g in lines] + [ring(p.pattern_frame)])
    pat = symmetrize_geom(pat, group).intersection(Q)
    back_parts = [g.buffer(p.back_wall / 2, quad_segs=6) for g in lines]
    back_parts += [LineString(s).buffer(p.strut_wall / 2, quad_segs=6) for s in struts]
    back_parts.append(ring(p.back_frame))
    back = symmetrize_geom(unary_union(back_parts), group).intersection(Q)
    lip = ring(p.lip_width) if p.lip_width > p.back_frame and p.lip_height > 0 else None
    groove = None
    if p.groove_on:
        c = Point(p.groove_cx, p.groove_cy)
        ri = p.groove_inner_diameter / 2
        groove = c.buffer(ri + p.groove_width, quad_segs=256).difference(c.buffer(ri, quad_segs=256))
    ears = None
    if p.ears_on and p.ears_per_side >= 2:
        pts = np.linspace(-h, h, p.ears_per_side)
        centers = set()
        for t in pts:
            for q in ((t, -h), (t, h), (-h, t), (h, t)):
                centers.add((round(q[0], 6), round(q[1], 6)))
        ears = unary_union([Point(c).buffer(p.ear_radius, quad_segs=24) for c in centers] + [ring(p.back_frame)])
    return Layers(pat, back, lip, groove, ears)
