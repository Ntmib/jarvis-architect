#!/bin/bash
# ============================================================
# Установка рабочего окружения для AI-агента на VPS
# Курс «Архитектор нейросотрудников» — Урок 7
#
# Запуск: скачать файл, проверить адрес и выполнить отдельной командой.
# ============================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}=== $1 ===${NC}"; }

# =====================
# 1. Проверка
# =====================
step "1/6. Проверка системы"
[[ $EUID -eq 0 ]] || err "Запустите от root (вы уже root в консоли Beget)"
[[ -f /etc/os-release ]] && source /etc/os-release
MEM_MB=$(free -m | awk '/Mem:/ {print $2}')
DISK_GB=$(df -BG / | awk 'NR==2 {print $4}' | tr -d G)
log "Система: ${PRETTY_NAME:-Linux}, RAM: ${MEM_MB} MB, Диск: ${DISK_GB} GB"
[[ $MEM_MB -lt 2000 ]] && warn "Рекомендуется минимум 4 GB RAM"
[[ $DISK_GB -lt 5 ]] && err "Мало места на диске (нужно минимум 5 GB свободных)"

# IPv6 fix — Node.js иногда зависает на IPv6
sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true
sysctl -w net.ipv6.conf.default.disable_ipv6=1 >/dev/null 2>&1 || true

# =====================
# 2. Системные пакеты + Node.js
# =====================
step "2/6. Установка пакетов"

# Убираем битые репозитории NodeSource если есть
rm -f /etc/apt/sources.list.d/nodesource*.list 2>/dev/null || true
rm -f /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true

apt-get update -qq 2>&1 | grep -v "^W:" || true
apt-get install -y -qq curl git jq unzip >/dev/null 2>&1
log "Базовые пакеты установлены"

if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  NODESOURCE_SETUP=$(mktemp /root/nodesource.XXXXXX.sh)
  curl -fsSL https://deb.nodesource.com/setup_20.x -o "$NODESOURCE_SETUP"
  bash "$NODESOURCE_SETUP" >/dev/null 2>&1
  rm -f "$NODESOURCE_SETUP"
  apt-get install -y -qq nodejs >/dev/null 2>&1
fi
log "Node.js $(node -v)"

# =====================
# 3. Claude Code CLI
# =====================
step "3/6. Claude Code"
if ! command -v claude &>/dev/null; then
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1
fi
if command -v claude &>/dev/null; then
  log "Claude Code CLI установлен"
else
  err "Не удалось установить Claude Code CLI"
fi

# Права на чтение для всех пользователей
CLAUDE_BIN=$(which claude 2>/dev/null)
if [ -n "$CLAUDE_BIN" ]; then
  CLAUDE_REAL=$(readlink -f "$CLAUDE_BIN")
  CLAUDE_PKG_DIR=$(dirname "$CLAUDE_REAL")
  chmod -R a+rX "$CLAUDE_PKG_DIR" 2>/dev/null || true
  chmod a+rX "$(dirname "$CLAUDE_PKG_DIR")" 2>/dev/null || true
  chmod a+rX "$(dirname "$(dirname "$CLAUDE_PKG_DIR")")" 2>/dev/null || true
fi

# =====================
# 4. Пользователь + структура папок
# =====================
step "4/6. Рабочее окружение"

USERNAME="agent"
HOME_DIR="/home/$USERNAME"

if ! id "$USERNAME" &>/dev/null; then
  useradd -m -s /bin/bash "$USERNAME"
  log "Пользователь $USERNAME создан"
else
  log "Пользователь $USERNAME уже существует"
fi

# Структура папок
mkdir -p "$HOME_DIR/workspace/memory"
mkdir -p "$HOME_DIR/workspace/knowledge"
mkdir -p "$HOME_DIR/projects"
mkdir -p "$HOME_DIR/.agent/bot"
mkdir -p "$HOME_DIR/.claude/skills"

# Дефолтные настройки Claude Code (светофор разрешений)
if [ ! -f "$HOME_DIR/.claude/settings.json" ]; then
  curl -fsSL https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/.claude/settings.json \
    -o "$HOME_DIR/.claude/settings.json" 2>/dev/null \
    && log "Настройки Claude Code установлены" \
    || warn "Не удалось скачать settings.json — можно добавить позже"
fi

