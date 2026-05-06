# Инструкция для Claude Code: установка Агента на VPS

> Этот файл читает Claude Code. Если ты Claude — выполняй всё по шагам, не задавай уточняющих вопросов. Все данные (IP, пароль, токены) пользователь уже указал в своём сообщении.

## Как общаться с пользователем

**КРИТИЧНО:** пользователь — новичок, который впервые работает с сервером. Он не знает что такое SSH, systemd, npm. Общайся с ним так:

1. **Перед каждым шагом** — объясни ОДНИМ предложением что сейчас будешь делать. Пример: «Сейчас подключаюсь к вашему серверу и проверяю связь...»
2. **После каждого шага** — коротко скажи что получилось. Пример: «Связь с сервером есть, всё ок. Перехожу к установке программ.»
3. **Если ошибка** — объясни простым языком что пошло не так и что делать. Не кидай сырой лог без объяснения.
4. **Не пугай техническими деталями.** Пользователю не нужно знать что такое sysctl или chmod. Просто делай и говори результат.
5. **Показывай прогресс.** После каждого крупного шага пиши что-то вроде: «Шаг 3 из 9 готов. Устанавливаю программы на сервер...»
6. **В конце** — дай чёткую пошаговую инструкцию что делать дальше (VS Code Tunnel). Каждый пункт = одно конкретное действие. «Нажмите сюда → введите это → нажмите то.»
7. **Если нужно действие от пользователя** (например, открыть консоль Beget) — объясни ГДЕ это, КАК найти, ЧТО нажать. Не пиши «зайдите в VNC-консоль» — пиши «откройте сайт beget.com → войдите в личный кабинет → найдите раздел VPS → нажмите на свой сервер → нажмите кнопку Консоль».

Стиль: дружелюбный, спокойный, как будто помогаешь другу настроить компьютер. Без воды, но с заботой.

## Контекст

Пользователь — ученик курса «Архитектор нейросотрудников». У него:
- Локально на компьютере: папка с файлами Агента (CLAUDE.md, SOUL.md, MEMORY.md, GOALS.md, memory/, knowledge/)
- Новый VPS (обычно Beget, Ubuntu 22 или 24), на который нужно всё перенести
- Опционально: токен Telegram-бота для установки Telegram-бота (работает через подписку Claude, API-ключ не нужен)

Твоя задача — подключиться к серверу, установить окружение, скопировать файлы и (если даны токены) запустить Telegram-бота.

## Шаг 1. Найди локальные файлы

Проверь текущую папку — есть ли там DNA-файлы Агента:

```bash
ls CLAUDE.md SOUL.md MEMORY.md GOALS.md 2>/dev/null
```

Если файлы есть — запомни путь, ты скопируешь их на сервер в шаге 5.
Если файлов нет — проверь домашнюю папку и ~/jarvis/:
```bash
ls ~/jarvis/CLAUDE.md ~/jarvis/SOUL.md 2>/dev/null
ls ~/workspace/CLAUDE.md ~/workspace/SOUL.md 2>/dev/null
```
Если нигде нет — скажи пользователю: «Не нашёл файлы Агента. Откройте Claude Code в папке где лежат SOUL.md, MEMORY.md и другие файлы, и повторите команду.»

## Шаг 2. Подключись к серверу

IP и пароль пользователь указал в сообщении. Используй `expect` для автоматического ввода пароля.

Сначала проверь соединение:
```bash
expect -c '
  set timeout 15
  spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@IP_СЕРВЕРА "echo CONNECTION_OK"
  expect {
    "password:" { send "ПАРОЛЬ\r"; exp_continue }
    "CONNECTION_OK" { exit 0 }
    timeout { exit 1 }
    eof { exit 1 }
  }
'
```

Замени `IP_СЕРВЕРА` и `ПАРОЛЬ` на данные из сообщения пользователя.

**Если не подключается** (таймаут, ошибка) — скажи пользователю:

> Прямое подключение не прошло. Скорее всего VPN блокирует соединение. Есть простой запасной путь:
>
> 1. Зайдите в панель управления Beget → ваш VPS → кнопка «Консоль»
> 2. Войдите как root с вашим паролем
> 3. Введите: `wget ntmib.github.io/jarvis-architect/s`
> 4. Введите: `bash s`
> 5. Скрипт всё установит. После этого напишите мне «готово» — я скопирую ваши файлы.

И жди ответа. Когда пользователь скажет «готово» — перейди к шагу 5 (копирование файлов).

## Шаг 3. Установи систему

Выполняй каждую команду через SSH. Вспомогательная функция:

```bash
# Для каждой команды используй этот шаблон:
expect -c '
  set timeout 120
  spawn ssh -o StrictHostKeyChecking=no root@IP_СЕРВЕРА "КОМАНДА"
  expect "password:" { send "ПАРОЛЬ\r" }
  expect eof
'
```

Последовательность:

**3.1. Базовые пакеты:**
```
apt-get update -qq 2>&1 | tail -3 && apt-get install -y -qq curl git jq unzip 2>&1 | tail -3
```

**3.2. Node.js 20:**
```
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>&1 | tail -5 && apt-get install -y -qq nodejs 2>&1 | tail -3 && node -v
```

**3.3. Claude Code CLI:**
```
npm install -g @anthropic-ai/claude-code 2>&1 | tail -5 && which claude
```

**3.4. Пользователь agent и папки:**
```
id agent 2>/dev/null || useradd -m -s /bin/bash agent && mkdir -p /home/agent/workspace/memory /home/agent/workspace/knowledge /home/agent/projects /home/agent/.agent/bot /home/agent/.claude/skills && chown -R agent:agent /home/agent && echo OK
```

**3.5. Права на Claude Code для пользователя agent:**
```
CLAUDE_REAL=$(readlink -f $(which claude 2>/dev/null) 2>/dev/null) && if [ -n "$CLAUDE_REAL" ]; then chmod -R a+rX $(dirname "$CLAUDE_REAL") 2>/dev/null; chmod -R a+rX $(dirname $(dirname "$CLAUDE_REAL")) 2>/dev/null; chmod -R a+rX $(dirname $(dirname $(dirname "$CLAUDE_REAL"))) 2>/dev/null; fi && echo OK
```

**3.6. Отключение IPv6 (фикс зависаний Node.js):**
```
sysctl -w net.ipv6.conf.all.disable_ipv6=1 2>/dev/null; sysctl -w net.ipv6.conf.default.disable_ipv6=1 2>/dev/null; echo OK
```

После каждого шага проверяй вывод. Если ошибка — покажи пользователю и предложи решение. Не останавливайся без причины.

## Шаг 4. Установи VS Code CLI

```
if ! command -v code >/dev/null 2>&1; then curl -fL 'https://github.com/Ntmib/jarvis-architect/releases/download/v1.0.0/vscode-cli.tar.gz' -o /tmp/vscode.tar.gz 2>&1 || curl -fL 'https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64' -o /tmp/vscode.tar.gz 2>&1; tar -xzf /tmp/vscode.tar.gz -C /usr/local/bin/ 2>&1; rm -f /tmp/vscode.tar.gz; fi && code --version 2>/dev/null || echo 'VS Code CLI not found'
```

## Шаг 5. Скопируй файлы Агента на сервер

Скопируй все DNA-файлы из локальной папки на сервер. Используй scp с expect:

```bash
# Шаблон для копирования одного файла:
expect -c '
  set timeout 30
  spawn scp -o StrictHostKeyChecking=no ./ФАЙЛ root@IP_СЕРВЕРА:/home/agent/workspace/
  expect "password:" { send "ПАРОЛЬ\r" }
  expect eof
'
```

Скопируй по очереди все DNA-файлы (каждый — если существует локально):
1. `CLAUDE.md`
2. `SOUL.md`
3. `MEMORY.md`
4. `GOALS.md`
5. `USER.md`
6. `MISSION.md`
7. `PROJECTS.md`
8. `PREFERENCES.md`
9. `LEARNED.md`

Потом скопируй папки (рекурсивно, флаг -r):
10. `memory/` → `/home/agent/workspace/memory/`
11. `knowledge/` → `/home/agent/workspace/knowledge/`

