"""Ein Projekt = eine Fliese: Zeichnung, erkannte Linien, Haltestege, Einstellungen."""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import symmetry as sym
from . import vision
from .geometry import Params, auto_struts, build_layers, add_struts, remove_strut
from .pattern import Curve, FitParams, build_curves, refine_circles
from .export3d import build_solid, write_stl
from .vector_import import is_vector_file, load_vector


@dataclass
class Project:
    params: Params = field(default_factory=Params)
    fit: FitParams = field(default_factory=FitParams)
    image_path: str | None = None
    threshold: int | None = None
    gray: np.ndarray | None = None
    rect: vision.Rectified | None = None
    mask: np.ndarray | None = None
    scores: dict = field(default_factory=dict)
    group: list = field(default_factory=lambda: ["id"])
    curves: list = field(default_factory=list)
    struts: list = field(default_factory=list)
    source: str = "image"          # "vector" (PDF/SVG, exakt) oder "image" (Foto/Scan, wird erkannt)
    vector_info: dict = field(default_factory=dict)

    # ------------------------------------------------------------------ Ablauf
    def load_file(self, path: str):
        """PDF/SVG werden exakt übernommen, Bilder über die Bilderkennung ausgewertet."""
        if is_vector_file(path):
            self.source = "vector"
            self.image_path = path
            self.gray = None
            self.rect = None
            self.mask = None
        else:
            self.load_image(path)

    def load_image(self, path: str):
        self.source = "image"
        self.image_path = path
        self.gray = vision.load_gray(path)

    @property
    def is_vector(self) -> bool:
        return self.source == "vector"

    def detect(self, auto_symmetry: bool = True):
        """Vektordatei übernehmen – oder Bild entzerren, Symmetrie und Linien erkennen."""
        if self.is_vector:
            self._import_vector(auto_symmetry)
            return
        self.rect = vision.rectify(self.gray, self.params.tile_mm, self.threshold)
        self.mask = vision.line_mask(self.rect, self.threshold)
        self.scores = sym.detect(self.mask, self.rect.line_width_mm * vision.PX_PER_MM)
        if auto_symmetry:
            self.group = sym.suggest(self.scores)
        self.rebuild_curves()

    def _import_vector(self, auto_symmetry: bool = True):
        v = load_vector(self.image_path)
        self.params.tile_mm = v.size
        self.curves = []
        for pl in v.polylines:
            closed = bool(len(pl) >= 4 and np.linalg.norm(pl[0] - pl[-1]) < 1e-3)
            pts = pl[:-1] if closed else pl
            self.curves.append(Curve(np.asarray(pts, float), "line" if len(pts) == 2 else "spline", closed))
        # Symmetrie: aus den Metadaten des Fliesenateliers, sonst aus den Linien bestimmen
        n = 800
        k = n / v.size
        mask = np.zeros((n, n), np.uint8)
        for pl in v.polylines:
            q = np.c_[(pl[:, 0] + v.size / 2) * k, (v.size / 2 - pl[:, 1]) * k]
            cv2.polylines(mask, [np.round(q).astype(np.int32)], False, 255, 3)
        self.scores = sym.detect(mask, 3, px_per_mm=k)
        if v.sym:
            self.group = sym.closure([g for g in v.sym if g != "id"])
        elif auto_symmetry:
            self.group = sym.suggest(self.scores)
        self.vector_info = {"source": v.source, "name": v.name, "type": v.tile_type, "size": v.size,
                            "from_metadata": bool(v.sym)}
        self.struts = []

    def rebuild_curves(self):
        if self.is_vector:
            group = self.group
            self._import_vector(auto_symmetry=False)
            self.group = group
            return
        m = vision.symmetrize_mask(self.mask, self.group, self.rect.line_width_mm)
        graph = vision.skeleton_graph(m)
        self.curves = build_curves(graph, self.rect, self.fit)
        refine_circles(self.curves, self.mask, self.rect, self.group)
        self.struts = []

    def set_symmetry(self, names: list[str]):
        self.group = sym.closure(names)
        if not self.is_vector:  # Vektor-Linien sind schon exakt – nur die Gruppe für Haltestege ändern
            self.rebuild_curves()

    def suggest_struts(self):
        self.struts = auto_struts(self.curves, self.params, self.group)

    def add_strut(self, a, b):
        self.struts = add_struts(self.struts, (tuple(a), tuple(b)), self.group)

    def delete_strut(self, idx):
        self.struts = remove_strut(self.struts, idx, self.group)

    def delete_curve(self, idx):
        """Löscht eine Linie samt ihren Spiegelbildern."""
        from .geometry import curve_geom, transform_geom
        target = curve_geom(self.curves[idx])
        images = [transform_geom(target, g) for g in self.group]
        keep = []
        for c in self.curves:
            g = curve_geom(c)
            if any(g.hausdorff_distance(im) < 1.0 for im in images):
                continue
            keep.append(c)
        self.curves = keep

    def layers(self):
        return build_layers(self.curves, self.struts, self.params, self.group)

    def export_stl(self, path: str) -> int:
        solid = build_solid(self.layers(), self.params)
        return write_stl(solid, path)

    # ------------------------------------------------------------------ Speichern
    def save(self, path: str):
        data = {
            "format": "fliesenschablone/1",
            "params": self.params.to_json(),
            "fit": {"tol_mm": self.fit.tol_mm, "snap_mm": self.fit.snap_mm},
            "threshold": self.threshold,
            "group": self.group,
            "curves": [c.to_json() for c in self.curves],
            "struts": [[list(a), list(b)] for a, b in self.struts],
            "image_path": self.image_path,
            "source": self.source,
            "vector_info": self.vector_info,
        }
        if self.rect is not None:
            ok, buf = cv2.imencode(".png", self.rect.gray)
            data["rectified_png"] = base64.b64encode(buf.tobytes()).decode("ascii")
            data["line_width_mm"] = self.rect.line_width_mm
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)

    @staticmethod
    def load(path: str) -> "Project":
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        p = Project()
        p.params = Params.from_json(d["params"])
        p.fit = FitParams(**d.get("fit", {}))
        p.threshold = d.get("threshold")
        p.group = d.get("group", ["id"])
        p.curves = [Curve.from_json(c) for c in d.get("curves", [])]
        p.struts = [(tuple(a), tuple(b)) for a, b in d.get("struts", [])]
        p.image_path = d.get("image_path")
        p.source = d.get("source", "image")
        p.vector_info = d.get("vector_info", {})
        if "rectified_png" in d:
            buf = np.frombuffer(base64.b64decode(d["rectified_png"]), np.uint8)
            g = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
            p.rect = vision.Rectified(g, p.params.tile_mm, d.get("line_width_mm", 1.0), np.zeros((4, 2)))
            p.mask = vision.line_mask(p.rect, p.threshold)
        return p
