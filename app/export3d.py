"""3D-Körper aus den Flächen bauen und als STL speichern.

Ausrichtung: direkt druckfertig. Die Rückseite (Haltestege, Nut, Mausohren) liegt
auf der Druckplatte (z = 0), die dünnen Musterstege zeigen nach oben.
"""
from __future__ import annotations

import struct

import numpy as np
import manifold3d as mf
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely import affinity

from .geometry import Layers, Params


def _polys(geom):
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def _cross_section(geom) -> mf.CrossSection | None:
    contours = []
    for poly in _polys(geom):
        contours.append(np.asarray(poly.exterior.coords[:-1], float))
        for r in poly.interiors:
            contours.append(np.asarray(r.coords[:-1], float))
    if not contours:
        return None
    return mf.CrossSection(contours, mf.FillRule.EvenOdd)


def _prism(geom, z0, z1, mirror):
    if geom is None or geom.is_empty:
        return None
    if mirror:
        geom = affinity.scale(geom, -1, 1, origin=(0, 0))
    cs = _cross_section(geom)
    if cs is None:
        return None
    return mf.Manifold.extrude(cs, z1 - z0).translate((0, 0, z0))


def build_solid(layers: Layers, p: Params) -> mf.Manifold:
    Hb, Hp = p.back_height, p.pattern_height
    ov = min(0.5, Hb / 4)  # Musterstege ragen etwas in die Rückseite -> saubere Verbindung
    parts = [
        _prism(layers.back, 0.0, Hb, p.mirror),
        _prism(layers.pattern, Hb - ov, Hb + Hp, p.mirror),
    ]
    if layers.lip is not None:
        parts.append(_prism(layers.lip, 0.0, min(p.lip_height, Hb), p.mirror))
    if layers.ears is not None:
        parts.append(_prism(layers.ears, 0.0, p.ear_height, p.mirror))
    parts = [x for x in parts if x is not None]
    if not parts:
        raise ValueError("Keine Geometrie zum Exportieren.")
    solid = mf.Manifold.batch_boolean(parts, mf.OpType.Add)
    if layers.groove is not None and p.groove_depth > 0:
        cut = _prism(layers.groove, -1.0, min(p.groove_depth, Hb), p.mirror)
        if cut is not None:
            solid = solid - cut
    return solid


def write_stl(solid: mf.Manifold, path: str, name: str = "Fliesenschablone"):
    mesh = solid.to_mesh()
    v = np.asarray(mesh.vert_properties)[:, :3].astype(np.float32)
    t = np.asarray(mesh.tri_verts, dtype=np.int64)
    tri = v[t]
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.divide(n, ln, out=np.zeros_like(n), where=ln > 0)
    rec = np.zeros(len(t), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"] = n
    rec["v"] = tri
    with open(path, "wb") as f:
        header = name.encode("ascii", "ignore")[:80].ljust(80, b" ")
        f.write(header)
        f.write(struct.pack("<I", len(t)))
        f.write(rec.tobytes())
    return len(t)