**Настройки Claude Code (.claude/):**
7. Если у пользователя есть локальная папка `.claude/` — скопируй её в `/home/agent/.claude/` (НЕ в workspace!). Это настройки Claude Code: settings.json (правила светофора) и skills/ (навыки).

Если `.claude/` нет локально — скачай дефолтные настройки и скиллы из репозитория:
```
curl -fsSL https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/.claude/settings.json -o /home/agent/.claude/settings.json
```

**Установи скиллы (навыки агента):**
Скиллы — это готовые инструкции, которые усиливают агента. Скачай 4 базовых скилла:
```
for SKILL in discovery-interview content-creator fullstack-developer frontend-design; do mkdir -p /home/agent/.claude/skills/$SKILL && curl -fsSL https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/.claude/skills/$SKILL/SKILL.md -o /home/agent/.claude/skills/$SKILL/SKILL.md; done && echo OK
```

После копирования — поправь владельца:
```
chown -R agent:agent /home/agent/workspace /home/agent/.claude
```

## Шаг 6. Проверь результат

Выполни на сервере:
```
echo '=== Node.js ===' && node -v && echo '=== Claude Code ===' && which claude && echo '=== VS Code CLI ===' && which code 2>/dev/null || echo 'нет' && echo '=== Файлы Агента ===' && ls -la /home/agent/workspace/ && echo '=== Папки ===' && ls -d /home/agent/workspace/memory /home/agent/workspace/knowledge 2>/dev/null
```

Покажи пользователю результат. Скажи:

> Сервер готов. Установлено:
> - Node.js (версия)
> - Claude Code CLI
> - Ваши файлы Агента скопированы в /home/agent/workspace/
> - Рабочая папка для проектов: /home/agent/projects/

## Шаг 7. Установи Telegram-бота (если указан токен бота)

**Если пользователь указал Telegram-бот токен** — установи бота. Если токен не указан — пропусти этот шаг и перейди к шагу 8.

**7.1. Скачай файлы бота из репозитория:**
```
curl -fsSL https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/bot/index.js -o /home/agent/.agent/bot/index.js && curl -fsSL https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/bot/package.json -o /home/agent/.agent/bot/package.json && curl -fsSL https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/bot/CLAUDE-SYSTEM.md -o /home/agent/.agent/bot/CLAUDE-SYSTEM.md && echo OK
```

**7.2. Установи зависимости:**
```
cd /home/agent/.agent/bot && npm install --production 2>&1 | tail -5 && echo OK
```

**7.3. Создай файл окружения:**
```
cat > /home/agent/.agent/.env << 'ENVEOF'
BOT_TOKEN=ТОКЕН_БОТА
AGENT_HOME=/home/agent
ENVEOF
```
Замени `ТОКЕН_БОТА` на значение из сообщения пользователя.

**Безопасность (auto-lock):** Бот автоматически привязывается к первому пользователю, который напишет ему `/start`. После этого бот отвечает ТОЛЬКО ему — все остальные игнорируются. Данные владельца сохраняются в `/home/agent/.agent/owner.json`. Ничего дополнительно настраивать не нужно.

**7.4. Авторизуй Claude Code через подписку.**

Бот использует Claude Code CLI, который работает через вашу подписку Claude. Авторизация — интерактивная, требует действий от пользователя. Скажи ему:

> Сейчас нужно авторизовать Claude на сервере. Это как войти в аккаунт — делается один раз.
>
> **Шаг 1.** Откройте консоль сервера (beget.com → VPS → ваш сервер → Консоль)
> **Шаг 2.** Войдите как root
> **Шаг 3.** Введите команду:
> ```
> sudo -u agent claude auth login
> ```
> **Шаг 4.** На экране появится ссылка и код. Откройте ссылку в браузере, введите код и нажмите «Authorize»
> **Шаг 5.** Вернитесь в консоль — должно появиться сообщение об успешной авторизации
>
> Когда закончите, напишите мне «готово».

Жди ответа пользователя. Когда скажет «готово» — продолжай.