# Скиллы (навыки агента)
SKILLS_BASE="https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/.claude/skills"
for SKILL in discovery-interview content-creator fullstack-developer frontend-design; do
  if [ ! -f "$HOME_DIR/.claude/skills/$SKILL/SKILL.md" ]; then
    mkdir -p "$HOME_DIR/.claude/skills/$SKILL"
    curl -fsSL "$SKILLS_BASE/$SKILL/SKILL.md" \
      -o "$HOME_DIR/.claude/skills/$SKILL/SKILL.md" 2>/dev/null || true
  fi
done
log "Скиллы установлены (4 навыка)"

# Симлинк для единой памяти (бот и VS Code читают один CLAUDE.md)
ln -sf "$HOME_DIR/workspace/CLAUDE.md" "$HOME_DIR/CLAUDE.md"

# Права
chown -R "$USERNAME:$USERNAME" "$HOME_DIR"
chown -h "$USERNAME:$USERNAME" "$HOME_DIR/CLAUDE.md"
log "Папки готовы: workspace/ (файлы агента), projects/ (проекты)"

# =====================
# 5. VS Code Tunnel (через бот: /connect)
# =====================
# Архитектура (v2.1.0): code CLI + 5 systemd-юнитов (agent-tunnel,
# tunnel-ctl.*, tunnel-stop.*). Сервис НЕ стартует сразу — стартует когда
# ученик в боте напишет /connect (бот создаст flag-файл ~/.agent/.tunnel-start,
# path-юнит триггернёт start). 0 RAM-цены для тех кто не пользуется.
#
# Имя туннеля: agent-{md5(hostname).slice(0,8)} — привязано к серверу
# (бот в /connect вычисляет так же — get'ит то же имя).
step "5/6. VS Code Tunnel"

TUNNEL_TEMPLATES_DIR="/tmp/jarvis-tunnel-templates"
TUNNEL_BASE_URL="https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/templates/vscode-tunnel"
TUNNEL_FILES=(
  "install-vscode-tunnel.sh"
  "agent-tunnel.service"
  "tunnel-ctl.path"
  "tunnel-ctl.service"
  "tunnel-stop.path"
  "tunnel-stop.service"
)

mkdir -p "$TUNNEL_TEMPLATES_DIR"
TUNNEL_DOWNLOAD_OK=1
for f in "${TUNNEL_FILES[@]}"; do
  if ! curl -fsSL "$TUNNEL_BASE_URL/$f" -o "$TUNNEL_TEMPLATES_DIR/$f" 2>/dev/null; then
    warn "Не удалось скачать templates/vscode-tunnel/$f"
    TUNNEL_DOWNLOAD_OK=0
    break
  fi
done

if [[ $TUNNEL_DOWNLOAD_OK -eq 1 ]]; then
  chmod +x "$TUNNEL_TEMPLATES_DIR/install-vscode-tunnel.sh"
  # printf '%s' без newline — иначе md5(hostname + "\n") ≠ node os.hostname()
  TUNNEL_HEX=$(printf '%s' "$(hostname)" | md5sum | cut -c1-8)
  TUNNEL_NAME="agent-${TUNNEL_HEX}"
  log "Имя туннеля: $TUNNEL_NAME (привязано к этому серверу)"

  if bash "$TUNNEL_TEMPLATES_DIR/install-vscode-tunnel.sh" "$TUNNEL_NAME" "$TUNNEL_TEMPLATES_DIR" "$USERNAME"; then
    log "VS Code Tunnel установлен. Запусти бота → /connect для авторизации GitHub"
  else
    warn "Установка VS Code Tunnel провалилась (не критично — основной бот работает)"
    warn "Можно установить позже вручную, или просто не пользоваться /connect"
  fi
else
  warn "VS Code Tunnel пропущен — нет интернета или GitHub недоступен"
  warn "Основной бот работает; /connect не заработает пока не установить туннель"
fi

# =====================
# 6. Готово
# =====================
step "6/6. Готово!"
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Сервер готов для вашего AI-агента!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo "Что дальше:"
echo ""
echo "1. Откройте VS Code на своём компьютере"
echo "2. Слева найдите раздел «Удалённый обозреватель» (Remote Explorer)"
echo "3. В разделе Tunnels появится ваш сервер — нажмите на него"
echo "4. Перетащите мышкой ваши DNA-файлы (SOUL.md, CLAUDE.md и т.д.)"
echo "   в папку /home/agent/workspace/"
echo ""
echo "Ваш агент будет жить в: /home/agent/workspace/"
echo "Проекты агента будут в: /home/agent/projects/"
echo ""
