"""Oberfläche: Zeichnung laden, Ergebnis prüfen, bearbeiten, STL speichern."""
from __future__ import annotations

import os
import sys
import threading
import traceback

import numpy as np
from PySide6.QtCore import Qt, QTimer, Signal, QObject
from PySide6.QtGui import (QBrush, QColor, QImage, QPainter, QPainterPath, QPen, QPixmap, QIcon,
                           QKeySequence, QShortcut, QFont)
from PySide6.QtWidgets import (QApplication, QButtonGroup, QCheckBox, QDoubleSpinBox, QFileDialog,
                               QFormLayout, QGraphicsPixmapItem, QGraphicsScene, QGraphicsView, QGroupBox,
                               QHBoxLayout, QLabel, QMainWindow, QMessageBox, QProgressDialog, QPushButton,
                               QScrollArea, QSpinBox, QSlider, QToolButton, QVBoxLayout, QWidget, QFrame)
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points, unary_union

from . import symmetry as sym
from . import updater, vision
from .editing import History, bend, orbit, make_curve, add_curve_symmetric, densify
from .geometry import curve_geom, _frame_line
from .project import Project
from .version import __version__

COL_PATTERN = QColor("#1d3557")
COL_BACK = QColor(244, 162, 97, 150)
COL_STRUT = QColor("#e63946")
COL_GROOVE = QColor(42, 157, 143, 170)
COL_EARS = QColor(180, 180, 180, 90)
COL_HOVER_DEL = QColor(230, 57, 70, 200)
COL_HOVER = QColor(255, 183, 3, 220)
COL_DRAW = QColor("#2a9d8f")


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


def line_path(pts, closed=False) -> QPainterPath:
    path = QPainterPath()
    if len(pts) == 0:
        return path
    path.moveTo(pts[0][0], -pts[0][1])
    for x, y in pts[1:]:
        path.lineTo(x, -y)
    if closed:
        path.closeSubpath()
    return path


class View(QGraphicsView):
    """Zeichenfläche. Mausrad = Zoom, mittlere/rechte Maustaste ziehen = verschieben (immer)."""
    pressed = Signal(float, float)
    moved = Signal(float, float, bool)     # x, y, linke Taste gedrückt
    released = Signal(float, float)
    double = Signal(float, float)
    right_click = Signal(float, float)

    def __init__(self, scene):
        super().__init__(scene)
        self.setRenderHint(QPainter.Antialiasing)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setMouseTracking(True)
        self.setBackgroundBrush(QColor("#f1f1ee"))
        self.left_pans = True
        self._pan = None
        self._pan_moved = False
        self._left_down = False

    def mm(self, e):
        p = self.mapToScene(e.position().toPoint())
        return p.x(), -p.y()

    def px_to_mm(self, px):
        s = abs(self.transform().m11()) or 1.0
        return px / s

    def wheelEvent(self, e):
        f = 1.2 if e.angleDelta().y() > 0 else 1 / 1.2
        self.scale(f, f)

    def mousePressEvent(self, e):
        if e.button() in (Qt.MiddleButton, Qt.RightButton) or (e.button() == Qt.LeftButton and self.left_pans):
            self._pan = e.position()
            self._pan_moved = False
            self._pan_btn = e.button()
            self.viewport().setCursor(Qt.ClosedHandCursor)
            if e.button() == Qt.LeftButton:
                self._left_down = True
            return
        if e.button() == Qt.LeftButton:
            self._left_down = True
            self.pressed.emit(*self.mm(e))

    def mouseMoveEvent(self, e):
        if self._pan is not None:
            d = e.position() - self._pan
            if d.manhattanLength() > 3:
                self._pan_moved = True
            self._pan = e.position()
            self.horizontalScrollBar().setValue(self.horizontalScrollBar().value() - int(d.x()))
            self.verticalScrollBar().setValue(self.verticalScrollBar().value() - int(d.y()))
            return
        self.moved.emit(*self.mm(e), self._left_down)

    def mouseReleaseEvent(self, e):
        if self._pan is not None and e.button() == self._pan_btn:
            self._pan = None
            self.viewport().unsetCursor()
            self._left_down = False
            if e.button() == Qt.RightButton and not self._pan_moved:
                self.right_click.emit(*self.mm(e))
            return
        if e.button() == Qt.LeftButton:
            self._left_down = False
            self.released.emit(*self.mm(e))

    def mouseDoubleClickEvent(self, e):
        if e.button() == Qt.LeftButton:
            self.double.emit(*self.mm(e))

    def fit(self):
        r = self.scene().itemsBoundingRect()
        if not r.isEmpty():
            self.fitInView(r.adjusted(-5, -5, 5, 5), Qt.KeepAspectRatio)


