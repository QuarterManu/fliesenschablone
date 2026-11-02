# Fliesenschablone

Macht aus einer gezeichneten Zementfliesen-Vorlage (Foto oder Scan) ein druckfertiges
3D-Modell (STL) für die Probe-Schablone. Läuft komplett offline, ohne KI-Anbindung.

## Was das Programm macht

1. **Zeichnung einlesen**: Es findet das gezeichnete Quadrat (auch auf einem schräg
   fotografierten Blatt), entzerrt es und rechnet es auf die eingestellte Fliesengröße um.
2. **Linien glätten**: Gerade Linien werden exakt gerade und Bögen werden echte Kreisbögen.
   Mittelpunkte rasten an Ecken oder der Mitte ein, und Bögen um denselben Mittelpunkt
   bekommen denselben Radius. Kreise mit gleicher Größe werden exakt gleich groß, freie
   Formen werden zu glatten Kurven.
3. **Symmetrie erkennen**: Das Programm prüft alle Spiegelachsen und Drehungen und schlägt
   die passenden vor. Alles wird exakt gespiegelt, auch spätere Änderungen.
4. **Rückseite erzeugen**: Jede Musterlinie wird auf der Rückseite dicker, dazu kommen
   Rahmen, Rahmenkragen und die **Nut für den Metallring** mit festen Maßen.
5. **Haltestege vorschlagen**: Inseln wie die Kreise werden mit mindestens zwei Stegen
   angebunden, und lange freie Stege bekommen Querstege. Im Programm lassen sich Stege
   per Klick setzen und löschen.
6. **STL speichern**: Die Datei ist schon richtig herum ausgerichtet (Rückseite auf der
   Druckplatte, Mausohren inklusive) und kann direkt in Bambu Studio gezogen werden.

## Bedienung

- **Bild öffnen…**: Foto oder Scan der Zeichnung laden. Das ganze Quadrat muss zu sehen
  sein, am besten dunkle Linien auf hellem Papier.
- Das Ergebnis in der Vorschau prüfen:
  - dunkelblau: Musterstege
  - orange: Rückseite
  - rot: Haltestege
  - türkis: Nut
- Bei Bedarf **Glättung** oder **Helligkeitsschwelle** ändern und auf **Neu erkennen** klicken.
- Symmetrie-Häkchen anpassen und auf **Symmetrie übernehmen** klicken.
- Bearbeiten mit den Werkzeugen über der Zeichnung (in Klammern die Taste dafür):
  - **Ansehen (Esc)**: verschieben und zoomen
  - **Haltesteg (S)**: Anfang und Ende anklicken. Ein vorhandenes Stegende kann man anfassen und verschieben.
  - **Löschen (D)**: Haltesteg oder Linie anklicken. Was gelöscht wird, leuchtet vorher rot auf.
  - **Linie biegen (B)**: Linie anfassen und ziehen. Der gelbe Kreis zeigt den Biegebereich.
  - **Linie zeichnen (L)**: Punkte anklicken. Doppelklick oder Enter beendet die Linie.
  - **Rückgängig / Wiederholen**: Strg+Z / Strg+Y
  - Mausrad zoomt, mit der rechten Maustaste ziehen verschiebt die Ansicht, und das in jedem Werkzeug.
  - Alles wird automatisch an den Symmetrieachsen mitgespiegelt.
- **STL speichern…** wählen und die Datei in den Slicer ziehen.
- **Projekt speichern…** sichert alles in einer `.fliese`-Datei zum späteren Weiterarbeiten.

Tipp: Sauberer wird es, wenn nur ein Teil gezeichnet wird, also ein Achtel oder Viertel.
Den Rest ergänzt die Symmetrie. Die Häkchen müssen dann von Hand gesetzt werden.

## Standardmaße

Die Standardmaße sind aus der Referenzdatei `01_Ringe.stl` übernommen:

| | Wert |
|---|---|
| Fliese | 200 × 200 mm |
| Musterstege | 12 mm hoch, 1,0 mm dick (Rahmen 0,95 mm) |
| Rückseite | 12 mm hoch, Stege 3 mm, Rahmen 3 mm, Kragen 6 mm breit / 2 mm hoch |
| Nut | Innen-Ø 151 mm, 2 mm breit, 6 mm tief von der Rückseite, Mitte = Fliesenmitte |
| Mausohren | 5 pro Seite, Radius 18 mm, 0,2 mm dick |

Alle Werte lassen sich im Programm unter **4. Maße** ändern.

---

## Für Entwickler: Veröffentlichen und automatische Updates

Das Programm prüft beim Start, ob es auf GitHub ein neueres Release gibt. Wenn ja, fragt es
nach, lädt die neue `.exe` herunter, ersetzt sich selbst und startet neu.

### Einmalig einrichten

1. Ein **öffentliches** GitHub-Repository anlegen, z. B. `fliesenschablone`. Die
   Update-Prüfung funktioniert ohne Anmeldung nur bei öffentlichen Repositories.
2. Diesen Ordner hochladen:
   ```bash
   git init
   git add .
   git commit -m "Erste Version"
   git branch -M main
   git remote add origin https://github.com/BENUTZER/fliesenschablone.git
   git push -u origin main
   ```

### Neue Version veröffentlichen

In der Datei `VERSION` die Nummer erhöhen (z. B. `0.2.0` → `0.2.1`), dann:

```bash
git add .
git commit -m "Version 0.2.1"
git push
```

Alternativ funktioniert weiterhin ein Tag: `git tag v0.2.1` und `git push origin v0.2.1`.

GitHub Actions (`.github/workflows/release.yml`) erledigt dann automatisch:

- die Tests ausführen
- die Windows-`.exe` bauen
- Versionsnummer und Repository-Name ins Programm schreiben
- ein Release `v0.2.1` mit `Fliesenschablone.exe` anlegen

Nach etwa 10 Minuten steht die `.exe` unter *Releases* bereit. Alle installierten Programme
bekommen das Update beim nächsten Start angeboten.

### Lokal starten (ohne .exe)

```bash
pip install -r requirements.txt
python main.py
python -m tests.test_pipeline   # Selbsttest
```

### Aufbau

| Datei | Inhalt |
|---|---|
| `app/vision.py` | Bild einlesen, Rahmen finden, entzerren, Linien-Skelett als Graph |
| `app/symmetry.py` | Symmetrie-Operationen des Quadrats, Erkennung |
| `app/pattern.py` | Glättung: Geraden, Bögen, Kreise, Splines, Einrasten |
| `app/geometry.py` | Flächen für Muster, Rückseite, Nut, Mausohren; Haltestege-Vorschlag |
| `app/export3d.py` | 3D-Körper (manifold3d) und STL-Export |
| `app/project.py` | Projekt laden/speichern, Ablaufsteuerung |
| `app/gui.py` | Oberfläche (PySide6) |
| `app/updater.py` | Update über GitHub Releases |
