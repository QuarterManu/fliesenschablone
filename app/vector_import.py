"""Import exakter Vektordaten (PDF oder SVG), z. B. aus dem Fliesenatelier.

Bei Vektordateien muss nichts erraten werden: Die Trennlinien werden direkt
übernommen. Ergebnis sind Polylinien in Millimetern im Koordinatensystem der
Schablonen-Software (Ursprung Fliesenmitte, y nach oben).
"""
from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

import numpy as np

PT_TO_MM = 25.4 / 72.0

# Symmetrie-Namen des Fliesenateliers (y nach unten) -> Operationen der Schablonen-Software (y nach oben)
ATELIER_SYM = {
    "none": ["id"],
    "v": ["id", "mv"],
    "h": ["id", "mh"],
    "vh": ["id", "mv", "mh", "r180"],
    "d1": ["id", "md2"],          # Diagonale oben links -> unten rechts
    "d2": ["id", "md1"],          # Diagonale unten links -> oben rechts
    "dd": ["id", "md1", "md2", "r180"],
    "r2": ["id", "r180"],
    "r4": ["id", "r90", "r180", "r270"],
    "all": ["id", "r90", "r180", "r270", "mv", "mh", "md1", "md2"],
}
TYPE_NAMES = {"mitte": "Mittelfliese", "rand": "Randfliese", "ecke": "Eckfliese"}


@dataclass
class VectorDrawing:
    polylines: list            # Liste von Nx2-Arrays, mm, Ursprung Fliesenmitte, y nach oben
    size: float                # Kantenlänge der Fliese in mm
    sym: list | None = None    # Symmetrie-Gruppe aus den Metadaten (oder None)
    tile_type: str | None = None
    name: str | None = None
    source: str = "pdf"
    meta: dict = field(default_factory=dict)


def is_vector_file(path: str) -> bool:
    p = path.lower()
    if p.endswith(".pdf") or p.endswith(".svg"):
        return True
    try:
        with open(path, "rb") as f:
            head = f.read(512)
        return head.startswith(b"%PDF") or b"<svg" in head
    except OSError:
        return False


def load_vector(path: str) -> VectorDrawing:
    with open(path, "rb") as f:
        head = f.read(16)
    if head.startswith(b"%PDF") or path.lower().endswith(".pdf"):
        return _from_pdf(path)
    return _from_svg(path)


# ----------------------------------------------------------------------------- Hilfen

def _cubic(p0, p1, p2, p3, step=0.4):
    L = np.linalg.norm(p1 - p0) + np.linalg.norm(p2 - p1) + np.linalg.norm(p3 - p2)
    n = max(2, int(np.ceil(L / step)))
    t = np.linspace(0, 1, n + 1)[1:, None]
    mt = 1 - t
    return mt ** 3 * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t ** 3 * p3


def _quad(p0, p1, p2, step=0.4):
    return _cubic(p0, p0 + 2 / 3 * (p1 - p0), p2 + 2 / 3 * (p1 - p2), p2, step)


def _finish(polylines_mm_ydown, frame, meta, source):
    """frame = (x0, y0, x1, y1) in mm, y nach unten. Wandelt in Fliesen-Koordinaten um."""
    x0, y0, x1, y1 = frame
    S = float(round(((x1 - x0) + (y1 - y0)) / 2, 2))
    half = S / 2
    out = []
    for pl in polylines_mm_ydown:
        pl = np.asarray(pl, float)
        if len(pl) < 2:
            continue
        q = np.c_[pl[:, 0] - x0 - half, half - (pl[:, 1] - y0)]
        # Stücke, die nur auf dem Rahmen liegen, werden nicht gebraucht (Rahmen wird erzeugt)
        d = half - np.maximum(np.abs(q[:, 0]), np.abs(q[:, 1]))
        if np.all(np.abs(d) < 0.05):
            continue
        # Punkte außerhalb der Fliese verwerfen (kleine Toleranz)
        if np.all(d < -0.5):
            continue
        # Enden, die fast auf dem Rahmen liegen, exakt auf den Rahmen setzen
        for k in (0, -1):
            if abs(d[k]) < 0.05:
                ax = 0 if abs(q[k, 0]) > abs(q[k, 1]) else 1
                q[k, ax] = np.sign(q[k, ax]) * half
        # doppelte Punkte entfernen
        keep = np.r_[True, np.linalg.norm(np.diff(q, axis=0), axis=1) > 1e-6]
        q = q[keep]
        if len(q) >= 2:
            out.append(q)
    sym = None
    if meta.get("sym") in ATELIER_SYM:
        sym = ATELIER_SYM[meta["sym"]]
    return VectorDrawing(out, S, sym, meta.get("type"), meta.get("name"), source, meta)