class UpdateSignals(QObject):
    found = Signal(str, str, str)


TOOLS = [
    ("view", "✋  Ansehen", "Esc"),
    ("strut", "＋  Haltesteg", "S"),
    ("delete", "✕  Löschen", "D"),
    ("bend", "〰  Linie biegen", "B"),
    ("draw", "✎  Linie zeichnen", "L"),
]

HINTS = {
    "view": "Ansehen – Maus ziehen = verschieben, Mausrad = zoomen.",
    "strut": "Haltesteg – Anfang und Ende anklicken (rastet an Linien ein). "
             "Vorhandenen Steg am Ende anfassen und ziehen = verschieben.",
    "delete": "Löschen – Haltesteg oder Linie anklicken. Was gelöscht wird, leuchtet rot auf.",
    "bend": "Linie biegen – Linie anfassen und ziehen. Der gelbe Kreis zeigt, wie weit sich die Änderung auswirkt.",
    "draw": "Linie zeichnen – Punkte anklicken. Doppelklick oder Enter = fertig, Rücktaste = letzten Punkt weg, Esc = abbrechen.",
}


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"Fliesenschablone {__version__}")
        self.resize(1400, 900)
        self.project = Project()
        self.history = History()
        self.layers = None
        self.mode = "view"
        self.project_path = None
        self.overlay = []         # temporäre Hervorhebungen
        self.pending = None       # Haltesteg: erster Punkt
        self.drag = None          # laufender Zieh-Vorgang
        self.draw_pts = []        # Linie zeichnen
        self._orbit_cache = {}

        self.scene = QGraphicsScene()
        self.view = View(self.scene)
        self.view.pressed.connect(self.on_press)
        self.view.moved.connect(self.on_move)
        self.view.released.connect(self.on_release)
        self.view.double.connect(self.on_double)
        self.view.right_click.connect(lambda x, y: self.finish_draw() if self.mode == "draw" else None)

        side = QWidget()
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
        scroll.setMinimumWidth(400)
        scroll.setMaximumWidth(470)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)

        central = QWidget()
        h = QHBoxLayout(central)
        h.setContentsMargins(4, 4, 4, 4)
        h.addWidget(scroll)
        right = QVBoxLayout()
        right.addWidget(self._toolbar())
        self.hint = QLabel()
        self.hint.setWordWrap(True)
        self.hint.setStyleSheet("background:#fff8e1; border:1px solid #f0d58a; border-radius:4px;"
                                "padding:6px 10px; font-size:13px;")
        right.addWidget(self.hint)
        right.addWidget(self.view, 1)
        right.addWidget(self._view_toggles())
        h.addLayout(right, 1)
        self.setCentralWidget(central)
        self.statusBar().showMessage("Bild einer Zeichnung öffnen, um zu starten.")
        self.set_mode("view")
        self._set_enabled(False)

        QShortcut(QKeySequence.Undo, self, self.undo)
        QShortcut(QKeySequence("Ctrl+Y"), self, self.redo)
        QShortcut(QKeySequence.Redo, self, self.redo)
        for key, _, sc in TOOLS:
            QShortcut(QKeySequence(sc), self, lambda k=key: self.key_tool(k))
        QShortcut(QKeySequence(Qt.Key_Return), self, self.finish_draw)
        QShortcut(QKeySequence(Qt.Key_Enter), self, self.finish_draw)
        QShortcut(QKeySequence(Qt.Key_Backspace), self, self.draw_backspace)

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

    def _toolbar(self):
        w = QFrame()
        w.setStyleSheet("QToolButton{padding:6px 12px; font-size:13px;}"
                        "QToolButton:checked{background:#1d3557; color:white; border-radius:4px;}")
        h = QHBoxLayout(w)
        h.setContentsMargins(0, 0, 0, 0)
        self.tool_group = QButtonGroup(self)
        self.tool_buttons = {}
        for key, text, sc in TOOLS:
            t = QToolButton()
            t.setText(f"{text}  ({sc})")
            t.setCheckable(True)
            t.clicked.connect(lambda _=False, k=key: self.set_mode(k))
            self.tool_group.addButton(t)
            self.tool_buttons[key] = t
            h.addWidget(t)
        h.addSpacing(12)
        h.addWidget(QLabel("Biegebereich"))
        self.sp_bend = self._dspin(12, 2, 80, 1, 0)
        self.sp_bend.setToolTip("Wie weit sich das Biegen entlang der Linie auswirkt")
        h.addWidget(self.sp_bend)
        h.addStretch(1)
        self.btn_undo = QToolButton()
        self.btn_undo.setText("↶ Rückgängig")
        self.btn_undo.setToolTip("Strg+Z")
        self.btn_undo.clicked.connect(self.undo)
        self.btn_redo = QToolButton()
        self.btn_redo.setText("↷ Wiederholen")
        self.btn_redo.setToolTip("Strg+Y")
        self.btn_redo.clicked.connect(self.redo)
        h.addWidget(self.btn_undo)
        h.addWidget(self.btn_redo)
        return w

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
        f.addRow(self._btn("Neu erkennen", self.detect))
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
                              "Linien werden an allen gewählten Achsen gespiegelt."))
        return b

    def _box_struts(self):
        b = QGroupBox("3. Haltestege")
        v = QVBoxLayout(b)
        f = QFormLayout()
        self.sp_span = self._dspin(45, 10, 200, 5, 0)
        self.sp_span.setToolTip("Längster Steg-Abschnitt ohne Abstützung")
        self.sp_maxlen = self._dspin(40, 5, 150, 5, 0)
        self.sp_maxlen.setToolTip("Längster erlaubter Haltesteg")
        f.addRow("max. freie Länge", self.sp_span)
        f.addRow("max. Haltesteg-Länge", self.sp_maxlen)
        v.addLayout(f)
        v.addWidget(self._btn("Haltestege neu vorschlagen", self.suggest_struts))
        v.addWidget(self._btn("Alle Haltestege entfernen", self.clear_struts))
        lbl = QLabel("Bearbeiten mit den Werkzeugen über der Zeichnung. "
                     "Alles wird automatisch an den Symmetrieachsen mitgespiegelt.")
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
        h.addWidget(QLabel("Anzeigen:"))
        self.cb_show_img = QCheckBox("Zeichnung")
        self.cb_show_back = QCheckBox("Rückseite")
        self.cb_show_pat = QCheckBox("Musterseite")
        self.cb_show_groove = QCheckBox("Nut")
        for c in (self.cb_show_img, self.cb_show_back, self.cb_show_pat, self.cb_show_groove):
            c.setChecked(True)
            c.toggled.connect(self.redraw)
            h.addWidget(c)
        h.addStretch(1)
        h.addWidget(QLabel("Mausrad = Zoom · rechte Maustaste ziehen = verschieben"))
        h.addWidget(self._btn("Einpassen", lambda: self.view.fit()))
        return w

    def _set_enabled(self, on):
        for w in self.findChildren(QPushButton):
            if w.text() not in ("Bild öffnen…", "Projekt öffnen…"):
                w.setEnabled(on)
        for t in self.tool_buttons.values():
            t.setEnabled(on)
        self.update_undo_buttons()

    def update_undo_buttons(self):
        self.btn_undo.setEnabled(bool(self.history.undo_stack))
        self.btn_redo.setEnabled(bool(self.history.redo_stack))

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

    def tol(self, px=10):
        return self.view.px_to_mm(px)

    def snap(self, x, y, exclude_strut=None):
        p = self.project
        geoms = [curve_geom(c) for c in p.curves] + [_frame_line(p.params)]
        geoms += [LineString(s) for i, s in enumerate(p.struts) if i != exclude_strut]
        target = unary_union(geoms)
        q = Point(x, y)
        _, n = nearest_points(q, target)
        if q.distance(n) < self.tol(14):
            return np.array(n.coords[0]), True
        return np.array([x, y]), False

    def nearest_strut(self, x, y):
        q = Point(x, y)
        if not self.project.struts:
            return None, 1e9
        d = [LineString(s).distance(q) for s in self.project.struts]
        i = int(np.argmin(d))
        return i, d[i]

    def nearest_curve(self, x, y):
        q = Point(x, y)
        if not self.project.curves:
            return None, 1e9
        d = [curve_geom(c).distance(q) for c in self.project.curves]
        i = int(np.argmin(d))
        return i, d[i]

    def orbit_of(self, i):
        key = (i, len(self.project.curves))
        if key not in self._orbit_cache:
            self._orbit_cache[key] = [j for j, _ in orbit(self.project.curves, i, self.project.group)] or [i]
        return self._orbit_cache[key]

    def clear_overlay(self):
        for it in self.overlay:
            if it.scene() is self.scene:
                self.scene.removeItem(it)
        self.overlay = []

    def add_overlay(self, path, pen, brush=None):
        it = self.scene.addPath(path, pen, brush or QBrush(Qt.NoBrush))
        it.setZValue(10)
        self.overlay.append(it)
        return it

    def marker(self, pt, color, r_px=6):
        r = self.view.px_to_mm(r_px)
        path = QPainterPath()
        path.addEllipse(pt[0] - r, -pt[1] - r, 2 * r, 2 * r)
        self.add_overlay(path, QPen(color, self.view.px_to_mm(2)), QBrush(QColor(255, 255, 255, 180)))

    def push_history(self):
        self.history.push(self.project)
        self.update_undo_buttons()

    # ------------------------------------------------------------------ Werkzeuge
    def key_tool(self, k):
        if k == "view" and self.mode == "draw" and self.draw_pts:
            self.draw_pts = []
            self.clear_overlay()
            return
        if self.project.curves or k == "view":
            self.set_mode(k)

    def set_mode(self, k):
        self.mode = k
        self.pending = None
        self.drag = None
        self.draw_pts = []
        self.clear_overlay()
        self.tool_buttons[k].setChecked(True)
        self.view.left_pans = (k == "view")
        self.view.viewport().setCursor(Qt.OpenHandCursor if k == "view" else Qt.CrossCursor)
        self.hint.setText(HINTS[k])

    def on_press(self, x, y):
        p = self.project
        if not p.curves:
            return
        tol = self.tol(10)
        if self.mode == "strut":
            # vorhandenen Steg am Ende anfassen?
            for i, (a, b) in enumerate(p.struts):
                for end, q in ((0, a), (1, b)):
                    if np.hypot(q[0] - x, q[1] - y) < tol:
                        self.drag = ("strut_end", i, end)
                        return
        elif self.mode == "bend":
            i, d = self.nearest_curve(x, y)
            if i is not None and d < tol:
                g = curve_geom(p.curves[i])
                q = np.array(g.interpolate(g.project(Point(x, y))).coords[0])
                self.drag = ("bend", i, q, self.orbit_of(i))

    def on_move(self, x, y, left_down):
        p = self.project
        if not p.curves:
            return
        self.clear_overlay()
        tol = self.tol(10)
        if self.mode == "strut":
            if self.drag and self.drag[0] == "strut_end":
                _, i, end = self.drag
                pt, _ = self.snap(x, y, exclude_strut=i)
                s = list(p.struts[i])
                s[end] = pt
                self.add_overlay(line_path(s), QPen(COL_HOVER, self.view.px_to_mm(4)))
                self.marker(pt, COL_HOVER)
                return
            pt, snapped = self.snap(x, y)
            if self.pending is not None:
                self.add_overlay(line_path([self.pending, pt]),
                                 QPen(COL_STRUT, self.view.px_to_mm(3), Qt.DashLine))
                self.marker(self.pending, COL_STRUT)
            self.marker(pt, COL_STRUT if snapped else QColor("#999"))
            for a, b in p.struts:
                for q in (a, b):
                    if np.hypot(q[0] - x, q[1] - y) < tol:
                        self.marker(q, COL_HOVER, 8)
        elif self.mode == "delete":
            i, d = self.nearest_strut(x, y)
            if i is not None and d < tol:
                self.add_overlay(line_path(p.struts[i]), QPen(COL_HOVER_DEL, self.view.px_to_mm(7)))
                self.statusBar().showMessage("Klicken: diesen Haltesteg löschen (Spiegelbilder werden mitgelöscht)")
                return
            j, d = self.nearest_curve(x, y)
            if j is not None and d < tol:
                for k in self.orbit_of(j):
                    cc = p.curves[k]
                    self.add_overlay(line_path(cc.pts, cc.closed), QPen(COL_HOVER_DEL, self.view.px_to_mm(6)))
                self.statusBar().showMessage("Klicken: diese Linie löschen (Spiegelbilder werden mitgelöscht)")
            else:
                self.statusBar().clearMessage()
        elif self.mode == "bend":
            R = float(self.sp_bend.value())
            if self.drag and self.drag[0] == "bend":
                _, i, q, members = self.drag
                delta = np.array([x, y]) - q
                curves = bend(p.curves, [], i, q, delta, R, p.group, members, preview=True)
                for c in curves.values():
                    self.add_overlay(line_path(c.pts, c.closed), QPen(COL_HOVER, self.view.px_to_mm(4)))
                self.marker(np.array([x, y]), COL_HOVER)
                return
            i, d = self.nearest_curve(x, y)
            if i is not None and d < tol:
                c = p.curves[i]
                self.add_overlay(line_path(c.pts, c.closed), QPen(COL_HOVER, self.view.px_to_mm(4)))
                g = curve_geom(c)
                q = np.array(g.interpolate(g.project(Point(x, y))).coords[0])
                path = QPainterPath()
                path.addEllipse(q[0] - R, -q[1] - R, 2 * R, 2 * R)
                self.add_overlay(path, QPen(COL_HOVER, self.view.px_to_mm(1.5), Qt.DashLine))
        elif self.mode == "draw":
            pts = list(self.draw_pts)
            pt, snapped = self.snap(x, y)
            if pts:
                preview = make_curve(pts + [pt]).pts if len(pts) >= 1 else None
                self.add_overlay(line_path(preview), QPen(COL_DRAW, self.view.px_to_mm(3)))
                for q in pts:
                    self.marker(q, COL_DRAW, 4)
            self.marker(pt, COL_DRAW if snapped else QColor("#999"))

    def on_release(self, x, y):
        p = self.project
        if not p.curves:
            return
        tol = self.tol(10)
        if self.mode == "strut":
            if self.drag and self.drag[0] == "strut_end":
                _, i, end = self.drag
                self.drag = None
                pt, _ = self.snap(x, y, exclude_strut=i)
                s = [np.array(p.struts[i][0]), np.array(p.struts[i][1])]
                if np.linalg.norm(pt - s[end]) < 0.2:
                    return
                s[end] = pt
                self.push_history()
                p.delete_strut(i)
                p.add_strut(s[0], s[1])
                self.after_change()
                return
            pt, _ = self.snap(x, y)
            if self.pending is None:
                self.pending = pt
                self.hint.setText("Haltesteg – jetzt den Endpunkt anklicken. (Esc = abbrechen)")
            else:
                if np.linalg.norm(pt - self.pending) > 1.0:
                    self.push_history()
                    p.add_strut(self.pending, pt)
                    self.after_change()
                self.pending = None
                self.hint.setText(HINTS["strut"])
        elif self.mode == "delete":
            i, d = self.nearest_strut(x, y)
            if i is not None and d < tol:
                self.push_history()
                p.delete_strut(i)
                self.after_change()
                return
            j, d = self.nearest_curve(x, y)
            if j is not None and d < tol:
                self.push_history()
                p.delete_curve(j)
                self.after_change()
        elif self.mode == "bend":
            if self.drag and self.drag[0] == "bend":
                _, i, q, members = self.drag
                self.drag = None
                delta = np.array([x, y]) - q
                if np.linalg.norm(delta) < 0.05:
                    return
                self.push_history()
                p.curves, p.struts = bend(p.curves, p.struts, i, q, delta,
                                          float(self.sp_bend.value()), p.group, members)
                self.after_change()
        elif self.mode == "draw":
            pt, _ = self.snap(x, y)
            if self.draw_pts and np.linalg.norm(pt - self.draw_pts[-1]) < 0.5:
                return
            self.draw_pts.append(pt)
            self.on_move(x, y, False)

    def on_double(self, x, y):
        if self.mode == "draw":
            self.finish_draw()

    def finish_draw(self):
        if self.mode != "draw" or len(self.draw_pts) < 2:
            return
        pts = self.draw_pts
        self.draw_pts = []
        self.push_history()
        c = make_curve(pts)
        self.project.curves = add_curve_symmetric(self.project.curves, c, self.project.group)
        self.after_change()

    def draw_backspace(self):
        if self.mode == "draw" and self.draw_pts:
            self.draw_pts.pop()
            self.clear_overlay()

    def undo(self):
        if self.history.undo(self.project):
            self.after_change()
            self.update_symmetry_ui()

    def redo(self):
        if self.history.redo(self.project):
            self.after_change()
            self.update_symmetry_ui()

    # ------------------------------------------------------------------ Aktionen
    def open_image(self):
        path, _ = QFileDialog.getOpenFileName(self, "Zeichnung öffnen", "",
                                              "Bilder (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        self.load_image(path)

    def load_image(self, path):
        self.project = Project(params=self.project.params, fit=self.project.fit)
        self.project_path = None
        self.history.clear()
        self.read_params()
        self.project.load_image(path)
        self.detect(push=False)

    def detect(self, push=True):
        if push and self.project.curves:
            self.push_history()
        if self.project.gray is None:
            if self.project.rect is not None:
                self.read_params()
                self.busy(self.project.rebuild_curves, "Linien werden neu erkannt …")
                self.busy(self.project.suggest_struts, "Haltestege werden vorgeschlagen …")
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
        self.push_history()

        def run():
            self.project.set_symmetry(names)
            self.project.suggest_struts()
        self.busy(run, "Symmetrie wird angewendet …")
        self.update_symmetry_ui()
        self.after_change()

    def suggest_struts(self):
        self.read_params()
        self.push_history()
        self.busy(self.project.suggest_struts, "Haltestege werden berechnet …")
        self.after_change()
        self.statusBar().showMessage(f"{len(self.project.struts)} Haltestege vorgeschlagen.")

    def clear_struts(self):
        self.push_history()
        self.project.struts = []
        self.after_change()

    def schedule_refresh(self):
        self.refresh_timer.start(400)

    def refresh(self):
        if not self.project.curves:
            return
        self.read_params()
        self.after_change()

    def after_change(self, fit=False):
        self._orbit_cache = {}
        self.layers = self.busy(self.project.layers, "Vorschau wird berechnet …")
        self.redraw()
        if fit:
            self.view.fit()
        self._set_enabled(bool(self.project.curves))
        self.statusBar().clearMessage()

    def redraw(self):
        self.overlay = []
        self.scene.clear()
        p = self.project
        if p.rect is not None and self.cb_show_img.isChecked():
            g = np.ascontiguousarray(p.rect.gray)
            img = QImage(g.data, g.shape[1], g.shape[0], g.strides[0], QImage.Format_Grayscale8).copy()
            item = QGraphicsPixmapItem(QPixmap.fromImage(img))
            item.setOpacity(0.35)
            item.setScale(1.0 / vision.PX_PER_MM)
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
        self.history.clear()
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
        w.load_image(sys.argv[1])
    sys.exit(app.exec())
