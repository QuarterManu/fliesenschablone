"""Selbsttest: erzeugt eine künstliche Zeichnung und prüft die komplette Verarbeitung.

Aufruf:  python -m tests.test_pipeline
"""
import os
import sys
import tempfile

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.project import Project  # noqa: E402


def make_drawing(path):
    S, m = 1100, 100           # Bildgröße, Rand
    n = S - 2 * m              # 900 px = 200 mm
    img = np.full((S, S), 255, np.uint8)
    rng = np.random.default_rng(1)
    cv2.rectangle(img, (m, m), (m + n, m + n), 0, 4)
    corner = (m + n, m + n)    # Bögen um die Ecke unten rechts
    for r_mm in (60, 120, 170):
        r = int(r_mm * n / 200)
        pts = []
        for a in np.linspace(180, 270, 200):
            jit = rng.normal(0, 0.8)  # leicht zittrige Hand
            pts.append((corner[0] + (r + jit) * np.cos(np.radians(a)),
                        corner[1] + (r + jit) * np.sin(np.radians(a))))
        cv2.polylines(img, [np.int32(pts)], False, 0, 4, cv2.LINE_AA)
    # Kreise symmetrisch zur Diagonale
    for a in (200, 250):
        r = 90 * n / 200
        c = (corner[0] + r * np.cos(np.radians(a)), corner[1] + r * np.sin(np.radians(a)))
        cv2.circle(img, (int(c[0]), int(c[1])), int(8 * n / 200), 0, 4, cv2.LINE_AA)
    # etwas Perspektive, wie bei einem Handyfoto
    src = np.float32([[0, 0], [S, 0], [S, S], [0, S]])
    dst = np.float32([[20, 10], [S - 5, 30], [S - 25, S - 5], [10, S - 20]])
    img = cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (S, S), borderValue=255)
    cv2.imwrite(path, img)


def main():
    tmp = tempfile.mkdtemp()
    img = os.path.join(tmp, "zeichnung.png")
    make_drawing(img)
    p = Project()
    p.load_image(img)
    p.detect()
    print("Symmetrie:", p.group, {k: round(v, 2) for k, v in p.scores.items()})
    kinds = [c.kind for c in p.curves]
    print("Linien:", kinds)
    assert "md2" in p.group, "Diagonal-Spiegelung nicht erkannt"
    arcs = [c for c in p.curves if c.kind == "arc"]
    assert len(arcs) >= 3, "Bögen nicht erkannt"
    for c in arcs:
        assert np.allclose(c.center, (100, -100), atol=0.01), f"Bogenmitte nicht eingerastet: {c.center}"
    assert sum(k == "circle" for k in kinds) == 2, "Kreise nicht erkannt"
    p.suggest_struts()
    assert len(p.struts) >= 4, "keine Haltestege vorgeschlagen"
    out = os.path.join(tmp, "test.stl")
    n = p.export_stl(out)
    assert n > 1000 and os.path.getsize(out) > 50000
    p.save(os.path.join(tmp, "t.fliese"))
    q = Project.load(os.path.join(tmp, "t.fliese"))
    assert len(q.curves) == len(p.curves) and len(q.struts) == len(p.struts)
    # Bearbeiten: biegen, zeichnen, rückgängig
    from app.editing import History, bend, make_curve, add_curve_symmetric
    h = History()
    h.push(p)
    c = next(i for i, c in enumerate(p.curves) if c.kind == "arc")
    q = p.curves[c].pts[len(p.curves[c].pts) // 2]
    p.curves, p.struts = bend(p.curves, p.struts, c, q, np.array([2.0, 1.0]), 10.0, p.group)
    assert p.curves[c].kind == "spline"
    n_before = len(p.curves)
    p.curves = add_curve_symmetric(p.curves, make_curve([(-90, -10), (-80, 0), (-70, -15)]), p.group)
    assert len(p.curves) == n_before + 2, "gezeichnete Linie nicht gespiegelt"
    assert h.undo(p) and len(p.curves) == n_before and p.curves[c].kind == "arc"
    print(f"OK – {len(p.curves)} Linien, {len(p.struts)} Haltestege, {n} Dreiecke")


if __name__ == "__main__":
    main()
