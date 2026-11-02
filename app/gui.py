"""Oberfläche: Zeichnung laden, Ergebnis prüfen, Haltestege anpassen, STL speichern."""
from __future__ import annotations

import os
import sys
import threading
import traceback

import numpy as np
from PySide6.QtCore import Qt, QPointF, QRectF, QTimer, Signal, QObject
from PySide6.QtGui import (QAction, QBrush, QColor, QImage, QPainter, QPainterPath, QPen, QPixmap,
                           QKeySequence, QIcon)
from PySide6.QtWidgets import (QApplication, QButtonGroup, QCheckBox, QDoubleSpinBox, QFileDialog,
                               QFormLayout, QGraphicsPathItem, QGraphicsPixmapItem, QGraphicsScene,
                               QGraphicsView, QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox,
                               QProgressDialog, QPushButton, QScrollArea, QSpinBox, QSlider, QToolButton,
                               QVBoxLayout, QWidget, QSizePolicy)
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points, unary_union

from . import symmetry as sym
from . import updater, vision
from .geometry import curve_geom, _frame_line
from .project import Project
from .version import __version__

COL_PATTERN = QColor("#1d3557")
COL_BACK = QColor(244, 162, 97, 150)
COL_STRUT = QColor("#e63946")
COL_GROOVE = QColor(42, 157, 143, 170)
COL_EARS = QColor(180, 180, 180, 90)
COL_CURVE = QColor("#2a9d8f")


def geom_path(geom) -> QPainterPath:
    """shapely-Fläche -> QPainterPath (y nach oben = Szene nach unten gespiegelt)."""
    path = QPainterPath()
    path.setFillRule(Qt.OddEvenFill)
    if geom is None or geom.is_empty:
        return path
    for poly in getattr(geom, "geoms", [geom]):
        if poly.geom_type != "Polygon":
            continue
        for ring in [poly.exterior] + list(poly.interiors):
            pts = list(ring.coords)
            path.moveTo(pts[0][0], -pts[0][1])
            for x, y in pts[1:]:
                path.lineTo(x, -y)
            path.closeSubpath()
    return path


def line_path(pts) -> QPainterPath:
    path = QPainterPath()
    path.moveTo(pts[0][0], -pts[0][1])
    for x, y in pts[1:]:
        path.lineTo(x, -y)
    return path


class View(QGraphicsView):
    clicked = Signal(float, float)
    moved = Signal(float, float)

    def __init__(self, scene):
        super().__init__(scene)
        self.setRenderHint(QPainter.Antialiasing)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.ScrollHandDrag)
        self.setMouseTracking(True)
        self.setBackgroundBrush(QColor("#f1f1ee"))
        self._press = None

    def wheelEvent(self, e):
        f = 1.2 if e.angleDelta().y() > 0 else 1 / 1.2
        self.scale(f, f)

    def mousePressEvent(self, e):
        self._press = e.position()
        super().mousePressEvent(e)

    def mouseReleaseEvent(self, e):
        super().mouseReleaseEvent(e)
        if self._press is not None and e.button() == Qt.LeftButton:
            if (e.position() - self._press).manhattanLength() < 5:
                p = self.mapToScene(e.position().toPoint())
                self.clicked.emit(p.x(), -p.y())
        self._press = None

    def mouseMoveEvent(self, e):
        super().mouseMoveEvent(e)
        p = self.mapToScene(e.position().toPoint())
        self.moved.emit(p.x(), -p.y())

    def fit(self):
        r = self.scene().itemsBoundingRect()
        if not r.isEmpty():
            self.fitInView(r.adjusted(-5, -5, 5, 5), Qt.KeepAspectRatio)


