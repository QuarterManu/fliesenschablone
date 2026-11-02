"""Bildverarbeitung: Zeichnung einlesen, Fliese finden, entzerren, Linien als Graph extrahieren.

Koordinatensystem für alles nach dem Entzerren: Millimeter, Ursprung in der
Fliesenmitte, x nach rechts, y nach oben (wie auf der Zeichnung betrachtet).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from . import symmetry as sym

PX_PER_MM = 10.0  # Arbeitsauflösung nach dem Entzerren (0,1 mm pro Pixel)
PAD_MM = 4.0      # Rand um die Fliese im entzerrten Bild


def load_gray(path: str) -> np.ndarray:
    """Liest ein Bild (auch mit Umlauten im Pfad unter Windows) als Graustufen."""
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f"Bild konnte nicht gelesen werden: {path}")
    return img


@dataclass
class Rectified:
    gray: np.ndarray          # entzerrtes Graustufenbild inkl. Rand
    tile_mm: float
    line_width_mm: float
    corners_src: np.ndarray   # 4 Ecken (Mittellinie des Rahmens) im Originalbild

    @property
    def pad_px(self) -> int:
        return int(round(PAD_MM * PX_PER_MM))

    @property
    def n_px(self) -> int:
        return int(round(self.tile_mm * PX_PER_MM))

    def px_to_mm(self, rows: np.ndarray, cols: np.ndarray):
        x = (cols - self.pad_px) / PX_PER_MM - self.tile_mm / 2
        y = self.tile_mm / 2 - (rows - self.pad_px) / PX_PER_MM
        return x, y


def _dark_mask(gray: np.ndarray, threshold: int | None) -> np.ndarray:
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    if threshold is None:
        _, m = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    else:
        _, m = cv2.threshold(blur, threshold, 255, cv2.THRESH_BINARY_INV)
    return m


def _order_corners(pts: np.ndarray) -> np.ndarray:
    pts = pts.reshape(4, 2).astype(np.float64)
    s = pts.sum(1)
    d = pts[:, 0] - pts[:, 1]
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmax(d)]
    bl = pts[np.argmin(d)]
    return np.array([tl, tr, br, bl])


def rectify(gray: np.ndarray, tile_mm: float, threshold: int | None = None) -> Rectified:
    """Findet den gezeichneten Rahmen (äußeres Quadrat) und entzerrt die Fliese."""
    mask = _dark_mask(gray, threshold)
    h, w = mask.shape
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    best, best_area = -1, 0
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        touches = x <= 1 or y <= 1 or x + bw >= w - 1 or y + bh >= h - 1
        if touches:
            continue  # dunkler Hintergrund / Tischkante
        if bw * bh > best_area:
            best, best_area = i, bw * bh
    if best < 0:
        raise ValueError("Kein Fliesenrahmen gefunden. Ist das ganze Quadrat auf dem Bild?")
    comp = (lab == best).astype(np.uint8) * 255
    contours, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cnt = max(contours, key=cv2.contourArea)
    peri = cv2.arcLength(cnt, True)
    quad = None
    for eps in (0.01, 0.02, 0.03, 0.05):
        approx = cv2.approxPolyDP(cnt, eps * peri, True)
        if len(approx) == 4:
            quad = approx
            break
    if quad is None:
        quad = cv2.boxPoints(cv2.minAreaRect(cnt))
    outer = _order_corners(np.asarray(quad))

    # Strichstärke schätzen
    dist = cv2.distanceTransform(comp, cv2.DIST_L2, 3)
    skel = cv2.ximgproc.thinning(comp)
    lw_px = float(np.median(dist[skel > 0]) * 2.0) if np.any(skel) else 3.0

    # Ecken von der Außenkante auf die Mittellinie des Rahmenstrichs schieben
    c = outer.mean(0)
    corners = []
    for p in outer:
        v = c - p
        v /= np.linalg.norm(v)
        corners.append(p + v * (lw_px / 2) * np.sqrt(2))
    corners = np.array(corners)

    side_px = np.mean([np.linalg.norm(corners[i] - corners[(i + 1) % 4]) for i in range(4)])
    pad = int(round(PAD_MM * PX_PER_MM))
    npx = int(round(tile_mm * PX_PER_MM))
    dst = np.array([[pad, pad], [pad + npx, pad], [pad + npx, pad + npx], [pad, pad + npx]], np.float64)
    M = cv2.getPerspectiveTransform(corners.astype(np.float32), dst.astype(np.float32))
    size = npx + 2 * pad
    warped = cv2.warpPerspective(gray, M, (size, size), flags=cv2.INTER_CUBIC, borderValue=255)
    lw_mm = lw_px / side_px * tile_mm
    return Rectified(warped, tile_mm, lw_mm, corners)


def line_mask(rect: Rectified, threshold: int | None = None) -> np.ndarray:
    """Binärmaske aller Linien (inkl. Rahmen) im entzerrten Bild (mit Rand)."""
    m = _dark_mask(rect.gray, threshold)
    # Alles außerhalb des Rahmens ausblenden
    pad, n = rect.pad_px, rect.n_px
    edge = int(round((rect.line_width_mm + 1.0) * PX_PER_MM))
    outside = np.ones_like(m, bool)
    outside[pad - edge:pad + n + edge, pad - edge:pad + n + edge] = False
    m[outside] = 0
    # Kleine Flecken (Radierreste, Staub) entfernen
    ncomp, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    min_area = (2.0 * PX_PER_MM) ** 2
    keep = np.zeros(ncomp, bool)
    keep[1:] = stats[1:, cv2.CC_STAT_AREA] >= min_area
    m = (keep[lab] * 255).astype(np.uint8)
    # kleine Lücken im Strich schließen
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
    m = fill_small_holes(m, max(1.0, (rect.line_width_mm * 1.2) ** 2) * PX_PER_MM ** 2)
    return m


def symmetrize_mask(mask: np.ndarray, group: list[str], line_width_mm: float) -> np.ndarray:
    """Macht die Zeichnung exakt symmetrisch.

    Es wird nur ein Grundbereich der Zeichnung verwendet (z. B. die Hälfte bei einer
    Spiegelachse, ein Achtel bei 8-facher Symmetrie) und dieser in die übrigen Bereiche
    gespiegelt. So entstehen keine doppelten Linien, wenn die Zeichnung leicht
    unsymmetrisch ist.
    """
    if len(group) <= 1:
        return mask
    n = mask.shape[0]
    c = (n - 1) / 2
    idx = np.arange(n) - c
    X, Y = np.meshgrid(idx, -idx)
    # Bezugspunkt in "allgemeiner Lage" (auf keiner Symmetrieachse)
    q0 = np.array([0.41, 0.17]) * n / 2
    d0 = ((X - q0[0]) ** 2 + (Y - q0[1]) ** 2).astype(np.float32)
    best_d = None
    out = np.zeros_like(mask)
    for g in group:
        dg = sym.apply_image(d0, g)
        mg = sym.apply_image(mask, g)
        if best_d is None:
            best_d, out = dg, mg
        else:
            sel = dg < best_d
            best_d = np.where(sel, dg, best_d)
            out = np.where(sel, mg, out)
    # Nahtstellen an den Achsen minimal schließen
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    out = cv2.morphologyEx(out, cv2.MORPH_CLOSE, k)
    return out


def fill_small_holes(mask: np.ndarray, max_area_px: float) -> np.ndarray:
    """Schließt winzige Löcher im Strich (z. B. durch Scan-Rauschen)."""
    inv = (mask == 0).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    small = np.zeros(n, bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < max_area_px
    out = mask.copy()
    out[small[lab] & (inv > 0)] = 255
    return out


# --------------------------------------------------------------------------- Graph

@dataclass
class SkelGraph:
    nodes: list[np.ndarray] = field(default_factory=list)          # Pixelkoordinaten (row, col)
    edges: list[tuple[int, int, np.ndarray]] = field(default_factory=list)  # (n0, n1, path Nx2 row/col)
    loops: list[np.ndarray] = field(default_factory=list)          # geschlossene Linien ohne Knoten


_NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def skeleton_graph(mask: np.ndarray) -> SkelGraph:
    skel = (cv2.ximgproc.thinning(mask) > 0)
    sk = np.pad(skel.astype(np.int16), 1)
    # Nachbarn im Uhrzeigersinn: N, NO, O, SO, S, SW, W, NW
    ring = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)]
    H0, W0 = skel.shape
    nb = [sk[1 + dr:1 + dr + H0, 1 + dc:1 + dc + W0] for dr, dc in ring]
    count = sum(nb)
    trans = sum(((nb[i] == 0) & (nb[(i + 1) % 8] == 1)).astype(np.int16) for i in range(8))
    # Endpunkt: genau ein Nachbar; Kreuzung: mindestens 3 Übergänge
    nodemask = skel & ((count == 1) | (trans >= 3))
    nlab_n, nlab = cv2.connectedComponents(nodemask.astype(np.uint8), connectivity=8)
    g = SkelGraph()
    for i in range(1, nlab_n):
        rr, cc = np.nonzero(nlab == i)
        g.nodes.append(np.array([rr.mean(), cc.mean()]))
    node_of = nlab - 1  # -1 = kein Knoten

    H, W = skel.shape
    visited = np.zeros_like(skel)

    def nbrs(r, c):
        for dr, dc in _NB:
            rr, cc = r + dr, c + dc
            if 0 <= rr < H and 0 <= cc < W and skel[rr, cc]:
                yield rr, cc

    seen_pairs = set()
    rs, cs = np.nonzero(nodemask)
    for r, c in zip(rs, cs):
        n0 = node_of[r, c]
        for rr, cc in nbrs(r, c):
            if nodemask[rr, cc]:
                n1 = node_of[rr, cc]
                if n1 != n0:
                    key = (min(n0, n1), max(n0, n1), 'direct')
                    if key not in seen_pairs:
                        seen_pairs.add(key)
                        g.edges.append((n0, n1, np.array([[r, c], [rr, cc]], float)))
                continue
            if visited[rr, cc]:
                continue
            path = [(r, c), (rr, cc)]
            visited[rr, cc] = True
            pr, pc = r, c
            cr, cc2 = rr, cc
            end = None
            while True:
                cands = []
                for ar, ac in nbrs(cr, cc2):
                    if (ar, ac) == (pr, pc):
                        continue
                    if nodemask[ar, ac]:
                        if node_of[ar, ac] != n0 or len(path) > 3:
                            end = (ar, ac)
                            break
                        continue
                    if not visited[ar, ac]:
                        cands.append((ar, ac))
                if end is not None:
                    path.append(end)
                    break
                if not cands:
                    break
                # Treppenstufen: den Nachbarn nehmen, der am weitesten vom Vorgänger weg ist
                nxt = max(cands, key=lambda q: (q[0] - pr) ** 2 + (q[1] - pc) ** 2)
                for q in cands:
                    if q != nxt and max(abs(q[0] - nxt[0]), abs(q[1] - nxt[1])) <= 1:
                        visited[q] = True
                visited[nxt] = True
                path.append(nxt)
                pr, pc = cr, cc2
                cr, cc2 = nxt
            if end is None:
                # Sackgasse ohne erkannten Endpunkt: neuen Endknoten anlegen
                g.nodes.append(np.array(path[-1], float))
                g.edges.append((n0, len(g.nodes) - 1, np.array(path, float)))
                continue
            n1 = node_of[end]
            g.edges.append((n0, n1, np.array(path, float)))

    # Reine Schleifen (z. B. Kreise ohne Abzweig)
    rest = skel & ~visited & ~nodemask
    nl, lab = cv2.connectedComponents(rest.astype(np.uint8), connectivity=8)
    for i in range(1, nl):
        rr, cc = np.nonzero(lab == i)
        if len(rr) < 10:
            continue
        start = (rr[0], cc[0])
        path = [start]
        visited[start] = True
        prev = None
        cur = start
        while True:
            cands = [(ar, ac) for ar, ac in nbrs(*cur)
                     if (ar, ac) != prev and lab[ar, ac] == i and not visited[ar, ac]]
            if not cands:
                break
            ref = prev if prev is not None else cur
            nxt = max(cands, key=lambda q: (q[0] - ref[0]) ** 2 + (q[1] - ref[1]) ** 2)
            for q in cands:
                if q != nxt and max(abs(q[0] - nxt[0]), abs(q[1] - nxt[1])) <= 1:
                    visited[q] = True
            visited[nxt] = True
            path.append(nxt)
            prev, cur = cur, nxt
        g.loops.append(np.array(path, float))
    return g