**7.5. Поправь владельца файлов (ВАЖНО — до запуска бота!):**
```
chown -R agent:agent /home/agent/.agent
```

**7.6. Установи systemd-сервис и запусти:**
```
curl -fsSL https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/bot/agent-bot.service -o /etc/systemd/system/agent-bot.service && systemctl daemon-reload && systemctl enable agent-bot && systemctl start agent-bot && sleep 3 && systemctl status agent-bot --no-pager -l 2>&1 | head -15
```

Если бот запустился — скажи пользователю:

> Telegram-бот запущен! Напишите своему боту в Telegram — он должен ответить.
> Бот работает 24/7 на сервере. Он использует вашу подписку Claude — никаких API-ключей не нужно.

Если ошибка — покажи лог (`journalctl -u agent-bot -n 20 --no-pager`) и предложи решение.

## Шаг 8. Настрой VS Code Tunnel

VS Code Tunnel требует авторизации через GitHub — это нужно сделать вручную в консоли сервера. Скажи пользователю:

> Почти готово! Остался один шаг — нужно привязать сервер к вашему VS Code. Это делается один раз, занимает 2 минуты.
>
> Вам нужно зайти в консоль сервера через браузер. Вот как:
>
> **Шаг 1.** Откройте сайт beget.com и войдите в личный кабинет
> **Шаг 2.** Слева в меню найдите раздел **VPS** и нажмите на него
> **Шаг 3.** Нажмите на название вашего сервера
> **Шаг 4.** Найдите кнопку **«Консоль»** (обычно вверху или справа) — нажмите на неё
> **Шаг 5.** Откроется чёрное окно терминала. Введите логин: `root` и нажмите Enter
> **Шаг 6.** Введите ваш пароль от сервера и нажмите Enter (пароль не будет видно — это нормально)
> **Шаг 7.** Скопируйте и вставьте эту команду, потом нажмите Enter:
> ```
> code tunnel --accept-server-license-terms
> ```
> **Шаг 8.** На экране появится ссылка вида `https://github.com/login/device` и 8-значный код (например: `ABCD-1234`)
> **Шаг 9.** Откройте эту ссылку в браузере на вашем компьютере
> **Шаг 10.** Введите код с экрана консоли и нажмите **«Authorize»**
> **Шаг 11.** Вернитесь в консоль Beget и нажмите **Ctrl+C** (зажмите Ctrl и нажмите букву C)
> **Шаг 12.** Введите последнюю команду и нажмите Enter:
> ```
> code tunnel service install --accept-server-license-terms
> ```
>
> Готово! Теперь сервер навсегда привязан к вашему VS Code. Напишите мне «готово» когда закончите.

## Шаг 9. Как подключиться из VS Code

Когда пользователь скажет что закончил настройку туннеля, скажи:

> Отлично! Теперь подключаемся к серверу из VS Code на вашем компьютере:
>
> **Шаг 1.** Откройте VS Code на вашем компьютере (обычная программа, не в браузере)
> **Шаг 2.** Посмотрите на левую панель — там ряд иконок. Найдите иконку в виде **монитора с маленьким значком** (называется Remote Explorer). Если не видите — нажмите Ctrl+Shift+P, напишите "Remote Explorer" и выберите его
> **Шаг 3.** В открывшейся панели найдите раздел **Tunnels** — там будет название вашего сервера
> **Шаг 4.** Нажмите на него — VS Code откроет папки вашего сервера
> **Шаг 5.** Перейдите в папку `/home/agent/workspace/` — это дом вашего Агента
>
> Всё! Теперь вы работаете на сервере прямо из VS Code, как в обычной папке на своём компьютере. Ваш Агент живёт здесь и работает 24/7.

## Важно

- НЕ показывай пароль пользователя в выводе после его ввода
- НЕ показывай токены и API-ключи в выводе
- НЕ сохраняй пароль в файлы (кроме .env для бота)
- НЕ задавай уточняющих вопросов — действуй по шагам
- Если что-то падает — покажи ошибку и предложи решение, не останавливайся молча
- Если expect не найден (Linux без expect) — предложи установить: `apt-get install -y expect` или предложи VNC-путь
