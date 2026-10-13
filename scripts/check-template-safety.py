#!/usr/bin/env python3
"""Fail when the public template contains private memory or unsafe defaults."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
errors: list[str] = []

memory_dir = ROOT / "memory"
if memory_dir.exists():
    unexpected_memory = sorted(
        path.relative_to(ROOT).as_posix()
        for path in memory_dir.rglob("*")
        if path.is_file() and path != memory_dir / "README.md"
    )
    if unexpected_memory:
        errors.append(
            "В публичном шаблоне memory/ содержит данные кроме README.md: "
            + ", ".join(unexpected_memory)
        )

settings_path = ROOT / ".claude" / "settings.json"
try:
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
except Exception as exc:
    errors.append(f"Не удалось прочитать {settings_path.relative_to(ROOT)}: {exc}")
else:
    permissions = settings.get("permissions", {})
    allow = permissions.get("allow", [])
    if allow:
        errors.append(
            "Публичный шаблон не должен заранее разрешать инструменты Claude Code: "
            + ", ".join(map(str, allow))
        )
    if permissions.get("defaultMode") == "bypassPermissions":
        errors.append("Нельзя включать permissions.defaultMode=bypassPermissions")
    if settings.get("skipDangerousModePermissionPrompt") is True:
        errors.append("Нельзя отключать предупреждение опасного режима")

required_ignores = {
    "SOUL.md",
    "MEMORY.md",
    "GOALS.md",
    "USER.md",
    "MISSION.md",
    "PROJECTS.md",
    "PREFERENCES.md",
    "LEARNED.md",
    "SERVICES.md",
    "memory/**",
    "!memory/README.md",
    "knowledge/**",
    "!knowledge/README.md",
}
try:
    ignore_lines = {
        line.strip()
        for line in (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
except Exception as exc:
    errors.append(f"Не удалось прочитать .gitignore: {exc}")
else:
    missing = sorted(required_ignores - ignore_lines)
    if missing:
        errors.append("В .gitignore нет защиты личных данных: " + ", ".join(missing))

template_dna = [
    "SOUL.md",
    "MEMORY.md",
    "GOALS.md",
    "USER.md",
    "MISSION.md",
    "PROJECTS.md",
    "PREFERENCES.md",
]
for name in template_dna:
    path = ROOT / name
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as exc:
        errors.append(f"Не удалось прочитать {name}: {exc}")
        continue
    if "WIZARD" not in text or "{{" not in text:
        errors.append(
            f"{name} не похож на чистый шаблон: нет WIZARD или плейсхолдеров"
        )

secret_patterns = {
    "GitHub token": re.compile(r"\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "Bearer token": re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{20,}"),
    "Telegram bot token": re.compile(r"\b\d{8,10}:[A-Za-z0-9_-]{30,}\b"),
}
unsafe_instruction_patterns = {
    "отключение проверки SSH-хоста": re.compile("StrictHostKeyChecking" + "=no"),
    "автоввод пароля через expect": re.compile(r"\bexpect\s+" + r"-c\b"),
    "плейсхолдер токена в команде": re.compile(r"\bТОКЕН_" + r"БОТА\b"),
    "просьба прислать пароль": re.compile(
        r"(?i)приш" + r"лите[^\n]{0,80}парол"
    ),
    "запуск скачанного скрипта через pipe": re.compile(
        r"cu" + r"rl[^\n|]*\|\s*" + r"(?:bash|sh)\b"
    ),
}
skip_dirs = {".git", "node_modules", ".media"}
for path in ROOT.rglob("*"):
    if not path.is_file():
        continue
    if any(part in skip_dirs for part in path.relative_to(ROOT).parts):
        continue
    if path.stat().st_size > 2_000_000:
        continue
    try:
        raw = path.read_bytes()
        if b"\x00" in raw:
            continue
        text = raw.decode("utf-8")
    except (UnicodeDecodeError, OSError):
        continue
    for label, pattern in secret_patterns.items():
        if pattern.search(text):
            errors.append(f"Возможный секрет ({label}) в {path.relative_to(ROOT)}")
    for label, pattern in unsafe_instruction_patterns.items():
        if pattern.search(text):
            errors.append(
                f"Небезопасная инструкция ({label}) в {path.relative_to(ROOT)}"
            )

if errors:
    print("Проверка безопасности шаблона не пройдена:")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)

print("Проверка безопасности шаблона пройдена.")
