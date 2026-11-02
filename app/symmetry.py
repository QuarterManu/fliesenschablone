"""Symmetrie-Operationen eines Quadrats (Diedergruppe D4).

Koordinaten in mm, Ursprung Fliesenmitte, y nach oben.
"""
from __future__ import annotations

import numpy as np

# Name -> 2x2-Matrix
OPS: dict[str, np.ndarray] = {
    "id":    np.array([[1, 0], [0, 1]]),
    "r90":   np.array([[0, -1], [1, 0]]),
    "r180":  np.array([[-1, 0], [0, -1]]),
    "r270":  np.array([[0, 1], [-1, 0]]),
    "mv":    np.array([[-1, 0], [0, 1]]),    # Spiegelung an senkrechter Mittelachse
    "mh":    np.array([[1, 0], [0, -1]]),    # Spiegelung an waagerechter Mittelachse
    "md1":   np.array([[0, 1], [1, 0]]),     # Diagonale unten-links -> oben-rechts
    "md2":   np.array([[0, -1], [-1, 0]]),   # Diagonale oben-links -> unten-rechts
}

LABELS = {
    "mv": "Spiegelachse senkrecht  |",
    "mh": "Spiegelachse waagerecht  —",
    "md1": "Spiegelachse Diagonale  /",
    "md2": "Spiegelachse Diagonale  \\",
    "r90": "Drehung 90°",
    "r180": "Drehung 180°",
}


def _name_of(M: np.ndarray) -> str:
    for k, v in OPS.items():
        if np.array_equal(v, M):
            return k
    raise KeyError(M)


def closure(names: list[str]) -> list[str]:
    """Kleinste Gruppe, die die gewählten Operationen enthält."""
    group = {"id"}
    frontier = set(names) | {"id"}
    group |= frontier
    changed = True
    while changed:
        changed = False
        for a in list(group):
            for b in list(group):
                c = _name_of(OPS[a] @ OPS[b])
                if c not in group:
                    group.add(c)
                    changed = True
    order = list(OPS.keys())
    return sorted(group, key=order.index)


def describe(group: list[str]) -> str:
    mirrors = [g for g in group if g.startswith("m")]
    n = len(group)
    if n == 1:
        return "keine Symmetrie"
    if mirrors:
        return f"{len(mirrors)} Spiegelachse(n), {n}-fach"
    return f"{n}-fach drehsymmetrisch"


def apply_points(pts: np.ndarray, name: str) -> np.ndarray:
    return np.asarray(pts) @ OPS[name].T


def apply_image(img: np.ndarray, name: str) -> np.ndarray:
    """Wendet die Operation auf ein quadratisches Bild an (Zeilen = -y, Spalten = x)."""
    n = img.shape[0]
    assert img.shape[1] == n
    # Bild-Koordinaten: u = col - c, v = row - c; x = u, y = -v
    M = OPS[name]
    # new(x) = old(M^-1 x)
    Minv = np.round(np.linalg.inv(M)).astype(int)
    idx = np.arange(n)
    c = (n - 1) / 2
    X, Y = np.meshgrid(idx - c, -(idx - c))  # X[row,col] = x, Y = y
    sx = Minv[0, 0] * X + Minv[0, 1] * Y
    sy = Minv[1, 0] * X + Minv[1, 1] * Y
    cols = np.round(sx + c).astype(int)
    rows = np.round(-sy + c).astype(int)
    return img[rows, cols]


def detect(mask: np.ndarray, line_width_px: float, tol_mm: float = 1.5, px_per_mm: float = 10.0,
           threshold: float = 0.85) -> dict[str, float]:
    """Bewertet, wie gut die Zeichnung zu jeder Symmetrie-Operation passt (0..1)."""
    import cv2

    small = 600
    scale = small / mask.shape[0]
    m = cv2.resize(mask, (small, small), interpolation=cv2.INTER_AREA)
    m = (m > 64).astype(np.uint8)
    r = max(1, int(round(tol_mm * px_per_mm * scale)))
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    md = cv2.dilate(m, k)
    total = max(1, int(m.sum()))
    scores = {}
    for name in OPS:
        if name == "id":
            continue
        t = apply_image(m, name)
        td = apply_image(md, name)
        a = (m & td).sum() / total
        b = (t & md).sum() / max(1, int(t.sum()))
        scores[name] = float(min(a, b))
    return scores


def suggest(scores: dict[str, float], threshold: float = 0.85) -> list[str]:
    picked = [k for k, v in scores.items() if v >= threshold]
    # Nur behalten, was auch nach Gruppenbildung noch gut passt
    group = closure(picked)
    ok = all(scores.get(g, 1.0) >= threshold * 0.9 for g in group if g != "id")
    return group if ok else closure([max(scores, key=scores.get)]) if max(scores.values()) >= threshold else ["id"]
