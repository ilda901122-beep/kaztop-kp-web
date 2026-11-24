#!/usr/bin/env python3
"""Перенос общей истории КП из релея ntfy в ветку history (запускается GitHub Actions каждые 10 минут).

Записи и PDF зашифрованы на странице менеджера, здесь они не расшифровываются: только проверка формы,
копирование и учёт. Ветка history всегда из одного коммита (старые версии не копятся):
    log.jsonl    - строка на сообщение: {"id", "time", "m"} для записи или {"id", "time", "file", "size"} для PDF
    f/<id>.bin   - зашифрованные PDF (старше KEEP_FILES_DAYS удаляются, строка в log.jsonl остаётся)
    state.json   - время последнего обновления (раз в HEARTBEAT_DAYS ветка обновляется, чтобы расписание не отключилось)

Окружение: KP_HISTORY_TOPIC (секрет репозитория), GITHUB_TOKEN и REPO (из Actions) или ARCHIVE_REMOTE (тесты),
KP_HISTORY_RELAY (по умолчанию https://ntfy.sh).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RELAY = os.environ.get("KP_HISTORY_RELAY", "https://ntfy.sh").rstrip("/")
BRANCH = os.environ.get("ARCHIVE_BRANCH", "history")
ENVELOPE_RE = re.compile(r"^KP[01]\.[A-Za-z0-9_-]{8,40}\.[A-Za-z0-9_-]{16,5000}$")
ID_RE = re.compile(r"^[A-Za-z0-9]{6,32}$")
TOPIC_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
MAX_FILE = 2 * 1024 * 1024 + 64
KEEP_FILES_DAYS = 400
HEARTBEAT_DAYS = 20


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=check)


def fetch(url: str, limit: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "kaztop-kp-history-archive"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("слишком большой ответ")
    return data


def poll(topic: str) -> list[dict]:
    raw = fetch(f"{RELAY}/{topic}/json?poll=1&since=12h", 8 * 1024 * 1024).decode("utf-8")
    out = []
    for line in raw.splitlines():
        try:
            m = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(m, dict) and m.get("event") == "message" and ID_RE.match(str(m.get("id", ""))):
            out.append(m)
    return out


def checkout(remote: str, work: Path) -> bool:
    """Клон ветки history; если её нет - пустой репозиторий. Возвращает True, если ветка была."""
    res = subprocess.run(["git", "clone", "--depth", "1", "--branch", BRANCH, remote, str(work)], capture_output=True, text=True)
    if res.returncode == 0:
        return True
    work.mkdir(parents=True, exist_ok=True)
    git(work, "init", "-q")
    git(work, "checkout", "-q", "--orphan", BRANCH)
    git(work, "remote", "add", "origin", remote)
    return False


def load_log(work: Path) -> list[dict]:
    path = work / "log.jsonl"
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(e, dict) and ID_RE.match(str(e.get("id", ""))):
            out.append(e)
    return out


def archive(topic: str, remote: str, now: float | None = None) -> dict:
    now = time.time() if now is None else now
    if not TOPIC_RE.match(topic):
        raise SystemExit("KP_HISTORY_TOPIC не задан или не похож на тему релея")
    with tempfile.TemporaryDirectory(prefix="kp-history-") as tmp:
        work = Path(tmp) / "history"
        existed = checkout(remote, work)
        log = load_log(work)
        known = {e["id"] for e in log}
        added = files = skipped = 0
        for m in poll(topic):
            mid = m["id"]
            if mid in known:
                continue
            att = m.get("attachment")
            if att:
                url = str(att.get("url", ""))
                size = int(att.get("size") or 0)
                if not url.startswith(f"{RELAY}/file/") or not 0 < size <= MAX_FILE:
                    skipped += 1
                    continue
                try:
                    data = fetch(url, MAX_FILE)
                except Exception as e:  # noqa: BLE001 - файл мог истечь или релей ограничил: попробуем в следующий запуск
                    print(f"файл {mid} не скачан: {e}", file=sys.stderr)
                    continue
                (work / "f").mkdir(exist_ok=True)
                (work / "f" / f"{mid}.bin").write_bytes(data)
                log.append({"id": mid, "time": int(m.get("time") or now), "file": f"f/{mid}.bin", "size": len(data)})
                files += 1
            else:
                text = str(m.get("message", ""))
                if not ENVELOPE_RE.match(text):
                    skipped += 1
                    continue
                log.append({"id": mid, "time": int(m.get("time") or now), "m": text})
            known.add(mid)
            added += 1
        expired = 0
        for e in log:
            if e.get("file") and not e.get("expired") and e.get("time", now) < now - KEEP_FILES_DAYS * 86400:
                (work / e["file"]).unlink(missing_ok=True)
                e["expired"] = True
                expired += 1
        state_path = work / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
        last = state.get("updated_ts", 0)
        heartbeat = now - last > HEARTBEAT_DAYS * 86400
        changed = bool(added or expired or not existed or heartbeat)
        if changed:
            log.sort(key=lambda e: e.get("time", 0))  # устойчивая сортировка: в одной секунде порядок релея
            (work / "log.jsonl").write_text("".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e in log), encoding="utf-8")
            stamp = datetime.fromtimestamp(now, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            state_path.write_text(json.dumps({"updated": stamp, "updated_ts": int(now), "entries": len(log)}, ensure_ascii=False) + "\n", encoding="utf-8")
            git(work, "config", "user.name", "kp-history")
            git(work, "config", "user.email", "kp-history@users.noreply.github.com")
            git(work, "add", "-A")
            msg = f"history {stamp}: +{added}, files +{files}, expired {expired}"
            if existed:
                git(work, "commit", "-q", "--amend", "-m", msg)
            else:
                git(work, "commit", "-q", "-m", msg)
            git(work, "push", "-q", "--force", "origin", f"HEAD:{BRANCH}")
        return {"added": added, "files": files, "skipped": skipped, "expired": expired, "pushed": changed, "entries": len(log)}


def main() -> int:
    topic = os.environ.get("KP_HISTORY_TOPIC", "")
    if not topic:
        print("секрет KP_HISTORY_TOPIC не задан: архив истории не включён, запуск пропущен")
        return 0
    remote = os.environ.get("ARCHIVE_REMOTE") or f"https://x-access-token:{os.environ['GITHUB_TOKEN']}@github.com/{os.environ['REPO']}.git"
    report = archive(topic, remote)
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