class UpdateSignals(QObject):
    found = Signal(str, str, str)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"Fliesenschablone {__version__}")
        self.resize(1400, 900)
        self.project = Project()
        self.layers = None
        self.mode = "view"
        self.pending = None   # erster Punkt beim Steg-Setzen
        self.project_path = None

        self.scene = QGraphicsScene()
        self.view = View(self.scene)
        self.view.clicked.connect(self.on_click)
        self.view.moved.connect(self.on_move)
        self.rubber = None

        side = QWidget()
        side.setMinimumWidth(330)
        lay = QVBoxLayout(side)
        lay.addWidget(self._box_drawing())
        lay.addWidget(self._box_symmetry())
        lay.addWidget(self._box_struts())
        lay.addWidget(self._box_dims())
        lay.addWidget(self._box_export())
        lay.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidget(side)
        scroll.setWidgetResizable(True)
        scroll.setMinimumWidth(360)

        central = QWidget()
        h = QHBoxLayout(central)
        h.setContentsMargins(4, 4, 4, 4)
        h.addWidget(scroll)
        right = QVBoxLayout()
        right.addWidget(self._view_toggles())
        right.addWidget(self.view, 1)
        h.addLayout(right, 1)
        self.setCentralWidget(central)
        self.statusBar().showMessage("Bild einer Zeichnung öffnen, um zu starten.")
        self._set_enabled(False)

        self.upd = UpdateSignals()
        self.upd.found.connect(self.offer_update)
        QTimer.singleShot(1500, self.check_updates)

    # ------------------------------------------------------------------ Bausteine
    def _btn(self, text, slot, tip=None):
        b = QPushButton(text)
        b.clicked.connect(slot)
        if tip:
            b.setToolTip(tip)
        return b

    def _dspin(self, val, lo, hi, step=0.1, dec=2, suffix=" mm"):
        s = QDoubleSpinBox()
        s.setRange(lo, hi)
        s.setDecimals(dec)
        s.setSingleStep(step)
        s.setValue(val)
        s.setSuffix(suffix)
        return s

    def _box_drawing(self):
        b = QGroupBox("1. Zeichnung")
        f = QFormLayout(b)
        row = QHBoxLayout()
        row.addWidget(self._btn("Bild öffnen…", self.open_image))
        row.addWidget(self._btn("Projekt öffnen…", self.open_project))
        f.addRow(row)
        self.sp_tile = self._dspin(200, 50, 600, 1, 1)
        f.addRow("Fliesengröße", self.sp_tile)
        self.cb_auto_thr = QCheckBox("automatisch")
        self.cb_auto_thr.setChecked(True)
        self.sl_thr = QSlider(Qt.Horizontal)
        self.sl_thr.setRange(20, 235)
        self.sl_thr.setValue(128)
        self.sl_thr.setEnabled(False)
        self.cb_auto_thr.toggled.connect(lambda on: self.sl_thr.setEnabled(not on))
        r2 = QHBoxLayout()
        r2.addWidget(self.cb_auto_thr)
        r2.addWidget(self.sl_thr)
        f.addRow("Helligkeitsschwelle", r2)
        self.sp_tol = self._dspin(0.6, 0.1, 3.0, 0.1, 2)
        self.sp_tol.setToolTip("Wie stark darf die Handzeichnung von einer perfekten Geraden/einem Bogen abweichen,\n"
                               "damit sie trotzdem als Gerade/Bogen erkannt wird? Größer = glatter.")
        f.addRow("Glättung (Toleranz)", self.sp_tol)
        self.btn_detect = self._btn("Neu erkennen", self.detect)
        f.addRow(self.btn_detect)
        return b

    def _box_symmetry(self):
        b = QGroupBox("2. Symmetrie")
        v = QVBoxLayout(b)
        self.lbl_sym = QLabel("–")
        self.lbl_sym.setWordWrap(True)
        v.addWidget(self.lbl_sym)
        self.cb_sym = {}
        for k in ["mv", "mh", "md1", "md2", "r90", "r180"]:
            cb = QCheckBox(sym.LABELS[k])
            self.cb_sym[k] = cb
            v.addWidget(cb)
        v.addWidget(self._btn("Symmetrie übernehmen", self.apply_symmetry,
                              "Linien werden an allen gewählten Achsen gespiegelt und gemittelt."))
        return b

    def _box_struts(self):
        b = QGroupBox("3. Haltestege && Bearbeiten")
        v = QVBoxLayout(b)
        f = QFormLayout()
        self.sp_span = self._dspin(45, 10, 200, 5, 0)
        self.sp_span.setToolTip("Längster Steg-Abschnitt ohne Abstützung")
        self.sp_maxlen = self._dspin(40, 5, 150, 5, 0)
        self.sp_maxlen.setToolTip("Längster erlaubter Haltesteg")
        f.addRow("max. freie Länge", self.sp_span)
        f.addRow("max. Haltesteg-Länge", self.sp_maxlen)
        v.addLayout(f)
        v.addWidget(self._btn("Haltestege vorschlagen", self.suggest_struts))
        grid = QHBoxLayout()
        self.mode_group = QButtonGroup(self)
        for key, text, tip in [("view", "Ansehen", "Verschieben mit gedrückter Maustaste, Zoom mit Mausrad"),
                               ("add", "Steg setzen", "Zwei Klicks: Anfang und Ende eines Haltestegs"),
                               ("del", "Steg löschen", "Auf einen Haltesteg klicken"),
                               ("delcurve", "Linie löschen", "Auf eine Musterlinie klicken")]:
            t = QToolButton()
            t.setText(text)
            t.setToolTip(tip)
            t.setCheckable(True)
            t.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            if key == "view":
                t.setChecked(True)
            t.clicked.connect(lambda _=False, k=key: self.set_mode(k))
            self.mode_group.addButton(t)
            grid.addWidget(t)
        v.addLayout(grid)
        v.addWidget(self._btn("Alle Haltestege entfernen", self.clear_struts))
        lbl = QLabel("Alles wird automatisch an den Symmetrieachsen mitgespiegelt.")
        lbl.setWordWrap(True)
        lbl.setStyleSheet("color:#666")
        v.addWidget(lbl)
        return b

    def _box_dims(self):
        b = QGroupBox("4. Maße")
        f = QFormLayout(b)
        p = self.project.params
        self.dims = {}

        def add(key, label, lo, hi, step=0.1, dec=2, suffix=" mm"):
            s = self._dspin(getattr(p, key), lo, hi, step, dec, suffix)
            s.valueChanged.connect(self.schedule_refresh)
            self.dims[key] = s
            f.addRow(label, s)

        def add_cb(key, label):
            c = QCheckBox()
            c.setChecked(getattr(p, key))
            c.toggled.connect(self.schedule_refresh)
            self.dims[key] = c
            f.addRow(label, c)

        f.addRow(QLabel("<b>Musterseite</b>"))
        add("pattern_height", "Höhe", 1, 50, 0.5, 2)
        add("pattern_wall", "Stegdicke", 0.3, 5, 0.05, 2)
        add("pattern_frame", "Rahmendicke", 0.3, 5, 0.05, 2)
        f.addRow(QLabel("<b>Rückseite (Versteifung)</b>"))
        add("back_height", "Höhe", 1, 50, 0.5, 2)
        add("back_wall", "Stegdicke", 0.5, 10, 0.1, 2)
        add("strut_wall", "Haltesteg-Dicke", 0.5, 10, 0.1, 2)
        add("back_frame", "Rahmendicke", 0.5, 15, 0.1, 2)
        add("lip_width", "Rahmenkragen Breite", 0, 30, 0.5, 2)
        add("lip_height", "Rahmenkragen Höhe", 0, 20, 0.5, 2)
        f.addRow(QLabel("<b>Nut für Metallring</b>"))
        add_cb("groove_on", "Nut aktiv")
        add("groove_inner_diameter", "Innendurchmesser", 10, 600, 0.1, 2)
        add("groove_width", "Breite", 0.2, 20, 0.05, 2)
        add("groove_depth", "Tiefe (von Rückseite)", 0.2, 50, 0.1, 2)
        add("groove_cx", "Mittelpunkt x", -300, 300, 0.5, 2)
        add("groove_cy", "Mittelpunkt y", -300, 300, 0.5, 2)
        f.addRow(QLabel("<b>Druckhilfe (Mausohren)</b>"))
        add_cb("ears_on", "Mausohren")
        add("ear_radius", "Radius", 2, 40, 0.5, 1)
        s = QSpinBox()
        s.setRange(2, 15)
        s.setValue(p.ears_per_side)
        s.valueChanged.connect(self.schedule_refresh)
        self.dims["ears_per_side"] = s
        f.addRow("pro Seite", s)
        add("ear_height", "Dicke", 0.1, 2, 0.05, 2)
        self.refresh_timer = QTimer(self)
        self.refresh_timer.setSingleShot(True)
        self.refresh_timer.timeout.connect(self.refresh)
        return b

    def _box_export(self):
        b = QGroupBox("5. Export")
        v = QVBoxLayout(b)
        self.cb_mirror = QCheckBox("Spiegelverkehrt exportieren")
        self.cb_mirror.setToolTip("Nur nötig, wenn die Schablone seitenverkehrt zur Zeichnung sein soll.")
        v.addWidget(self.cb_mirror)
        lbl = QLabel("Die STL ist druckfertig ausgerichtet: Rückseite mit Nut liegt auf der Druckplatte.")
        lbl.setWordWrap(True)
        lbl.setStyleSheet("color:#666")
        v.addWidget(lbl)
        v.addWidget(self._btn("STL speichern…", self.export_stl))
        v.addWidget(self._btn("Projekt speichern…", self.save_project,
                              "Speichert Linien, Haltestege und Maße, um später weiterzuarbeiten."))
        return b

    def _view_toggles(self):
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(0, 0, 0, 0)
        self.cb_show_img = QCheckBox("Zeichnung")
        self.cb_show_back = QCheckBox("Rückseite")
        self.cb_show_pat = QCheckBox("Musterseite")
        self.cb_show_groove = QCheckBox("Nut")
        for c in (self.cb_show_img, self.cb_show_back, self.cb_show_pat, self.cb_show_groove):
            c.setChecked(True)
            c.toggled.connect(self.redraw)
            h.addWidget(c)
        h.addStretch(1)
        h.addWidget(self._btn("Einpassen", lambda: self.view.fit()))
        return w

    def _set_enabled(self, on):
        for w in self.findChildren(QPushButton):
            if w.text() not in ("Bild öffnen…", "Projekt öffnen…"):
                w.setEnabled(on)

    # ------------------------------------------------------------------ Hilfen
    def busy(self, fn, msg):
        self.statusBar().showMessage(msg)
        QApplication.setOverrideCursor(Qt.WaitCursor)
        QApplication.processEvents()
        try:
            return fn()
        except Exception as e:
            traceback.print_exc()
            QMessageBox.critical(self, "Fehler", f"{msg}\n\n{e}")
        finally:
            QApplication.restoreOverrideCursor()

    def read_params(self):
        p = self.project.params
        for k, w in self.dims.items():
            if isinstance(w, QCheckBox):
                setattr(p, k, w.isChecked())
            elif isinstance(w, QSpinBox):
                setattr(p, k, int(w.value()))
            else:
                setattr(p, k, float(w.value()))
        p.tile_mm = float(self.sp_tile.value())
        p.strut_max_span = float(self.sp_span.value())
        p.strut_max_len = float(self.sp_maxlen.value())
        p.mirror = self.cb_mirror.isChecked()
        self.project.fit.tol_mm = float(self.sp_tol.value())
        self.project.threshold = None if self.cb_auto_thr.isChecked() else int(self.sl_thr.value())

    def write_params(self):
        p = self.project.params
        for k, w in self.dims.items():
            w.blockSignals(True)
            if isinstance(w, QCheckBox):
                w.setChecked(bool(getattr(p, k)))
            else:
                w.setValue(getattr(p, k))
            w.blockSignals(False)
        self.sp_tile.setValue(p.tile_mm)
        self.sp_span.setValue(p.strut_max_span)
        self.sp_maxlen.setValue(p.strut_max_len)
        self.cb_mirror.setChecked(p.mirror)
        self.sp_tol.setValue(self.project.fit.tol_mm)

    def update_symmetry_ui(self):
        sc = self.project.scores
        for k, cb in self.cb_sym.items():
            s = f"  ({sc[k] * 100:.0f} % Übereinstimmung)" if k in sc else ""
            cb.setText(sym.LABELS[k] + s)
            cb.setChecked(k in self.project.group)
        self.lbl_sym.setText("Aktiv: <b>" + sym.describe(self.project.group) + "</b>")

    # ------------------------------------------------------------------ Aktionen
    def open_image(self):
        path, _ = QFileDialog.getOpenFileName(self, "Zeichnung öffnen", "",
                                              "Bilder (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        self.project = Project(params=self.project.params, fit=self.project.fit)
        self.project_path = None
        self.read_params()
        self.project.load_image(path)
        self.detect()

    def detect(self):
        if self.project.gray is None:
            if self.project.rect is not None:
                self.read_params()
                self.busy(self.project.rebuild_curves, "Linien werden neu erkannt …")
                self.after_change(fit=True)
            return
        self.read_params()
        r = self.busy(lambda: (self.project.detect(), True)[1], "Zeichnung wird erkannt …")
        if r:
            self.busy(self.project.suggest_struts, "Haltestege werden vorgeschlagen …")
            self.update_symmetry_ui()
            self.after_change(fit=True)
            n = len(self.project.curves)
            self.statusBar().showMessage(
                f"{n} Linien erkannt, Strichstärke ca. {self.project.rect.line_width_mm:.1f} mm, "
                f"{sym.describe(self.project.group)}, {len(self.project.struts)} Haltestege vorgeschlagen.")

    def apply_symmetry(self):
        names = [k for k, cb in self.cb_sym.items() if cb.isChecked()]
        self.read_params()

        def run():
            self.project.set_symmetry(names)
            self.project.suggest_struts()
        self.busy(run, "Symmetrie wird angewendet …")
        self.update_symmetry_ui()
        self.after_change()

    def suggest_struts(self):
        self.read_params()
        self.busy(self.project.suggest_struts, "Haltestege werden berechnet …")
        self.after_change()
        self.statusBar().showMessage(f"{len(self.project.struts)} Haltestege vorgeschlagen.")

    def clear_struts(self):
        self.project.struts = []
        self.after_change()

    def set_mode(self, k):
        self.mode = k
        self.pending = None
        self.clear_rubber()
        self.view.setDragMode(QGraphicsView.ScrollHandDrag if k == "view" else QGraphicsView.NoDrag)
        self.view.setCursor(Qt.ArrowCursor if k == "view" else Qt.CrossCursor)
        hints = {"view": "Ansehen: Maus ziehen zum Verschieben, Mausrad zum Zoomen.",
                 "add": "Steg setzen: Anfangspunkt anklicken (rastet an Linien ein).",
                 "del": "Steg löschen: Haltesteg anklicken.",
                 "delcurve": "Linie löschen: Musterlinie anklicken."}
        self.statusBar().showMessage(hints[k])

    def snap(self, x, y):
        p = self.project
        geoms = [curve_geom(c) for c in p.curves] + [_frame_line(p.params)]
        geoms += [LineString(s) for s in p.struts]
        target = unary_union(geoms)
        q = Point(x, y)
        _, n = nearest_points(q, target)
        if q.distance(n) < 6.0:
            return np.array(n.coords[0])
        return np.array([x, y])

    def on_click(self, x, y):
        p = self.project
        if not p.curves:
            return
        if self.mode == "add":
            pt = self.snap(x, y)
            if self.pending is None:
                self.pending = pt
                self.statusBar().showMessage("Steg setzen: Endpunkt anklicken.")
            else:
                if np.linalg.norm(pt - self.pending) > 1.0:
                    p.add_strut(self.pending, pt)
                self.pending = None
                self.clear_rubber()
                self.after_change()
                self.statusBar().showMessage("Steg gesetzt. Nächsten Anfangspunkt anklicken.")
        elif self.mode == "del":
            q = Point(x, y)
            if not p.struts:
                return
            d = [LineString(s).distance(q) for s in p.struts]
            i = int(np.argmin(d))
            if d[i] < 3.0:
                p.delete_strut(i)
                self.after_change()
        elif self.mode == "delcurve":
            q = Point(x, y)
            d = [curve_geom(c).distance(q) for c in p.curves]
            i = int(np.argmin(d))
            if d[i] < 3.0:
                p.delete_curve(i)
                self.after_change()

    def on_move(self, x, y):
        if self.mode == "add" and self.pending is not None:
            pt = self.snap(x, y)
            self.clear_rubber()
            path = line_path([self.pending, pt])
            self.rubber = self.scene.addPath(path, QPen(COL_STRUT, 0.8, Qt.DashLine))

    def clear_rubber(self):
        if self.rubber is not None:
            self.scene.removeItem(self.rubber)
            self.rubber = None

    def schedule_refresh(self):
        self.refresh_timer.start(400)

    def refresh(self):
        if not self.project.curves:
            return
        self.read_params()
        self.after_change()

    def after_change(self, fit=False):
        self.layers = self.busy(self.project.layers, "Vorschau wird berechnet …")
        self.redraw()
        if fit:
            self.view.fit()
        self._set_enabled(bool(self.project.curves))
        if self.mode == "view":
            self.statusBar().clearMessage()

    def redraw(self):
        self.scene.clear()
        self.rubber = None
        p = self.project
        if p.rect is not None and self.cb_show_img.isChecked():
            g = p.rect.gray
            img = QImage(g.data, g.shape[1], g.shape[0], g.strides[0], QImage.Format_Grayscale8).copy()
            item = QGraphicsPixmapItem(QPixmap.fromImage(img))
            item.setOpacity(0.35)
            s = 1.0 / vision.PX_PER_MM
            item.setScale(s)
            off = p.params.tile_mm / 2 + vision.PAD_MM
            item.setPos(-off, -off)
            self.scene.addItem(item)
        L = self.layers
        if L is None:
            return
        nopen = QPen(Qt.NoPen)
        if L.ears is not None and self.cb_show_back.isChecked():
            self.scene.addPath(geom_path(L.ears), nopen, QBrush(COL_EARS))
        if self.cb_show_back.isChecked():
            self.scene.addPath(geom_path(L.back), nopen, QBrush(COL_BACK))
            if L.lip is not None:
                self.scene.addPath(geom_path(L.lip), nopen, QBrush(COL_BACK))
            pen = QPen(COL_STRUT, 0.6)
            for s in p.struts:
                self.scene.addPath(line_path(s), pen)
        if L.groove is not None and self.cb_show_groove.isChecked():
            self.scene.addPath(geom_path(L.groove), nopen, QBrush(COL_GROOVE))
        if self.cb_show_pat.isChecked():
            self.scene.addPath(geom_path(L.pattern), nopen, QBrush(COL_PATTERN))

    def export_stl(self):
        self.read_params()
        start = os.path.splitext(self.project_path or self.project.image_path or "Fliese")[0] + ".stl"
        path, _ = QFileDialog.getSaveFileName(self, "STL speichern", start, "STL (*.stl)")
        if not path:
            return
        n = self.busy(lambda: self.project.export_stl(path), "3D-Modell wird erzeugt …")
        if n:
            self.statusBar().showMessage(f"Gespeichert: {path} ({n:,} Dreiecke)".replace(",", "."))

    def save_project(self):
        self.read_params()
        start = self.project_path or os.path.splitext(self.project.image_path or "Fliese")[0] + ".fliese"
        path, _ = QFileDialog.getSaveFileName(self, "Projekt speichern", start, "Fliesen-Projekt (*.fliese)")
        if not path:
            return
        self.busy(lambda: self.project.save(path), "Projekt wird gespeichert …")
        self.project_path = path
        self.statusBar().showMessage(f"Projekt gespeichert: {path}")

    def open_project(self):
        path, _ = QFileDialog.getOpenFileName(self, "Projekt öffnen", "", "Fliesen-Projekt (*.fliese)")
        if not path:
            return
        p = self.busy(lambda: Project.load(path), "Projekt wird geladen …")
        if p is None:
            return
        self.project = p
        self.project_path = path
        self.write_params()
        self.update_symmetry_ui()
        self.after_change(fit=True)

    # ------------------------------------------------------------------ Updates
    def check_updates(self):
        if not updater.GITHUB_REPO:
            return

        def run():
            try:
                info = updater.check_latest()
                if info and updater.is_newer(info[0]):
                    self.upd.found.emit(*info)
            except Exception:
                pass  # offline o. ä. – einfach weiterarbeiten
        threading.Thread(target=run, daemon=True).start()

    def offer_update(self, version, url, notes):
        txt = f"Es gibt eine neue Version: <b>{version}</b> (installiert: {__version__}).<br><br>"
        if notes:
            txt += notes.replace("\n", "<br>")[:1200] + "<br><br>"
        txt += "Jetzt aktualisieren? Das Programm startet danach neu."
        if QMessageBox.question(self, "Update verfügbar", txt) != QMessageBox.Yes:
            return
        dlg = QProgressDialog("Update wird heruntergeladen …", "Abbrechen", 0, 100, self)
        dlg.setWindowModality(Qt.WindowModal)
        dlg.show()

        def prog(done, total):
            if total:
                dlg.setValue(int(done * 100 / total))
            QApplication.processEvents()
        try:
            new = updater.download(url, prog)
        except Exception as e:
            dlg.close()
            QMessageBox.warning(self, "Update", f"Download fehlgeschlagen:\n{e}")
            return
        dlg.close()
        if updater.apply_and_restart(new):
            QApplication.quit()
        else:
            QMessageBox.information(self, "Update", f"Neue Version heruntergeladen nach:\n{new}")


def main():
    app = QApplication(sys.argv)
    app.setApplicationName("Fliesenschablone")
    icon_path = os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(__file__))),
                             "assets", "icon.png")
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))
    w = MainWindow()
    w.show()
    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        w.project.load_image(sys.argv[1])
        w.detect()
    sys.exit(app.exec())
