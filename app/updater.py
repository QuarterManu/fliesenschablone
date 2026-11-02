"""Automatische Updates über GitHub Releases.

Beim Programmstart wird geprüft, ob es auf GitHub ein neueres Release gibt.
Wenn ja, wird die neue .exe heruntergeladen, die alte nach dem Beenden
ersetzt und das Programm neu gestartet.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import urllib.request

from .version import __version__, GITHUB_REPO

ASSET_NAME = "Fliesenschablone.exe"


def _parse(v: str) -> tuple:
    v = v.strip().lstrip("vV")
    out = []
    for part in v.split("."):
        num = "".join(ch for ch in part if ch.isdigit())
        out.append(int(num) if num else 0)
    return tuple(out + [0] * (3 - len(out)))


def is_newer(remote: str, local: str = __version__) -> bool:
    return _parse(remote) > _parse(local)


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def check_latest(repo: str = GITHUB_REPO, timeout: float = 6.0):
    """Gibt (version, download_url, notizen) zurück oder None."""
    if not repo:
        return None
    url = f"https://api.github.com/repos/{repo}/releases/latest"
    req = urllib.request.Request(url, headers={"User-Agent": "Fliesenschablone-Updater",
                                               "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode("utf-8"))
    tag = data.get("tag_name", "")
    asset = next((a for a in data.get("assets", []) if a.get("name") == ASSET_NAME), None)
    if not tag or asset is None:
        return None
    return tag.lstrip("vV"), asset["browser_download_url"], data.get("body", "") or ""


def download(url: str, progress=None) -> str:
    """Lädt die neue .exe neben die laufende (gleiches Laufwerk -> Verschieben klappt sicher)."""
    target_dir = os.path.dirname(sys.executable) if is_frozen() else tempfile.gettempdir()
    dest = os.path.join(target_dir, ASSET_NAME + ".neu")
    req = urllib.request.Request(url, headers={"User-Agent": "Fliesenschablone-Updater"})
    with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        done = 0
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if progress:
                progress(done, total)
    return dest


def apply_and_restart(new_exe: str) -> bool:
    """Ersetzt die laufende .exe nach dem Beenden und startet neu. Nur unter Windows/als .exe."""
    if not (is_frozen() and os.name == "nt"):
        return False
    exe = sys.executable
    pid = os.getpid()
    bat = os.path.join(tempfile.gettempdir(), "fliesenschablone_update.bat")
    with open(bat, "w", encoding="mbcs" if os.name == "nt" else "utf-8") as f:
        f.write(f"""@echo off
:warten
tasklist /FI "PID eq {pid}" 2>nul | find "{pid}" >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto warten
)
set versuche=0
:ersetzen
move /Y "{new_exe}" "{exe}" >nul 2>&1
if errorlevel 1 (
  set /a versuche+=1
  if %versuche% lss 15 (
    timeout /t 1 /nobreak >nul
    goto ersetzen
  )
)
start "" "{exe}"
del "%~f0"
""")
    flags = 0x08000000 | 0x00000008  # CREATE_NO_WINDOW | DETACHED_PROCESS
    subprocess.Popen(["cmd", "/c", bat], creationflags=flags, close_fds=True)
    return True
