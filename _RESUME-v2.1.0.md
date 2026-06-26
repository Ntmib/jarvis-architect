# Возобновление работы — v2.1.0 (ждём апрува волонтёра)

Дата фиксации: 2026-06-26
Ответственный: Дмитрий + Джарвис
Статус: **ВСЁ ГОТОВО, ЖДЁМ ОТВЕТ ВОЛОНТЁРА**

## Что сделано

Портирование двух фич из agent-factory (v4.6 + v4.7) в jarvis-architect:

- `/connect` — VS Code Tunnel через бота (GitHub OAuth → ссылка vscode.dev)
- `/reauth` — переподключение Claude через PKCE OAuth когда подписка отвалилась
- Кнопка «🔑 Переподключить Claude» в /settings
- Уведомление «Готов к работе» после reauth-рестарта

**26 коммитов в ветке `feature/connect-and-reauth`. 24 «feature» + 2 merge.**

### Файлы которые изменились

| Файл | Что |
|------|-----|
| `bot/index.js` | +528 строк: /connect handler, reauth flow, кнопка settings, перехват URL |
| `bot/lib/claude-oauth.js` | НОВЫЙ — PKCE OAuth модуль (101 строка) |
| `bot/lib/env-write.js` | НОВЫЙ — атомарная запись .env (98 строк) |
| `bot/images/step5_claude_authorize.png` | НОВЫЙ — скриншот для /reauth (312 КБ) |
| `bot/images/step5_browser_error.png` | НОВЫЙ — скриншот для /reauth (356 КБ) |
| `bot/VERSION` | 2.0.0 → 2.1.0 |
| `bot/package.json` | 2.0.0 → 2.1.0 |
| `bot/update-bot.sh` | +56 строк: новые файлы в загрузке, автоустановка tunnel-инфры, BRANCH override |
| `setup-server.sh` | Шаг 5 переписан под новую архитектуру с systemd path-юнитами |
| `templates/vscode-tunnel/` | НОВАЯ ПАПКА — 6 файлов (install + 5 systemd units) |
| `CHANGELOG-v2.1.0.md` | НОВЫЙ — инструкция для ученика как обновиться |
| `TEST-INSTALL-v2.1.0.md` | НОВЫЙ — инструкция для тестового волонтёра |

### Решения которые приняты по ходу

1. **secrets-menu.js НЕ трогали** — кнопка «🔑 Переподключить Claude» добавлена в settingsKeyboard в bot/index.js, потому что /settings command сидит там, а не в secrets-menu
2. **Имя туннеля от hostname**, не от OWNER_ID — потому что на этапе setup-server.sh OWNER_ID ещё неизвестен (его определяет первый /start). Бот и установщик считают одинаково через `printf '%s' "$(hostname)" | md5sum | cut -c1-8`
3. **BRANCH параметризован** в update-bot.sh через `${BRANCH:-main}` — для тестирования на одном волонтёре без push в main
4. **Auto-recovery НЕ портировали** — это отдельная фича из agent-factory которая требует много кода (auth-check блок). Без неё /reauth работает, просто нет автоматического обнаружения «Claude отвалился»

## Состояние git на момент паузы

```
Локально:
  main:                          63c4376 Merge v2.1.0 testing
  feature/connect-and-reauth:    d20a8be feat(update): параметризация BRANCH

На GitHub:
  origin/main:                   66254fd (БЕЗ v2.1.0 — НЕ запушен)
  origin/feature/connect-and-reauth: d20a8be ЗАПУШЕН (для волонтёра)
```

main НЕ запушен сознательно — ждём подтверждение волонтёра.

## Что осталось сделать

**После апрува волонтёра:**

1. `git checkout main`
2. `git push origin main` (RED — публикация)
3. `git tag -a v2.1.0 -m "v2.1.0: /connect + /reauth"`
4. `git push origin v2.1.0`
5. Опционально удалить feature ветку: `git branch -d feature/connect-and-reauth && git push origin --delete feature/connect-and-reauth`
6. Обновить документацию КУРСА (не agent-factory) — поправить упоминания @AgiFactory_bot / @jarchitect_bot которые неверно описывают обновление в jarvis-architect

**Если волонтёр найдёт баг:**

1. Получить от него логи / описание
2. Фикс в `feature/connect-and-reauth`
3. `git push origin feature/connect-and-reauth`
4. Волонтёр повторно запускает команду
5. После апрува — flow выше

## Команда для волонтёра

Ссылка на полную инструкцию:
https://github.com/Ntmib/jarvis-architect/blob/feature/connect-and-reauth/TEST-INSTALL-v2.1.0.md

Одна команда (если ему проще):
```
curl -fsSL https://raw.githubusercontent.com/Ntmib/jarvis-architect/feature/connect-and-reauth/bot/update-bot.sh -o /tmp/update-bot.sh && BRANCH=feature/connect-and-reauth bash /tmp/update-bot.sh
```

## Что НЕ забыть после возобновления

- Дмитрий передаёт «волонтёр одобрил» или «вот что не так»
- Если одобрил — делаем push main + тег v2.1.0
- Если не одобрил — фикс на feature → новый тест
- Отдельной задачей: обновить документацию курса про обновление (там есть неверная цитата про @jarchitect_bot/AgiFactory_bot — это про другой проект)

## Точки входа для контекста

- `_RESUME-v2.1.0.md` (этот файл) — главная точка входа
- `CHANGELOG-v2.1.0.md` — что нового для ученика
- `TEST-INSTALL-v2.1.0.md` — инструкция волонтёру
- `git log feature/connect-and-reauth --oneline` — 25 коммитов с пометкой подшагов (5.1, 6.1, 7.1 и т.д.)
