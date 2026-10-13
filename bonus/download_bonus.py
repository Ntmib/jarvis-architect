#!/usr/bin/env python3
"""Safely download the licensed bonus package without exposing the token."""

from __future__ import annotations

import getpass
import io
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import date
from pathlib import Path
from typing import NoReturn

DEST = Path.home() / "jarvis-bonus"
BASE_URL = "https://jarvis-architect-bonus.vercel.app/zip/"
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
MAX_UNPACKED_BYTES = 500 * 1024 * 1024
MAX_FILES = 5000


def stop(message: str) -> NoReturn:
    print(message)
    raise SystemExit(1)


def main() -> None:
    if DEST.exists() and any(DEST.iterdir()):
        stop(f"Папка {DEST} уже не пустая. Ничего не перезаписано.")

    token = getpass.getpass("Вставьте одноразовый токен (ввод скрыт): ").strip()
    if len(token) < 12 or any(ch.isspace() for ch in token):
        stop("Формат токена неверный. Ничего не скачано.")

    username = input("Telegram username без @ (можно оставить пустым): ").strip().lstrip("@")
    issued = input(f"Дата выдачи [по умолчанию {date.today().isoformat()}]: ").strip()
    issued = issued or date.today().isoformat()

    request = urllib.request.Request(
        BASE_URL + urllib.parse.quote(token, safe=""),
        headers={"User-Agent": "jarvis-bonus-installer/1"},
    )
    archive = b""
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > MAX_DOWNLOAD_BYTES:
                stop("Архив слишком большой. Скачивание остановлено.")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    stop("Архив превысил допустимый размер. Скачивание остановлено.")
                chunks.append(chunk)
            archive = b"".join(chunks)
    except urllib.error.HTTPError as exc:
        if exc.code in {403, 429}:
            stop("Токен недействителен или исчерпал лимит. Получите новый через /new.")
        stop(f"Сервер вернул ошибку HTTP {exc.code}.")
    except Exception as exc:
        stop(f"Не удалось скачать пакет: {type(exc).__name__}")

    temp = DEST.with_name(DEST.name + ".download")
    try:
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
            members = bundle.infolist()
            if len(members) > MAX_FILES:
                stop("В архиве слишком много файлов. Распаковка остановлена.")
            if sum(item.file_size for item in members) > MAX_UNPACKED_BYTES:
                stop("Распакованный архив слишком большой. Распаковка остановлена.")
            if any(Path(item.filename).is_absolute() or ".." in Path(item.filename).parts for item in members):
                stop("Архив содержит небезопасные пути. Распаковка остановлена.")
            if any(((item.external_attr >> 16) & 0o170000) == 0o120000 for item in members):
                stop("Архив содержит символические ссылки. Распаковка остановлена.")
            if temp.exists():
                shutil.rmtree(temp)
            temp.mkdir(parents=True)
            bundle.extractall(temp)
    except zipfile.BadZipFile:
        stop("Скачанный файл не является корректным ZIP-архивом.")

    children = list(temp.iterdir())
    source = children[0] if len(children) == 1 and children[0].is_dir() else temp
    DEST.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        shutil.move(str(item), DEST / item.name)
    shutil.rmtree(temp, ignore_errors=True)

    license_path = DEST / "LICENSE.md"
    if license_path.exists() and username:
        text = license_path.read_text(encoding="utf-8")
        mark = f"@{username} (выдано {issued}, токен ...{token[-4:]})"
        license_path.write_text(text.replace("{{LICENSED_TO}}", mark), encoding="utf-8")

    token = ""
    print(f"Пакет установлен в {DEST}")
    print("Откройте эту папку в Claude Code и следуйте INSTALL.md.")


if __name__ == "__main__":
    main()