def _find_frame(rects, polylines):
    """Größtes annähernd quadratisches Rechteck = Fliesenrahmen (mm, y nach unten)."""
    best = None
    for (x0, y0, x1, y1) in rects:
        w, h = x1 - x0, y1 - y0
        if w > 10 and h > 10 and abs(w - h) / max(w, h) < 0.02 and (best is None or w * h > best[0]):
            best = (w * h, (x0, y0, x1, y1))
    # geschlossene Polylinie mit 4 Ecken als Rahmen?
    for pl in polylines:
        pl = np.asarray(pl)
        if len(pl) in (4, 5) and (len(pl) == 4 or np.allclose(pl[0], pl[-1], atol=0.05)):
            x0, y0 = pl.min(0)
            x1, y1 = pl.max(0)
            w, h = x1 - x0, y1 - y0
            corners = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
            on_corner = all(np.min(np.linalg.norm(corners - p, axis=1)) < 0.05 for p in pl)
            if on_corner and w > 10 and abs(w - h) / max(w, h) < 0.02 and (best is None or w * h > best[0]):
                best = (w * h, (x0, y0, x1, y1))
    if best:
        return best[1]
    # kein Rahmen: Umriss aller Linien, auf ein Quadrat erweitert
    allp = np.vstack([np.asarray(p) for p in polylines]) if polylines else np.zeros((1, 2))
    x0, y0 = allp.min(0)
    x1, y1 = allp.max(0)
    s = max(x1 - x0, y1 - y0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return (cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2)


# ----------------------------------------------------------------------------- PDF

def _decode(v):
    if isinstance(v, bytes):
        if v.startswith(b"\xfe\xff"):
            return v[2:].decode("utf-16-be", "ignore")
        return v.decode("latin-1", "ignore")
    return str(v) if v is not None else ""


def _from_pdf(path: str) -> VectorDrawing:
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTCurve, LTLine, LTRect, LTFigure, LAParams
    from pdfminer.pdfdocument import PDFDocument
    from pdfminer.pdfparser import PDFParser

    meta = {}
    try:
        with open(path, "rb") as fh:
            doc = PDFDocument(PDFParser(fh))
            info = doc.info[0] if doc.info else {}
        kw = _decode(info.get("Keywords"))
        if "fliesenatelier" in kw:
            for part in kw.split(";"):
                if "=" in part:
                    k, v = part.split("=", 1)
                    meta[{"typ": "type", "groesse": "size", "symmetrie": "sym"}.get(k.strip(), k.strip())] = v.strip()
        meta["name"] = _decode(info.get("Title")) or None
    except Exception:
        pass

    page = next(iter(extract_pages(path, maxpages=1, laparams=LAParams())), None)
    if page is None:
        raise ValueError("Die PDF enthält keine Seite.")
    H = page.height

    def conv(p):
        return np.array([p[0] * PT_TO_MM, (H - p[1]) * PT_TO_MM])

    polylines, rects = [], []

    def walk(container):
        for el in container:
            if isinstance(el, LTFigure):
                walk(el)
                continue
            if isinstance(el, LTRect) and (el.original_path is None or len(el.original_path) <= 5):
                x0, y0, x1, y1 = el.bbox
                a, b = conv((x0, y1)), conv((x1, y0))
                rects.append((a[0], a[1], b[0], b[1]))
                continue
            if not isinstance(el, (LTCurve, LTLine)):
                continue
            path_ops = getattr(el, "original_path", None)
            if not path_ops:
                pts = [conv(p) for p in el.pts]
                if len(pts) >= 2:
                    polylines.append(np.array(pts))
                continue
            cur, start = [], None
            for op in path_ops:
                kind, args = op[0], op[1:]
                if kind == "m":
                    if len(cur) >= 2:
                        polylines.append(np.array(cur))
                    p = conv(args[0])
                    cur, start = [p], p
                elif kind == "l":
                    cur.append(conv(args[0]))
                elif kind in ("c", "v", "y"):
                    if not cur:
                        continue
                    p0 = cur[-1]
                    if kind == "c":
                        p1, p2, p3 = (conv(a) for a in args[:3])
                    elif kind == "v":
                        p1 = p0
                        p2, p3 = (conv(a) for a in args[:2])
                    else:
                        p1, p3 = (conv(a) for a in args[:2])
                        p2 = p3
                    cur.extend(_cubic(p0, p1, p2, p3))
                elif kind == "h":
                    if start is not None and cur:
                        cur.append(start.copy())
            if len(cur) >= 2:
                polylines.append(np.array(cur))

    walk(page)
    if not polylines and not rects:
        raise ValueError("In der PDF wurden keine Linien gefunden. Ist es eine Vektor-PDF (z. B. aus dem Fliesenatelier)?")
    frame = _find_frame(rects, polylines)
    return _finish(polylines, frame, meta, "pdf")


# ----------------------------------------------------------------------------- SVG

_NUM = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"


def _parse_path(d: str):
    tokens = re.findall(r"[MmLlHhVvCcSsQqTtZzAa]|" + _NUM, d)
    polys, cur, i = [], [], 0
    pos = np.zeros(2)
    start = np.zeros(2)
    cmd = None
    last_ctrl = None

    def num():
        nonlocal i
        v = float(tokens[i])
        i += 1
        return v

    while i < len(tokens):
        t = tokens[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t
            i += 1
            if cmd in "Zz":
                if cur:
                    cur.append(start.copy())
                    polys.append(np.array(cur))
                cur = []
                pos = start.copy()
                continue
        rel = cmd.islower()
        c = cmd.upper()
        base = pos if rel else np.zeros(2)
        if c == "M":
            if len(cur) >= 2:
                polys.append(np.array(cur))
            pos = base + [num(), num()]
            start = pos.copy()
            cur = [pos.copy()]
            cmd = "l" if rel else "L"
        elif c == "L":
            pos = base + [num(), num()]
            cur.append(pos.copy())
        elif c == "H":
            pos = np.array([(pos[0] if rel else 0) + num(), pos[1]])
            cur.append(pos.copy())
        elif c == "V":
            pos = np.array([pos[0], (pos[1] if rel else 0) + num()])
            cur.append(pos.copy())
        elif c == "C":
            p1 = base + [num(), num()]
            p2 = base + [num(), num()]
            p3 = base + [num(), num()]
            cur.extend(_cubic(pos, p1, p2, p3))
            last_ctrl, pos = p2, p3
        elif c == "S":
            p1 = 2 * pos - last_ctrl if last_ctrl is not None else pos
            p2 = base + [num(), num()]
            p3 = base + [num(), num()]
            cur.extend(_cubic(pos, p1, p2, p3))
            last_ctrl, pos = p2, p3
        elif c == "Q":
            p1 = base + [num(), num()]
            p2 = base + [num(), num()]
            cur.extend(_quad(pos, p1, p2))
            pos = p2
        elif c == "A":
            # Bögen werden als Gerade angenähert (kommt im Fliesenatelier nicht vor)
            for _ in range(5):
                num()
            pos = base + [num(), num()]
            cur.append(pos.copy())
        else:
            i += 1
    if len(cur) >= 2:
        polys.append(np.array(cur))
    return polys


def _len_mm(v: str | None):
    if not v:
        return None
    m = re.match(r"\s*(" + _NUM + r")\s*(mm|cm|in|pt|px)?", v)
    if not m:
        return None
    x, u = float(m.group(1)), m.group(2) or "px"
    return x * {"mm": 1, "cm": 10, "in": 25.4, "pt": PT_TO_MM, "px": 25.4 / 96}[u]


def _from_svg(path: str) -> VectorDrawing:
    tree = ET.parse(path)
    root = tree.getroot()
    ns = lambda tag: tag.split("}")[-1]
    vb = root.get("viewBox")
    vbx = [float(v) for v in re.split(r"[ ,]+", vb.strip())] if vb else None
    wmm = _len_mm(root.get("width"))
    scale = 1.0
    if vbx and wmm:
        scale = wmm / vbx[2]
    meta = {}
    for el in root.iter():
        if ns(el.tag) == "metadata" and (el.get("id") == "fliesenatelier" or (el.text or "").strip().startswith("{")):
            try:
                data = json.loads(el.text)
                meta = {"type": data.get("type"), "size": data.get("size"), "sym": data.get("sym"), "name": data.get("name")}
            except Exception:
                pass
    polylines, rects = [], []
    for el in root.iter():
        tag = ns(el.tag)
        if el.get("transform"):
            pass  # Transformationen werden nicht unterstützt (Fliesenatelier nutzt keine)
        if tag == "path":
            polylines.extend(_parse_path(el.get("d", "")))
        elif tag == "line":
            polylines.append(np.array([[float(el.get("x1", 0)), float(el.get("y1", 0))], [float(el.get("x2", 0)), float(el.get("y2", 0))]]))
        elif tag in ("polyline", "polygon"):
            nums = [float(v) for v in re.findall(_NUM, el.get("points", ""))]
            pts = np.array(nums).reshape(-1, 2)
            if tag == "polygon" and len(pts):
                pts = np.r_[pts, pts[:1]]
            polylines.append(pts)
        elif tag == "rect":
            x, y = float(el.get("x", 0)), float(el.get("y", 0))
            w, h = float(el.get("width", 0)), float(el.get("height", 0))
            rects.append((x, y, x + w, y + h))
        elif tag in ("circle", "ellipse"):
            cx, cy = float(el.get("cx", 0)), float(el.get("cy", 0))
            rx = float(el.get("r", el.get("rx", 0)))
            ry = float(el.get("r", el.get("ry", rx)))
            t = np.linspace(0, 2 * np.pi, max(24, int(2 * np.pi * max(rx, ry) / 0.4)))
            polylines.append(np.c_[cx + rx * np.cos(t), cy + ry * np.sin(t)])
    polylines = [p * scale for p in polylines if len(p) >= 2]
    rects = [tuple(v * scale for v in r) for r in rects]
    if not polylines:
        raise ValueError("In der SVG wurden keine Linien gefunden.")
    frame = _find_frame(rects, polylines)
    return _finish(polylines, frame, meta, "svg")
