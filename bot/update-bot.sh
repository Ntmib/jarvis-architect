#!/bin/bash
# update-bot.sh — Обновление бота до последней версии из GitHub
# Использование: bash update-bot.sh
# Безопасно: скачивает всё в /tmp, проверяет, делает бэкап, потом заменяет

set -euo pipefail

# Detect bot directory (where this script lives, or current dir)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="${SCRIPT_DIR}"

# If script was piped via curl, detect bot dir from systemd service
if [ "$BOT_DIR" = "/tmp" ] || [ "$BOT_DIR" = "." ]; then
  if systemctl is-active --quiet agent-bot 2>/dev/null; then
    BOT_DIR=$(grep -oP 'WorkingDirectory=\K.+' /etc/systemd/system/agent-bot.service 2>/dev/null || echo "")
  fi
  if [ -z "$BOT_DIR" ] || [ ! -f "$BOT_DIR/index.js" ]; then
    # Try common locations
    for dir in /home/agent/.agent/bot /home/*/agent/.agent/bot /home/*/.agent/bot; do
      if [ -f "$dir/index.js" ] 2>/dev/null; then
        BOT_DIR="$dir"
        break
      fi
    done
  fi
fi

if [ ! -f "$BOT_DIR/index.js" ]; then
  echo "[ERROR] Bot directory not found. Run this script from the bot folder."
  exit 1
fi

echo "=== Agent Bot Update ==="
echo "Bot directory: $BOT_DIR"

# GitHub raw base URL
REPO="Ntmib/jarvis-architect"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/bot"

# Files to download
CORE_FILES="index.js secrets-menu.js voice-helper.js package.json VERSION agent-bot.service"
LIB_FILES="lib/db.js lib/embeddings.js lib/memory-indexer.js lib/memory-search.js"
SCRIPT_FILES="scripts/manage-schedule.js scripts/memory-search.js scripts/reindex.js"
MIGRATION_FILES="migrations/001_memory_index.sql"
ALL_FILES="$CORE_FILES $LIB_FILES $SCRIPT_FILES $MIGRATION_FILES update-bot.sh"

# Step 1: Download all files to temp directory
TMP_DIR=$(mktemp -d)
echo "[1/6] Downloading files to $TMP_DIR..."

FAILED=0
for file in $ALL_FILES; do
  dir=$(dirname "$file")
  mkdir -p "$TMP_DIR/$dir"
  if curl -fsSL "$BASE_URL/$file" -o "$TMP_DIR/$file" 2>/dev/null; then
    echo "  OK: $file"
  else
    echo "  SKIP: $file (not found on GitHub, may be optional)"
    rm -f "$TMP_DIR/$file"
  fi
done

# Step 2: Verify critical files exist
echo "[2/6] Verifying critical files..."
for file in index.js package.json; do
  if [ ! -f "$TMP_DIR/$file" ]; then
    echo "[ERROR] Critical file missing: $file. Aborting update."
    rm -rf "$TMP_DIR"
    exit 1
  fi
done

# Step 3: Syntax check on new index.js
echo "[3/6] Syntax check..."
if node --check "$TMP_DIR/index.js" 2>/dev/null; then
  echo "  Syntax OK"
else
  echo "[ERROR] Syntax error in new index.js. Aborting update."
  rm -rf "$TMP_DIR"
  exit 1
fi

# Step 4: Backup current files
BACKUP_DIR="$BOT_DIR/.backup-$(date +%Y%m%d-%H%M%S)"
echo "[4/6] Backing up current files to $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"
for file in $CORE_FILES; do
  if [ -f "$BOT_DIR/$file" ]; then
    cp "$BOT_DIR/$file" "$BACKUP_DIR/$file"
  fi
done
# Backup lib/ if exists
if [ -d "$BOT_DIR/lib" ]; then
  cp -r "$BOT_DIR/lib" "$BACKUP_DIR/lib"
fi

# Step 5: Copy new files
echo "[5/6] Installing update..."
for file in $ALL_FILES; do
  if [ -f "$TMP_DIR/$file" ]; then
    dir=$(dirname "$BOT_DIR/$file")
    mkdir -p "$dir"
    cp "$TMP_DIR/$file" "$BOT_DIR/$file"
  fi
done

# Make update-bot.sh executable
chmod +x "$BOT_DIR/update-bot.sh"

# Run npm install (for new dependencies like sql.js)
echo "  Running npm install..."
cd "$BOT_DIR"
npm install --production --no-audit --no-fund 2>&1 | tail -5

# Step 6: Restart bot
echo "[6/6] Restarting bot..."
SERVICE_NAME=""
for svc in agent-bot agent-bot.service; do
  if systemctl is-enabled "$svc" 2>/dev/null; then
    SERVICE_NAME="$svc"
    break
  fi
done

if [ -n "$SERVICE_NAME" ]; then
  systemctl restart "$SERVICE_NAME"
  sleep 3
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    NEW_VER=$(cat "$BOT_DIR/VERSION" 2>/dev/null || echo "unknown")
    echo ""
    echo "=== Update complete! Version: $NEW_VER ==="
    echo "Backup saved to: $BACKUP_DIR"
  else
    echo "[ERROR] Bot failed to start! Rolling back..."
    # Restore from backup
    for file in $CORE_FILES; do
      if [ -f "$BACKUP_DIR/$file" ]; then
        cp "$BACKUP_DIR/$file" "$BOT_DIR/$file"
      fi
    done
    if [ -d "$BACKUP_DIR/lib" ]; then
      cp -r "$BACKUP_DIR/lib" "$BOT_DIR/lib"
    fi
    cd "$BOT_DIR" && npm install --production --no-audit --no-fund 2>/dev/null
    systemctl restart "$SERVICE_NAME"
    echo "Rolled back to previous version. Check logs: journalctl -u $SERVICE_NAME -n 50"
    rm -rf "$TMP_DIR"
    exit 1
  fi
else
  echo "[WARN] No systemd service found. Restart the bot manually."
fi

# Cleanup
rm -rf "$TMP_DIR"
echo "Done."
