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
import time
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


def _exe_dir() -> str:
    return os.path.dirname(sys.executable) if is_frozen() else tempfile.gettempdir()


def download(url: str, progress=None) -> str:
    """Lädt die neue .exe neben die laufende (gleiches Laufwerk -> Umbenennen klappt sicher).
    Erst nach vollständigem Download wird die Datei in "….exe.neu" umbenannt."""
    dest = os.path.join(_exe_dir(), ASSET_NAME + ".neu")
    part = dest + ".teil"
    req = urllib.request.Request(url, headers={"User-Agent": "Fliesenschablone-Updater"})
    with urllib.request.urlopen(req, timeout=30) as r, open(part, "wb") as f:
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
    if total and os.path.getsize(part) != total:
        os.remove(part)
        raise IOError("Download unvollständig")
    _retry(lambda: os.replace(part, dest))
    return dest


def _retry(fn, tries=20, wait=0.25):
    """Virenscanner halten frisch geladene Dateien oft kurz fest – dann kurz warten."""
    for i in range(tries):
        try:
            return fn()
        except OSError:
            if i == tries - 1:
                raise
            time.sleep(wait)


def _clean_env():
    """Umgebung ohne PyInstaller-Variablen, damit die neue .exe wirklich frisch startet."""
    env = {k: v for k, v in os.environ.items() if not (k.startswith("_PYI") or k.startswith("_MEI"))}
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    return env


def apply_and_restart(new_exe: str) -> bool:
    """Tauscht die .exe aus und startet die neue Version.

    Windows erlaubt, eine laufende .exe umzubenennen (nur nicht zu löschen). Daher:
    laufende .exe -> "….exe.alt", neue Datei -> ursprünglicher Name, neue Version starten.
    Die alte Datei wird beim nächsten Start aufgeräumt.
    """
    if not (is_frozen() and os.name == "nt"):
        return False
    exe = sys.executable
    old = exe + ".alt"
    if os.path.exists(old):
        try:
            os.remove(old)
        except OSError:
            old = f"{exe}.alt{int(time.time())}"
    _retry(lambda: os.replace(exe, old))
    try:
        _retry(lambda: os.replace(new_exe, exe))
    except OSError:
        os.replace(old, exe)  # zurück zum alten Stand
        raise
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([exe], cwd=os.path.dirname(exe), env=_clean_env(), close_fds=True, creationflags=flags)
    return True


def startup_maintenance() -> bool:
    """Beim Programmstart: Reste alter Versionen löschen und ein schon geladenes Update einspielen.
    Gibt True zurück, wenn die neue Version gestartet wurde und dieses Programm enden soll."""
    if not (is_frozen() and os.name == "nt"):
        return False
    folder = _exe_dir()
    base = os.path.basename(sys.executable)
    for name in os.listdir(folder):
        if name.startswith(base + ".alt") or name.endswith(".neu.teil"):
            try:
                os.remove(os.path.join(folder, name))
            except OSError:
                pass
    pending = os.path.join(folder, ASSET_NAME + ".neu")
    if os.path.exists(pending) and os.path.getsize(pending) > 1_000_000:
        try:
            return apply_and_restart(pending)
        except OSError:
            return False
    return False
