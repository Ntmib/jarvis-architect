#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Запустите скрипт от root в консоли VPS."
  exit 1
fi

if ! id agent >/dev/null 2>&1; then
  echo "Сначала запустите setup-server.sh: пользователь agent не найден."
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js не установлен. Сначала запустите setup-server.sh."
  exit 1
fi

read -r -s -p "Вставьте токен Telegram-бота (ввод скрыт): " BOT_TOKEN
echo

if [[ ! $BOT_TOKEN =~ ^[0-9]{8,10}:[A-Za-z0-9_-]{30,}$ ]]; then
  unset BOT_TOKEN
  echo "Формат токена не похож на токен BotFather. Ничего не установлено."
  exit 1
fi

TMP_DIR=$(mktemp -d)
NEW_BOT_DIR=""
OLD_BOT_DIR=""
trap 'unset BOT_TOKEN; rm -rf "$TMP_DIR"; [ -z "$NEW_BOT_DIR" ] || rm -rf "$NEW_BOT_DIR"' EXIT
ARCHIVE="$TMP_DIR/repo.tar.gz"

curl -fsSL \
  https://github.com/Ntmib/jarvis-architect/archive/refs/heads/main.tar.gz \
  -o "$ARCHIVE"
tar -xzf "$ARCHIVE" -C "$TMP_DIR"

SOURCE_DIR="$TMP_DIR/jarvis-architect-main/bot"
BOT_DIR="/opt/agent-bot"
ENV_DIR="/etc/agent-bot"
ENV_FILE="$ENV_DIR/env"

if [[ ! -f "$SOURCE_DIR/package.json" || ! -f "$SOURCE_DIR/index.js" ]]; then
  echo "В архиве не найдены файлы бота. Ничего не изменено."
  exit 1
fi

install -d -m 700 -o agent -g agent /home/agent/.agent
install -d -m 700 -o root -g root "$ENV_DIR"
NEW_BOT_DIR=$(mktemp -d /opt/agent-bot.new.XXXXXX)
cp -a "$SOURCE_DIR/." "$NEW_BOT_DIR/"
rm -rf "$NEW_BOT_DIR/node_modules"

(
  cd "$NEW_BOT_DIR"
  npm install --omit=dev
)
chown -R root:root "$NEW_BOT_DIR"
chmod -R a+rX "$NEW_BOT_DIR"

umask 077
if command -v openssl >/dev/null 2>&1; then
  PAIRING_CODE=$(openssl rand -hex 12)
else
  PAIRING_CODE=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
fi
TMP_ENV=$(mktemp "$ENV_DIR/env.XXXXXX")
{
  printf 'BOT_TOKEN=%s\n' "$BOT_TOKEN"
  printf 'PAIRING_CODE=%s\n' "$PAIRING_CODE"
  printf 'OWNER_ID=\n'
  printf 'AGENT_HOME=/home/agent\n'
} > "$TMP_ENV"
chmod 600 "$TMP_ENV"
chown root:root "$TMP_ENV"
mv -fT "$TMP_ENV" "$ENV_FILE"
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
chown -R agent:agent /home/agent/.agent

# Каждая переустановка требует новой явной привязки. Это сбрасывает в том
# числе ошибочного владельца, которого могла назначить старая auto-lock версия.
rm -f /home/agent/.agent/owner.json

install -m 644 "$SOURCE_DIR/agent-bot.service" /etc/systemd/system/agent-bot.service
systemctl daemon-reload
systemctl stop agent-bot 2>/dev/null || true
if [[ -e "$BOT_DIR" || -L "$BOT_DIR" ]]; then
  OLD_BOT_DIR="/opt/agent-bot.old.$(date +%s).$$"
  mv -T "$BOT_DIR" "$OLD_BOT_DIR"
fi
mv -T "$NEW_BOT_DIR" "$BOT_DIR"
NEW_BOT_DIR=""
systemctl enable agent-bot
if ! systemctl restart agent-bot; then
  FAILED_BOT_DIR="/opt/agent-bot.failed.$(date +%s).$$"
  mv -T "$BOT_DIR" "$FAILED_BOT_DIR"
  if [[ -n "$OLD_BOT_DIR" && -e "$OLD_BOT_DIR" ]]; then
    mv -T "$OLD_BOT_DIR" "$BOT_DIR"
    OLD_BOT_DIR=""
    systemctl restart agent-bot || true
    echo "Новая версия не запустилась. Предыдущая версия восстановлена."
  else
    echo "Новая версия не запустилась, предыдущей установки не было."
  fi
  echo "Неудачная копия сохранена в $FAILED_BOT_DIR для диагностики."
  exit 1
fi
if [[ -n "$OLD_BOT_DIR" ]]; then
  rm -rf "$OLD_BOT_DIR"
  OLD_BOT_DIR=""
fi

unset BOT_TOKEN

echo "Telegram-бот установлен и запущен."
echo "Для безопасной привязки отправьте боту: /start $PAIRING_CODE"
echo "Не публикуйте этот код и username бота до завершения привязки."
