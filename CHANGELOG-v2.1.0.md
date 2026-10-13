# Обновление v2.1.0 — VS Code Tunnel и переподключение Claude

Дата: 2026-06-26

## Что нового

Две команды в боте.

**/connect** — VS Code через бота за минуту.
Пишешь команду в Telegram → бот даёт ссылку GitHub OAuth + код → авторизуешься → бот пишет ссылку `vscode.dev/tunnel/agent-XXXXXXXX`. Открываешь и работаешь в VS Code через браузер или Cmd+Shift+P в десктопном VS Code. Туннель живёт постоянно, нагрузка на сервер минимальная.

**/reauth** — переподключить Claude без обращения в поддержку.
Раньше: подписка Claude отвалилась → бот замолчал → ты не знаешь что делать. Теперь: пишешь /reauth (или жмёшь кнопку «Переподключить Claude» в /settings) → авторизуешься на claude.ai → копируешь URL из браузера → бот сам прописывает новый токен и перезапускается. Две минуты вместо «переустановить заново».

## Как обновиться (для тех у кого уже стоит агент)

Один шаг:

```
ssh root@<твой-сервер>
bash /home/agent/.agent/bot/update-bot.sh
```

Или из VS Code Tunnel — открой терминал на сервере и запусти ту же команду.

Что сделает скрипт:
- Скачает новые модули бота из GitHub
- Сбэкапит текущие файлы в `.backup-YYYYMMDD-HHMMSS/`
- Проверит синтаксис нового кода (если ошибка — откатит)
- Установит инфраструктуру VS Code Tunnel (если её ещё нет)
- Перезапустит бота

После апдейта в Telegram открой бота и напиши /connect — увидишь ссылку на VS Code.

## Как поставить с нуля

```
wget -O /root/setup-agent.sh https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/setup-server.sh
bash /root/setup-agent.sh
rm /root/setup-agent.sh
```

Дальше всё как раньше: /start в Telegram, бутстрап, через минуту работает.

## Если что-то пошло не так

**update-bot.sh не сработал?**
Запусти полную переустановку — она идемпотентная, ничего не сломает:
```
wget -O /root/setup-agent.sh https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/setup-server.sh
bash /root/setup-agent.sh
rm /root/setup-agent.sh
```

**/connect пишет «VS Code CLI не установлен»?**
Значит блок установки туннеля упал. Запусти переустановку (команда выше) — она дотянет.

**/reauth не появился в меню Telegram?**
Подожди минуту — Telegram обновляет команды не сразу. Или перезапусти бота: `systemctl restart agent-bot`.

**Хочешь откатиться на v2.0?**
В папке бота лежит бэкап:
```
ls /home/agent/.agent/bot/.backup-*
```
Скопируй файлы обратно и перезапусти `systemctl restart agent-bot`.

## Что технически изменилось

Для тех кому интересно — список файлов:

- `bot/lib/claude-oauth.js` — новый модуль PKCE OAuth для Claude
- `bot/lib/env-write.js` — новый модуль атомарной записи .env
- `bot/images/step5_*.png` — два скриншота онбординга /reauth
- `bot/index.js` — добавлены /connect, /reauth, кнопка в /settings
- `templates/vscode-tunnel/` — 6 файлов systemd path-юнитов
- `setup-server.sh` — шаг 5 переписан под новую архитектуру туннеля
- `bot/update-bot.sh` — расширен установкой tunnel-инфраструктуры

Имя туннеля: `agent-XXXXXXXX`, где XXXXXXXX — первые 8 hex от md5 имени сервера. Привязка к серверу, не к ученику. Если поменяешь hostname VPS — имя туннеля тоже поменяется (придётся /connect заново).
