/**
 * Agent Bot v2.0 — Telegram bot powered by Claude Code CLI
 * Part of jarvis-architect: personal AI agent for course students
 *
 * Features: text + voice + photos + documents + media groups → Claude Code → response
 *           sessions, DNA files, persistent keyboard, folder structure awareness
 *           stream mode, crash recovery, circuit breaker, confirmation buttons,
 *           thinking phrases rotation, URL pre-fetch, human-friendly errors,
 *           state persistence, feature flags, semantic memory, scheduler,
 *           model selection, bootstrap, auto-continue, text batching
 */

import { Bot, InlineKeyboard, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { spawn, execFile, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync, copyFileSync, statSync, createWriteStream, appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import https from "node:https";
import http from "node:http";
import { handlePendingInput, registerSecretsHandlers } from "./secrets-menu.js";
import { hasAnyTranscriber, registerVoiceHelpers, voiceFallbackKeyboard, VOICE_FALLBACK_PROMPT } from "./voice-helper.js";

// Claude reauth (v4.7 portированo из agent-factory)
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthUrl,
  exchangeCodeForToken,
  OAUTH_SCOPES,
} from "./lib/claude-oauth.js";
import { safeEnvWrite, safeEnvRemove } from "./lib/env-write.js";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
const WORKSPACE = join(AGENT_HOME, "workspace");
const PROJECTS = join(AGENT_HOME, "projects");
const DATA_DIR = join(AGENT_HOME, ".agent");
const MEDIA_DIR = join(WORKSPACE, ".media");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const OWNER_FILE = join(DATA_DIR, "owner.json");
const SYSTEM_PROMPT_PATH = join(WORKSPACE, "CLAUDE.md");
const CRASH_CONTEXT_FILE = join(DATA_DIR, ".crash_context.md");
const STATE_FILE = join(DATA_DIR, "state.json");
const SCHEDULES_FILE = join(DATA_DIR, "schedules.json");
const MAX_SYSTEM_PROMPT_CHARS = 30000;
const STREAM_THROTTLE_MS = 1500;
const BOT_VERSION = (() => {
  try { return readFileSync(join(import.meta.dirname, "VERSION"), "utf8").trim(); }
  catch { return "2.0.0"; }
})();

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

// Ensure directories exist
for (const dir of [DATA_DIR, join(WORKSPACE, "memory"), join(WORKSPACE, "knowledge"), PROJECTS, MEDIA_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── STATE PERSISTENCE ──────────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // Migration: v1 state.json may lack bootstrapDone — check DNA files
    if (s.bootstrapDone === undefined) {
      const hasExistingFiles = existsSync(join(WORKSPACE, "USER.md")) ||
                               existsSync(join(WORKSPACE, "SOUL.md")) ||
                               existsSync(join(WORKSPACE, "MEMORY.md"));
      s.bootstrapDone = hasExistingFiles;
      writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
    }
    return s;
  } catch {
    // No state.json — check if this is an existing user (has DNA files)
    const hasExistingFiles = existsSync(join(WORKSPACE, "USER.md")) ||
                             existsSync(join(WORKSPACE, "SOUL.md")) ||
                             existsSync(join(WORKSPACE, "MEMORY.md"));
    return {
      model: "sonnet",
      mode: "normal",
      timezone: "Europe/Moscow",
      bootstrapDone: hasExistingFiles, // skip bootstrap for existing users
      dailySpendLimit: 50,
      costHistory: {},
      featureFlags: {},
    };
  }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

let state = loadState();

function isFeatureEnabled(flag) {
  return state.featureFlags?.[flag] === true;
}

// ─── SEMANTIC MEMORY (optional — dynamic import) ────────────────────────────

let _semanticMemory = null;

async function initSemanticMemory() {
  try {
    const { initDb, saveNow } = await import("./lib/db.js");
    const { startWatcher, reindexAll } = await import("./lib/memory-indexer.js");
    await initDb();
    startWatcher();
    reindexAll().catch((e) => console.warn("[semantic-memory] reindexAll error:", e.message));
    _semanticMemory = { initDb, saveNow };
    console.log("[semantic-memory] Initialized");
  } catch (e) {
    console.warn("[semantic-memory] Not available:", e.message);
    _semanticMemory = null;
  }
}

// ─── SCHEDULER ──────────────────────────────────────────────────────────────

function loadSchedules() {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, "utf8"));
  } catch {
    return [];
  }
}

let _schedulerTimer = null;

function startScheduler() {
  if (_schedulerTimer) return;
  _schedulerTimer = setInterval(async () => {
    const schedules = loadSchedules();
    if (schedules.length === 0) return;

    const now = new Date();
    const tz = state.timezone || "Europe/Moscow";
    const localStr = now.toLocaleString("en-US", { timeZone: tz });
    const local = new Date(localStr);
    const hour = local.getHours();
    const minute = local.getMinutes();
    const dow = local.getDay() === 0 ? 7 : local.getDay(); // 1=Mon..7=Sun

    for (const sched of schedules) {
      if (!sched.enabled) continue;

      let shouldFire = false;

      if (sched.type === "daily" && sched.hour === hour && (sched.minute || 0) === minute) {
        shouldFire = true;
      } else if (sched.type === "weekly" && sched.hour === hour && (sched.minute || 0) === minute && sched.weekdays?.includes(dow)) {
        shouldFire = true;
      } else if (sched.type === "once" && sched.at) {
        const fireAt = new Date(sched.at);
        if (now >= fireAt && now - fireAt < 90000) shouldFire = true; // within 90s window
      }

      if (!shouldFire) continue;

      // Dedup: skip if already fired this minute
      const fireKey = `${sched.id}_${hour}_${minute}`;
      if (sched._lastFire === fireKey) continue;
      sched._lastFire = fireKey;

      console.log(`[scheduler] Firing: ${sched.name} (${sched.type})`);

      try {
        if (sched.payload === "reminder" && sched.text) {
          if (_ownerId) {
            await bot.api.sendMessage(_ownerId, sched.text);
          }
        } else if (sched.payload === "task" && sched.prompt) {
          if (_ownerId) {
            const result = await callClaude(sched.prompt, null);
            await sendToOwner(result.text);
          }
        }
      } catch (e) {
        console.error(`[scheduler] Error in ${sched.name}:`, e.message);
      }

      // Delete once-type after firing
      if (sched.deleteAfterRun) {
        const all = loadSchedules();
        const filtered = all.filter((s) => s.id !== sched.id);
        writeFileSync(SCHEDULES_FILE, JSON.stringify(filtered, null, 2));
      }
    }
  }, 60000); // check every minute
  console.log("[scheduler] Started");
}

async function sendToOwner(text) {
  if (!_ownerId) return;
  const html = mdToTgHtml(text);
  const chunks = sendChunked(html);
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(_ownerId, chunk, { parse_mode: "HTML" });
    } catch {
      await bot.api.sendMessage(_ownerId, chunk.replace(/<[^>]+>/g, ""));
    }
  }
}

// ─── OWNER CHECK (auto-lock to first user) ──────────────────────────────────

// Priority: OWNER_ID env var > owner.json file > auto-lock on first /start
let _ownerId = process.env.OWNER_ID || null;

function loadOwner() {
  if (_ownerId) return; // env var takes priority
  try {
    const data = JSON.parse(readFileSync(OWNER_FILE, "utf8"));
    _ownerId = String(data.id);
    console.log(`[owner] loaded from file: ${_ownerId} (${data.name || "unknown"})`);
  } catch {}
}

function saveOwner(ctx) {
  const data = {
    id: String(ctx.from.id),
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
    username: ctx.from.username || null,
    lockedAt: new Date().toISOString(),
  };
  _ownerId = data.id;
  writeFileSync(OWNER_FILE, JSON.stringify(data, null, 2));
  console.log(`[owner] auto-locked to: ${data.id} (${data.name})`);
}

loadOwner();

function isOwner(ctx) {
  if (!_ownerId) return false; // No owner yet — only /start can set it
  return String(ctx.from?.id) === String(_ownerId);
}

// ─── SPEND TRACKING ─────────────────────────────────────────────────────────

function recordSpend(cost) {
  if (!cost) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!state.costHistory) state.costHistory = {};
  state.costHistory[today] = (state.costHistory[today] || 0) + cost;
  saveState(state);
}

function getTodaySpend() {
  const today = new Date().toISOString().slice(0, 10);
  return state.costHistory?.[today] || 0;
}

function checkSpendLimit() {
  const spent = getTodaySpend();
  const limit = state.dailySpendLimit || 50;
  if (spent >= limit) return "blocked";
  if (spent >= limit * 0.8) return "warning";
  return "ok";
}

// ─── SESSIONS ────────────────────────────────────────────────────────────────

function loadSessions() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(SESSIONS_FILE, "utf8"))));
  } catch {
    return new Map();
  }
}

function saveSessions() {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    console.error("[sessions] save error:", e.message);
  }
}

const sessions = loadSessions();

// ─── CIRCUIT BREAKER (rate limiting protection) ─────────────────────────────

let _rateLimitUntil = 0;

function setGlobalRateLimit(retryAfterSec) {
  _rateLimitUntil = Date.now() + (retryAfterSec || 5) * 1000;
  console.warn(`[rate-limit] breaker ON for ${retryAfterSec}s`);
}

function isGloballyRateLimited() {
  return Date.now() < _rateLimitUntil;
}

// ─── SYSTEM PROMPT (with mtime caching) ─────────────────────────────────────

const ARCHITECTURE_CONTEXT = `
## Архитектура файловой системы агента

Ты работаешь на VPS-сервере. Вот структура папок:

/home/agent/                    <- твой дом на сервере
|-- .claude/                    <- настройки Claude Code
|   |-- settings.json           <- правила светофора (зелёный/жёлтый/красный)
|   +-- skills/                 <- навыки (скиллы)
|-- workspace/                  <- главная рабочая папка (cwd)
|   |-- CLAUDE.md               <- правила работы
|   |-- SOUL.md                 <- твоя личность
|   |-- MEMORY.md               <- долгосрочная память (обновляй!)
|   |-- GOALS.md                <- цели пользователя
|   |-- USER.md, MISSION.md, PROJECTS.md, PREFERENCES.md, LEARNED.md
|   |-- .media/                 <- медиафайлы от пользователя (фото, документы)
|   |-- memory/                 <- дневники по дням (YYYY-MM-DD.md)
|   +-- knowledge/              <- база знаний (справочники, инструкции)
|-- projects/                   <- папка для ПРОЕКТОВ (каждый проект в подпапке)
|   +-- название-проекта/       <- сюда создавай новые проекты
+-- .agent/                     <- служебная папка бота (не трогай)

ВАЖНО:
- Новые проекты ВСЕГДА создавай в /home/agent/projects/название-проекта/, НЕ в workspace/
- Workspace — только для DNA-файлов и памяти
- Скиллы лежат в /home/agent/.claude/skills/ — если пользователь просит установить скилл, клади туда
- Настройки Claude Code (settings.json) — в /home/agent/.claude/
- Медиафайлы от пользователя сохраняются в workspace/.media/ — используй Read для их чтения
- При создании проекта: mkdir -p ~/projects/название && cd ~/projects/название
`;

const MAX_MEMORY_CHARS = 15000;
const MAX_DIARY_CHARS = 2000;

// Cache for system prompt file
let _sysPromptCache = { mtime: 0, content: "" };

function _safeRead(path) {
  try {
    if (!existsSync(path)) return "";
    return readFileSync(path, "utf8");
  } catch { return ""; }
}

function _cachedRead(path) {
  try {
    const stat = statSync(path);
    const mtime = stat.mtimeMs;
    if (mtime === _sysPromptCache.mtime) return _sysPromptCache.content;
    const content = readFileSync(path, "utf8");
    _sysPromptCache = { mtime, content };
    return content;
  } catch { return ""; }
}

function buildSystemPrompt() {
  const parts = [];

  // 1. CLAUDE.md is auto-loaded by Claude Code CLI from cwd (WORKSPACE)
  //    We do NOT inject it here to avoid double-loading and wasting tokens.
  //    Only inject what Claude CLI doesn't see: DNA files, diaries, architecture.

  // 2. Architecture context
  parts.push(ARCHITECTURE_CONTEXT);

  // 3. All DNA files (skip CLAUDE.md — already loaded)
  const dnaFiles = [
    "SOUL.md", "USER.md", "MEMORY.md", "MISSION.md",
    "GOALS.md", "PROJECTS.md", "PREFERENCES.md", "LEARNED.md",
  ];
  for (const name of dnaFiles) {
    const text = _safeRead(join(WORKSPACE, name));
    if (text) {
      const trimmed = name === "MEMORY.md" && text.length > MAX_MEMORY_CHARS
        ? text.slice(0, MAX_MEMORY_CHARS) + "\n...(truncated)"
        : text;
      parts.push(`--- ${name} ---\n${trimmed}`);
    }
  }

  // 4. Today's diary (last N chars — newest data)
  const today = new Date().toISOString().split("T")[0];
  const todayText = _safeRead(join(WORKSPACE, "memory", `${today}.md`));
  if (todayText) {
    const d = todayText.length > MAX_DIARY_CHARS ? todayText.slice(-MAX_DIARY_CHARS) : todayText;
    parts.push(`--- Дневник ${today} ---\n${d}`);
  }

  // 5. Yesterday's diary
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().split("T")[0];
  const yText = _safeRead(join(WORKSPACE, "memory", `${yStr}.md`));
  if (yText) {
    const d = yText.length > MAX_DIARY_CHARS ? yText.slice(-MAX_DIARY_CHARS) : yText;
    parts.push(`--- Дневник ${yStr} ---\n${d}`);
  }

  // 6. Crash context (if previous session crashed)
  if (existsSync(CRASH_CONTEXT_FILE)) {
    try {
      const ctx = readFileSync(CRASH_CONTEXT_FILE, "utf8");
      parts.push(`--- Контекст: предыдущая сессия завершилась ошибкой ---\n${ctx}`);
      unlinkSync(CRASH_CONTEXT_FILE);
      console.log("[crash-recovery] injected crash context");
    } catch {}
  }

  // 7. Current date + memory nudge
  parts.push(`# Current date\n${today}`);
  parts.push("# Memory reminder\nЕсли в этом диалоге появились важные факты, решения или предпочтения клиента — сохрани их в memory/YYYY-MM-DD.md или MEMORY.md. Не теряй контекст между сессиями.");

  // Trim to max
  let result = parts.join("\n\n");
  if (result.length > MAX_SYSTEM_PROMPT_CHARS) {
    result = result.slice(0, MAX_SYSTEM_PROMPT_CHARS);
  }
  return result;
}

// ─── STATUS MESSAGE (typing animation) ──────────────────────────────────────

const THINKING_PHRASES = [
  ["Думаю…", "⏳"],
  ["Думаю…", "⌛️"],
  ["Соображаю…", "🤔"],
  ["Мозгую…", "🧠"],
  ["Формулирую…", "🧐"],
  ["Составляю текст…", "📝"],
  ["Принимаю решения…", "⚡️"],
  ["Готовлю план…", "📋"],
  ["Анализирую…", "🔍"],
  ["Обрабатываю…", "⚙️"],
];

function formatThinkingPhrase(index, elapsedSec) {
  const [text, emoji] = THINKING_PHRASES[index % THINKING_PHRASES.length];
  const timer = elapsedSec >= 2 ? ` ${elapsedSec}с` : "";
  return `${text} ${emoji}${timer}`;
}

class StatusMessage {
  constructor(ctx, messageId) {
    this.ctx = ctx;
    this.chatId = ctx.chat.id;
    this.messageId = messageId;
    this.phraseIndex = 0;
    this.startTime = Date.now();
    this.typingInterval = null;
    this.animationInterval = null;
    this.stopped = false;
    this.streamingText = "";
    this.rateLimitedUntil = 0;
  }

  _activateBreaker(retryAfterSec) {
    this.rateLimitedUntil = Date.now() + (retryAfterSec * 1000) + 2000;
    setGlobalRateLimit(retryAfterSec);
  }

  _isBreakerActive() {
    return Date.now() < this.rateLimitedUntil || isGloballyRateLimited();
  }

  start() {
    this.typingInterval = setInterval(async () => {
      if (this.stopped || this._isBreakerActive()) return;
      try {
        await this.ctx.api.sendChatAction(this.chatId, "typing");
      } catch (e) {
        if (e?.error_code === 429) {
          this._activateBreaker(e?.parameters?.retry_after || 30);
        }
      }
    }, 4000);

    this.animationInterval = setInterval(async () => {
      if (this.stopped || this.streamingText || this._isBreakerActive()) return;
      this.phraseIndex = (this.phraseIndex + 1) % THINKING_PHRASES.length;
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      try {
        await this.ctx.api.editMessageText(
          this.chatId, this.messageId,
          formatThinkingPhrase(this.phraseIndex, elapsed)
        );
      } catch (e) {
        if (e?.error_code === 429) {
          this._activateBreaker(e?.parameters?.retry_after || 30);
        }
      }
    }, 2000);

    this.ctx.api.sendChatAction(this.chatId, "typing").catch(() => {});
  }

  async updateStreaming(text) {
    if (this.stopped) return;
    this.streamingText = text;
    if (this._isBreakerActive()) return;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const display = text.length > 3500 ? "…" + text.slice(-3500) : text;
    const indicator = `\n\n⏳ ${elapsed}с`;
    try {
      await this.ctx.api.editMessageText(this.chatId, this.messageId, display + indicator);
    } catch (e) {
      if (e?.error_code === 429) {
        this._activateBreaker(e?.parameters?.retry_after || 30);
      }
    }
  }

  stop() {
    this.stopped = true;
    if (this.typingInterval) clearInterval(this.typingInterval);
    if (this.animationInterval) clearInterval(this.animationInterval);
    this.typingInterval = null;
    this.animationInterval = null;
  }
}

let _activeStatus = null;

// ─── HUMAN-FRIENDLY ERRORS ──────────────────────────────────────────────────

function humanizeError(errMsg) {
  const msg = String(errMsg);
  if (msg.includes("429") || msg.includes("rate")) return "Слишком много запросов. Подожди минутку и попробуй снова.";
  if (msg.includes("529") || msg.includes("503") || msg.includes("overloaded")) return "Серверы Claude перегружены. Попробуй через пару минут.";
  if (msg.includes("401") || msg.includes("auth")) return "Проблема с авторизацией Claude. Нужно заново авторизоваться (claude auth login).";
  if (msg.includes("image") || msg.includes("Could not process")) return "Не получилось обработать файл. Попробуй отправить в другом формате.";
  if (msg.includes("timeout") || msg.includes("TIMEOUT")) return "Claude думал слишком долго. Попробуй задать вопрос короче.";
  if (msg.includes("session") || msg.includes("corrupt")) return "Сессия повреждена. Нажми 🔄 Новый диалог.";
  return null; // unknown error — show generic message
}

// ─── URL PRE-FETCH (with Google Docs/Sheets support) ────────────────────────

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const GDOCS_RE = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;
const GSHEETS_RE = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

function httpGet(url, maxLen = 50000) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 15000, headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, maxLen).then(resolve);
      }
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; if (data.length > maxLen) { res.destroy(); resolve(data.slice(0, maxLen)); } });
      res.on("end", () => resolve(data));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function prefetchUrls(text) {
  const urls = text.match(URL_RE);
  if (!urls || urls.length === 0) return "";

  const fetched = [];
  for (const url of urls.slice(0, 3)) {
    try {
      let content = null;
      let source = url;

      // Google Docs -> export as HTML
      const gdocMatch = url.match(GDOCS_RE);
      if (gdocMatch) {
        const docId = gdocMatch[1];
        content = await httpGet(`https://docs.google.com/document/d/${docId}/export?format=html`);
        if (content) {
          content = stripHtml(content);
          source = `Google Doc (${docId})`;
        }
      }

      // Google Sheets -> export as CSV
      const gsheetMatch = url.match(GSHEETS_RE);
      if (gsheetMatch && !content) {
        const sheetId = gsheetMatch[1];
        content = await httpGet(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`);
        source = `Google Sheet (${sheetId})`;
      }

      // Regular URL
      if (!content) {
        const raw = await httpGet(url, 10000);
        if (raw) content = stripHtml(raw);
      }

      if (content && content.length > 100) {
        fetched.push({ url, source, content: content.slice(0, 30000) });
      }
    } catch (e) {
      console.error(`[prefetch] Error fetching ${url}:`, e.message);
    }
  }

  if (fetched.length === 0) return "";
  return "\n\n" + fetched.map(f =>
    `--- Содержимое ${f.source} (${f.url}) ---\n${f.content}\n--- Конец документа ---`
  ).join("\n\n");
}

// ─── CLAUDE CODE CLI ─────────────────────────────────────────────────────────

// Sequential queue — only one Claude call at a time
let _queue = Promise.resolve();
let _activeChild = null; // Track running Claude process for /stop
// _activeStatus is declared above with StatusMessage class

function isCliBusy() {
  return _activeChild !== null;
}

function callClaude(prompt, sessionId, { onText } = {}) {
  const p = _queue.then(() => _callClaudeInner(prompt, sessionId, { onText }));
  _queue = p.catch(() => {});
  return p;
}

function _getSessionSize(sessionId) {
  // Kept for diagnostics only — no longer used to kill sessions.
  // autocompact (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90") manages context natively.
  if (!sessionId) return 0;
  try {
    const sessDir = join(AGENT_HOME, ".claude", "sessions");
    const sessFile = join(sessDir, sessionId + ".jsonl");
    if (existsSync(sessFile)) return statSync(sessFile).size;
  } catch {}
  return 0;
}

function _callClaudeInner(prompt, sessionId, { onText } = {}) {
  return new Promise((resolve, reject) => {

    const useStream = typeof onText === "function";
    const args = [
      "-p", prompt,
      "--output-format", useStream ? "stream-json" : "json",
      "--max-turns", "15",
      "--model", getCurrentModel(),
      "--dangerously-skip-permissions",
    ];

    const systemPrompt = buildSystemPrompt();
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

    if (sessionId) args.push("--resume", sessionId);

    const child = spawn("claude", args, {
      cwd: WORKSPACE,
      env: { ...process.env, HOME: AGENT_HOME },
      timeout: 600000, // 10 min
    });
    _activeChild = child;
    child.on("close", () => { if (_activeChild === child) _activeChild = null; });
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let lastText = "";
    let lastStreamTs = 0;
    let resultSessionId = sessionId;
    let cost = 0;

    child.stdout.on("data", (d) => {
      stdout += d;

      if (useStream) {
        // Parse JSONL lines for streaming
        const lines = stdout.split("\n");
        stdout = lines.pop(); // keep incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.type === "assistant" && obj.message?.content) {
              for (const block of obj.message.content) {
                if (block.type === "text" && block.text) {
                  lastText = block.text;
                  const now = Date.now();
                  if (now - lastStreamTs >= STREAM_THROTTLE_MS) {
                    lastStreamTs = now;
                    onText(lastText);
                  }
                }
              }
            } else if (obj.type === "result") {
              resultSessionId = obj.session_id || sessionId;
              cost = obj.cost_usd || 0;
              if (obj.result) lastText = obj.result;
            }
          } catch {}
        }
      }
    });

    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      if (useStream) {
        // Parse any remaining line
        if (stdout.trim()) {
          try {
            const obj = JSON.parse(stdout);
            if (obj.type === "result") {
              resultSessionId = obj.session_id || sessionId;
              cost = obj.cost_usd || 0;
              if (obj.result) lastText = obj.result;
            }
          } catch {}
        }
        recordSpend(cost);
        resolve({
          text: lastText || "(пустой ответ)",
          sessionId: resultSessionId,
          cost,
        });
        return;
      }

      // Non-stream JSON mode
      if (code !== 0 && !stdout.trim()) {
        // Save crash context for recovery
        try {
          writeFileSync(CRASH_CONTEXT_FILE,
            `Последний запрос (${new Date().toISOString()}):\n${prompt.slice(0, 500)}\n\nОшибка: exit ${code}\n${stderr.slice(0, 300)}`);
        } catch {}
        return reject(new Error(`Claude exit ${code}: ${stderr.slice(0, 300)}`));
      }
      try {
        const result = JSON.parse(stdout);
        const rcost = result.cost_usd || 0;
        recordSpend(rcost);
        resolve({
          text: result.result || result.text || "(пустой ответ)",
          sessionId: result.session_id || sessionId,
          cost: rcost,
        });
      } catch {
        const text = stdout.trim();
        resolve({ text: text || "(пустой ответ)", sessionId, cost: 0 });
      }
    });

    child.on("error", (err) => {
      // Save crash context
      try {
        writeFileSync(CRASH_CONTEXT_FILE,
          `Последний запрос (${new Date().toISOString()}):\n${prompt.slice(0, 500)}\n\nОшибка: ${err.message}`);
      } catch {}
      reject(err);
    });
  });
}

// ─── FILE DOWNLOAD ──────────────────────────────────────────────────────────

async function downloadTgFile(url, destPath) {
  const proto = url.startsWith("https") ? https : http;
  const response = await new Promise((resolve, reject) => {
    proto.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      resolve(res);
    }).on("error", reject);
  });
  await pipeline(response, createWriteStream(destPath));
}

async function downloadAndSave(ctx, fileId, ext) {
  const file = await ctx.api.getFile(fileId);
  const tmpPath = `/tmp/media_${Date.now()}_${fileId.slice(-8)}${ext}`;
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  await downloadTgFile(fileUrl, tmpPath);

  // Move to persistent .media/ directory (copyFile+unlink for cross-filesystem safety)
  const destPath = join(MEDIA_DIR, `${Date.now()}_${fileId.slice(-8)}${ext}`);
  try {
    renameSync(tmpPath, destPath);
  } catch {
    copyFileSync(tmpPath, destPath);
    unlinkSync(tmpPath);
  }
  return destPath;
}

// ─── MEDIA BATCH (for handling multiple photos at once) ─────────────────────

const MEDIA_BATCH_DELAY_MS = 2500;
const mediaBatch = new Map(); // chatId -> { items, caption, ctx, timer, statusMsgId }

async function enqueueMedia(ctx, item) {
  if (!isOwner(ctx)) return;
  const key = String(ctx.chat.id);
  let batch = mediaBatch.get(key);

  if (batch) {
    // Add to existing batch, restart timer
    batch.items.push(item);
    if (item.caption && !batch.caption) batch.caption = item.caption;
    batch.ctx = ctx;
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => processMediaBatch(key), MEDIA_BATCH_DELAY_MS);
    try {
      await ctx.api.editMessageText(ctx.chat.id, batch.statusMsgId,
        `Принимаю файлы... (${batch.items.length} шт) ⏳`);
    } catch {}
    return;
  }

  // First item — create new batch
  const statusMsg = await ctx.reply(`Принимаю файл... ⏳`);
  batch = {
    items: [item],
    caption: item.caption || null,
    chatId: ctx.chat.id,
    userId: String(ctx.from.id),
    statusMsgId: statusMsg.message_id,
    ctx,
    timer: null,
  };
  batch.timer = setTimeout(() => processMediaBatch(key), MEDIA_BATCH_DELAY_MS);
  mediaBatch.set(key, batch);
}

async function processMediaBatch(key) {
  const batch = mediaBatch.get(key);
  if (!batch) return;
  mediaBatch.delete(key);
  clearTimeout(batch.timer);

  const { ctx, items, userId, chatId, statusMsgId } = batch;

  try {
    await ctx.api.editMessageText(chatId, statusMsgId,
      `Скачиваю ${items.length === 1 ? "файл" : items.length + " файлов"}... ⏳`);
  } catch {}

  // Download all files
  const downloaded = [];
  for (const it of items) {
    try {
      const path = await downloadAndSave(ctx, it.fileId, it.ext);
      downloaded.push({ ...it, path });
      console.log(`[media] ${userId} saved ${it.kind} -> ${path}`);
    } catch (e) {
      console.warn(`[media] download failed for ${it.kind}: ${e.message}`);
    }
  }

  if (downloaded.length === 0) {
    try {
      await ctx.api.editMessageText(chatId, statusMsgId, "Не удалось скачать файлы. Попробуй ещё раз.");
    } catch {}
    return;
  }

  // Build prompt with file paths
  const filesBlock = downloaded
    .map((d) => {
      const label = d.kind === "photo" ? "Фото" : d.kind === "video" ? "Видео" : `Файл (${d.fileName || d.ext})`;
      return `${label}: ${d.path}`;
    })
    .join("\n");

  const mediaIntro = downloaded.length === 1
    ? "Пользователь отправил медиа. Файл сохранён — открой через Read:"
    : `Пользователь отправил ${downloaded.length} медиа. Файлы сохранены — открой через Read:`;

  const caption = batch.caption || "";
  const prompt = `${mediaIntro}\n${filesBlock}${caption ? `\n\nПодпись пользователя: ${caption}` : ""}`;

  const status = new StatusMessage(ctx, statusMsgId);
  _activeStatus = status;
  status.start();

  try {
    const sessionId = sessions.get(userId) || null;
    const result = await callClaude(prompt, sessionId);

    if (result.sessionId) {
      sessions.set(userId, result.sessionId);
      saveSessions();
    }

    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    await sendResponse(ctx, result.text);
  } catch (err) {
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.error("[media-error]", err.message);
    const friendly = humanizeError(err.message);
    await ctx.reply(friendly || "Ошибка обработки медиа. Попробуй ещё раз или нажми 🔄 Новый диалог.");
  }
}

// ─── VOICE HANDLING ──────────────────────────────────────────────────────────

async function transcribeVoice(filePath) {
  // 1. Try Deepgram
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (apiKey) {
    try {
      return await _deepgramTranscribe(filePath, apiKey);
    } catch (e) {
      console.warn("[voice] Deepgram failed:", e.message);
    }
  }

  // 2. Fallback: local Whisper
  try {
    return _whisperTranscribe(filePath);
  } catch {
    return null;
  }
}

function _deepgramTranscribe(filePath, apiKey) {
  return new Promise((resolve, reject) => {
    const fileData = readFileSync(filePath);
    const options = {
      hostname: "api.deepgram.com",
      path: "/v1/listen?model=nova-2&language=ru&smart_format=true",
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/ogg",
        "Content-Length": fileData.length,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          resolve(result.results?.channels?.[0]?.alternatives?.[0]?.transcript || "");
        } catch {
          resolve("");
        }
      });
    });
    req.on("error", reject);
    req.write(fileData);
    req.end();
  });
}

function _whisperTranscribe(filePath) {
  try {
    execSync("which whisper", { stdio: "ignore" });
  } catch {
    return null; // whisper not installed
  }
  try {
    const outDir = "/tmp";
    execSync(`whisper "${filePath}" --model base --language ru --output_format txt --output_dir ${outDir}`, {
      timeout: 60000,
      stdio: "ignore",
    });
    const txtFile = filePath.replace(/\.\w+$/, ".txt");
    const altTxtFile = join(outDir, basename(filePath).replace(/\.\w+$/, ".txt"));
    const resultFile = existsSync(txtFile) ? txtFile : existsSync(altTxtFile) ? altTxtFile : null;
    if (resultFile) {
      const text = readFileSync(resultFile, "utf8").trim();
      try { unlinkSync(resultFile); } catch {}
      return text;
    }
  } catch (e) {
    console.warn("[voice] Whisper failed:", e.message);
  }
  return null;
}

// ─── MARKDOWN → TELEGRAM HTML ────────────────────────────────────────────────

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mdToTgHtml(text) {
  if (!text) return "";
  let result = text;

  // Code blocks: ```lang\n...\n``` → <pre>...</pre>
  result = result.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    return `<pre>${escapeHtml(code.trim())}</pre>`;
  });

  // Inline code: `...` → <code>...</code>
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    return `<code>${escapeHtml(code)}</code>`;
  });

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic: *text* or _text_
  result = result.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<i>$1</i>");

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headings: remove # prefix, make bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  return result;
}

// ─── MEDIA TAGS (Claude → Telegram file sending) ────────────────────────────

const MEDIA_TAG_RE = /\[(ФОТО|ФАЙЛ|СТИКЕР|ВИДЕО|АУДИО|ГОЛОС|GIF|PHOTO|FILE|STICKER|VIDEO|AUDIO|VOICE|ANIMATION):\s*([^\]\s]+)(?:\s+([^\]]*))?\]/gi;

const MEDIA_TYPE_MAP = {
  "ФОТО": "photo", "PHOTO": "photo",
  "ФАЙЛ": "document", "FILE": "document",
  "СТИКЕР": "sticker", "STICKER": "sticker",
  "ВИДЕО": "video", "VIDEO": "video",
  "АУДИО": "audio", "AUDIO": "audio",
  "ГОЛОС": "voice", "VOICE": "voice",
  "GIF": "animation", "ANIMATION": "animation",
};

function extractMediaTags(text) {
  const media = [];
  const cleaned = text.replace(MEDIA_TAG_RE, (_, type, path, caption) => {
    let filePath = path.trim();
    let fileCaption = caption?.trim()?.slice(0, 1024) || undefined;

    if (!filePath.startsWith("http") && !existsSync(filePath) && fileCaption) {
      const fullPath = (filePath + " " + fileCaption).replace(/\s+$/, "");
      if (existsSync(fullPath)) {
        filePath = fullPath;
        fileCaption = undefined;
      }
    }

    media.push({
      type: MEDIA_TYPE_MAP[type.toUpperCase()] || "document",
      path: filePath,
      caption: fileCaption,
    });
    return "";
  });
  return { cleaned: cleaned.trim(), media };
}

async function sendMediaItem(ctx, item) {
  try {
    const isUrl = /^https?:\/\//i.test(item.path);
    let source;
    if (isUrl) {
      source = item.path;
    } else if (existsSync(item.path)) {
      const buf = await readFile(item.path);
      source = new InputFile(buf, basename(item.path));
    } else {
      await ctx.reply(`Файл не найден: ${item.path}`);
      return;
    }
    const opts = {};
    if (item.caption && item.type !== "sticker") opts.caption = item.caption;

    switch (item.type) {
      case "photo": await ctx.replyWithPhoto(source, opts); break;
      case "document": await ctx.replyWithDocument(source, opts); break;
      case "voice": await ctx.replyWithVoice(source, opts); break;
      case "video": await ctx.replyWithVideo(source, opts); break;
      case "audio": await ctx.replyWithAudio(source, opts); break;
      case "animation": await ctx.replyWithAnimation(source, opts); break;
      case "sticker": await ctx.replyWithSticker(source); break;
      default: await ctx.replyWithDocument(source, opts);
    }
  } catch (e) {
    console.error(`[media] Failed to send ${item.type} ${item.path}:`, e.message);
    await ctx.reply(`Не удалось отправить: ${basename(item.path)}`).catch(() => {});
  }
}

// ─── CONFIRMATION BUTTONS ───────────────────────────────────────────────────

function needsConfirmation(text) {
  const lower = text.toLowerCase();
  return /делаем\s*\?|план:|✔\s*(или|\/)\s*✖/i.test(lower);
}

function confirmKeyboard() {
  return new InlineKeyboard()
    .text("✔ Продолжай", "confirm_continue")
    .text("✖ Стоп", "confirm_stop");
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getStatusText() {
  const dnaFiles = ["SOUL.md", "USER.md", "MEMORY.md", "MISSION.md", "GOALS.md", "PROJECTS.md", "PREFERENCES.md", "LEARNED.md"];
  const found = dnaFiles.filter((f) => existsSync(join(WORKSPACE, f)));
  const missing = dnaFiles.filter((f) => !existsSync(join(WORKSPACE, f)));

  let projectsList = "пусто";
  try {
    const dirs = readdirSync(PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (dirs.length > 0) projectsList = dirs.join(", ");
  } catch {}

  // Count media files
  let mediaCount = 0;
  try {
    mediaCount = readdirSync(MEDIA_DIR).length;
  } catch {}

  // Count skills
  let skillCount = 0;
  try {
    const skillDir = join(AGENT_HOME, ".claude", "skills");
    if (existsSync(skillDir)) {
      skillCount = readdirSync(skillDir, { withFileTypes: true }).filter(d => d.isDirectory()).length;
    }
  } catch {}

  const today = new Date().toISOString().split("T")[0];
  const hasDiary = existsSync(join(WORKSPACE, "memory", `${today}.md`));

  return (
    `📋 Статус агента\n\n` +
    `DNA-файлы: ${found.length}/${dnaFiles.length} (${found.join(", ")})\n` +
    `${missing.length > 0 ? `Не найдены: ${missing.join(", ")}\n` : ""}` +
    `Дневник сегодня: ${hasDiary ? "есть" : "нет"}\n` +
    `Медиафайлов: ${mediaCount}\n` +
    `Скиллов: ${skillCount}\n` +
    `Проекты: ${projectsList}\n\n` +
    `Workspace: ${WORKSPACE}\n` +
    `Проекты: ${PROJECTS}`
  );
}

function getProjectsText() {
  let dirs = [];
  try {
    dirs = readdirSync(PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {}

  if (dirs.length === 0) {
    return (
      `📁 Проекты\n\n` +
      `Папка проектов пока пустая.\n` +
      `Путь: ${PROJECTS}\n\n` +
      `Попросите меня создать проект — я создам его здесь.`
    );
  }

  return (
    `📁 Проекты (${dirs.length})\n\n` +
    dirs.map((d) => `- ${d}`).join("\n") +
    `\n\nПуть: ${PROJECTS}`
  );
}

function getMemoryText() {
  const memoryDir = join(WORKSPACE, "memory");
  let files = [];
  try {
    files = readdirSync(memoryDir)
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .sort()
      .reverse()
      .slice(0, 7);
  } catch {}

  const memoryExists = existsSync(join(WORKSPACE, "MEMORY.md"));
  let memorySize = 0;
  if (memoryExists) {
    try {
      memorySize = readFileSync(join(WORKSPACE, "MEMORY.md"), "utf8").split("\n").length;
    } catch {}
  }

  return (
    `🧠 Память\n\n` +
    `MEMORY.md: ${memoryExists ? `${memorySize} строк` : "не найден"}\n\n` +
    `Последние дневники:\n` +
    (files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "пусто") +
    `\n\nПуть: ${WORKSPACE}/memory/`
  );
}

// ─── SEND RESPONSE ──────────────────────────────────────────────────────────

const CHUNK_SOFT_LIMIT = 1800;
const CHUNK_HARD_LIMIT = 4096;

function sendChunked(html) {
  const chunks = [];
  const paragraphs = html.split("\n\n");
  let current = "";

  for (const para of paragraphs) {
    if (para.length > CHUNK_HARD_LIMIT) {
      // Split oversized paragraph by lines
      if (current) { chunks.push(current); current = ""; }
      const lines = para.split("\n");
      for (const line of lines) {
        if (current.length + line.length + 1 > CHUNK_HARD_LIMIT) {
          if (current) chunks.push(current);
          current = line.slice(0, CHUNK_HARD_LIMIT);
        } else {
          current = current ? current + "\n" + line : line;
        }
      }
    } else if (current.length + para.length + 2 > CHUNK_SOFT_LIMIT && current) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendResponse(ctx, text) {
  // Extract media tags before formatting
  const { cleaned, media } = extractMediaTags(text);
  const html = mdToTgHtml(cleaned);

  // Check if response needs confirmation buttons
  const hasConfirmation = needsConfirmation(cleaned);

  if (html.length <= CHUNK_HARD_LIMIT) {
    const replyOpts = {
      parse_mode: "HTML",
      ...(hasConfirmation ? { reply_markup: confirmKeyboard() } : {}),
    };
    try {
      await ctx.reply(html, replyOpts);
    } catch {
      // Fallback: if HTML parsing fails, send as plain text
      await ctx.reply(cleaned);
    }
  } else {
    const chunks = sendChunked(html);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const markup = (isLast && hasConfirmation)
        ? { reply_markup: confirmKeyboard() }
        : {};
      try {
        await ctx.reply(chunks[i], { parse_mode: "HTML", ...markup });
      } catch {
        await ctx.reply(chunks[i].replace(/<[^>]+>/g, ""), markup);
      }
    }
  }

  // Send media files after text
  for (const item of media) {
    await sendMediaItem(ctx, item);
  }
}

// ─── BOOTSTRAP (6-question wizard on first /start) ─────────────────────────

const bootstrapStep = new Map(); // userId -> step name
const bootstrapData = new Map(); // userId -> { name, sphere, tasks, stack, style, mission }

const BOOTSTRAP_STEPS = {
  ask_name: {
    question: "Как тебя зовут?",
    field: "name",
    next: "ask_sphere",
  },
  ask_sphere: {
    question: "Чем занимаешься? (сфера, бизнес, профессия)",
    field: "sphere",
    next: "ask_tasks",
  },
  ask_tasks: {
    question: "Какие задачи хочешь решать с помощью агента?",
    field: "tasks",
    next: "ask_stack",
  },
  ask_stack: {
    question: "Какие инструменты/технологии используешь?",
    field: "stack",
    next: "ask_style",
  },
  ask_style: {
    question: "Как предпочитаешь общаться? Кратко или подробно? Формально или неформально?",
    field: "style",
    next: "ask_mission",
  },
  ask_mission: {
    question: "Опиши в 1-2 предложениях главную цель работы с агентом",
    field: "mission",
    next: "confirm",
  },
};

async function handleBootstrap(ctx, text) {
  const userId = String(ctx.from.id);
  const step = bootstrapStep.get(userId);
  if (!step) return false;

  const stepConfig = BOOTSTRAP_STEPS[step];

  if (stepConfig) {
    const data = bootstrapData.get(userId) || {};
    data[stepConfig.field] = text;
    bootstrapData.set(userId, data);

    if (stepConfig.next === "confirm") {
      const summary = formatBootstrapSummary(data);
      const kb = new InlineKeyboard()
        .text("\u2714 \u0421\u043e\u0437\u0434\u0430\u044e \u0414\u041d\u041a", "bootstrap_confirm")
        .text("\u2716 \u0417\u0430\u043d\u043e\u0432\u043e", "bootstrap_restart");
      await ctx.reply(summary, { parse_mode: "HTML", reply_markup: kb });
      bootstrapStep.set(userId, "confirm");
    } else {
      bootstrapStep.set(userId, stepConfig.next);
      await ctx.reply(BOOTSTRAP_STEPS[stepConfig.next].question);
    }
    return true;
  }

  if (step === "confirm") {
    await ctx.reply("Нажми кнопку выше: \u2714 или \u2716");
    return true;
  }
  return false;
}

function formatBootstrapSummary(data) {
  return (
    `<b>Проверь данные:</b>\n\n` +
    `<b>Имя:</b> ${data.name}\n` +
    `<b>Сфера:</b> ${data.sphere}\n` +
    `<b>Задачи:</b> ${data.tasks}\n` +
    `<b>Инструменты:</b> ${data.stack}\n` +
    `<b>Стиль общения:</b> ${data.style}\n` +
    `<b>Миссия:</b> ${data.mission}\n\n` +
    `Всё верно? Создаю ДНК?`
  );
}

function writeDNAFiles(data) {
  const today = new Date().toISOString().slice(0, 10);

  // Helper: write only if file doesn't exist (protect existing user data on update)
  const writeIfNew = (filename, content) => {
    const filepath = join(WORKSPACE, filename);
    if (!existsSync(filepath)) {
      writeFileSync(filepath, content);
    }
  };

  writeIfNew("USER.md",
`# Клиент

Имя: ${data.name}
Сфера: ${data.sphere}
Задачи: ${data.tasks}
Инструменты: ${data.stack}
Стиль общения: ${data.style}

# Роль
${data.sphere}

# Задачи для агента
${data.tasks}

# Технический стек
${data.stack}
`);

  writeIfNew("MEMORY.md",
`# Клиент

Имя: ${data.name}
Сфера: ${data.sphere}
Задачи: ${data.tasks}
Инструменты: ${data.stack}
Стиль: ${data.style}
Миссия: ${data.mission}

# Факты

(заполняется по мере общения)

# Предпочтения

- Стиль общения: ${data.style}
`);

  writeIfNew("MISSION.md",
`# Миссия

${data.mission}

# Контекст

Владелец: ${data.name}
Сфера: ${data.sphere}
`);

  writeIfNew("GOALS.md",
`# Цели и задачи

Последнее обновление: ${today}

## Основные задачи
${data.tasks}

## Активные проекты

(заполняется по мере работы)
`);

  writeIfNew("PROJECTS.md",
`# Проекты

Последнее обновление: ${today}

## Активные

(заполняется по мере работы)

## Архив

(завершённые проекты)
`);

  writeIfNew("PREFERENCES.md",
`# Предпочтения

## Стиль общения
${data.style}

## Инструменты
${data.stack}

## Формат ответов
(уточняется по мере работы)
`);

  writeIfNew("LEARNED.md",
`# Что я узнал

(заполняется агентом по мере работы — паттерны, предпочтения, инсайты)
`);

  writeIfNew("SOUL.md",
`# Личность агента

Я — персональный AI-агент ${data.name}.
Моя миссия: ${data.mission}

## Принципы
- Честность важнее вежливости
- Действие важнее описания
- Конкретика важнее полноты
`);
}

// ─── TEXT BATCHING (collect multiple messages before sending) ────────────────

const TEXT_BATCH_DELAY_MS = 1500;
const textBatch = new Map(); // userId -> { texts[], timer, ctx }

function enqueueText(ctx, text) {
  const userId = String(ctx.from.id);
  let batch = textBatch.get(userId);

  if (batch) {
    batch.texts.push(text);
    batch.ctx = ctx;
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => processTextBatch(userId), TEXT_BATCH_DELAY_MS);
    return;
  }

  batch = {
    texts: [text],
    ctx,
    timer: setTimeout(() => processTextBatch(userId), TEXT_BATCH_DELAY_MS),
  };
  textBatch.set(userId, batch);
}

async function processTextBatch(userId) {
  const batch = textBatch.get(userId);
  if (!batch) return;
  textBatch.delete(userId);
  clearTimeout(batch.timer);

  const { ctx, texts } = batch;
  const combined = texts.join("\n\n");

  await handleTextMessage(ctx, combined);
}

// ─── MODEL SELECTION ────────────────────────────────────────────────────────

function getCurrentModel() {
  return state.model || "sonnet";
}

// ─── SETTINGS MENU (AF-compatible) ─────────────────────────────────────────

function settingsKeyboard() {
  const modelEmoji = state.model === "opus" ? "🟣" : state.model === "haiku" ? "🟢" : "🔵";
  const modeEmoji = state.mode === "auto" ? "🤖" : "👤";
  const spent = getTodaySpend();
  const limit = state.dailySpendLimit || 50;

  return new InlineKeyboard()
    .text(`${modelEmoji} Модель: ${state.model || "sonnet"}`, "settings_model").row()
    .text(`${modeEmoji} Режим: ${state.mode || "normal"}`, "settings_mode").row()
    .text(`🔑 Переменные окружения`, "settings_env").row()
    .text(`🕐 Часовой пояс: ${state.timezone || "Europe/Moscow"}`, "settings_tz").row()
    .text(`💰 Лимит: $${limit}/день (потрачено: $${spent.toFixed(2)})`, "settings_spend_limit").row()
    .text(`🔄 Перезагрузка`, "settings_restart").row()
    .text(`🔑 Переподключить Claude`, "settings_reauth_claude").row()
    .text(`✖ Закрыть`, "settings_close");
}

function modelKeyboard() {
  return new InlineKeyboard()
    .text(state.model === "haiku" ? "✅ Haiku" : "Haiku", "model_haiku")
    .text(state.model === "sonnet" ? "✅ Sonnet" : "Sonnet", "model_sonnet")
    .text(state.model === "opus" ? "✅ Opus" : "Opus", "model_opus")
    .row()
    .text("← Назад", "settings_back");
}

function modeKeyboard() {
  return new InlineKeyboard()
    .text(state.mode === "normal" ? "✅ Обычный" : "Обычный", "mode_normal")
    .text(state.mode === "auto" ? "✅ Авто" : "Авто", "mode_auto")
    .row()
    .text("← Назад", "settings_back");
}

const tzList = [
  "UTC", "Europe/Moscow", "Europe/Kiev", "Asia/Almaty",
  "Asia/Vladivostok", "America/New_York", "America/Los_Angeles",
];

function tzKeyboard() {
  const kb = new InlineKeyboard();
  for (const tz of tzList) {
    const label = state.timezone === tz ? `✅ ${tz}` : tz;
    kb.text(label, `tz_${tz}`).row();
  }
  kb.text("← Назад", "settings_back");
  return kb;
}

function spendLimitKeyboard() {
  const limits = [10, 25, 50, 100, 200];
  const kb = new InlineKeyboard();
  for (const l of limits) {
    const label = state.dailySpendLimit === l ? `✅ $${l}` : `$${l}`;
    kb.text(label, `spend_${l}`);
  }
  kb.row().text("← Назад", "settings_back");
  return kb;
}

// ─── TELEGRAM BOT ────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);
bot.api.config.use(autoRetry());

// Env callbacks (модуль secrets-menu.js — только callbacks, не /settings)
registerSecretsHandlers(bot, isOwner);

// Подсказка при первом голосовом без распознавалки (модуль voice-helper.js)
registerVoiceHelpers(bot, isOwner);

// /settings — full settings menu (AF-compatible)
bot.command("settings", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply("⚙️ Настройки", { reply_markup: settingsKeyboard() });
});

// Settings callbacks
bot.callbackQuery("settings_model", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Выбери модель:", { reply_markup: modelKeyboard() });
});

bot.callbackQuery("settings_mode", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "Обычный — Claude спрашивает перед действиями\nАвто — Claude действует самостоятельно",
    { reply_markup: modeKeyboard() }
  );
});

bot.callbackQuery("settings_tz", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Выбери часовой пояс:", { reply_markup: tzKeyboard() });
});

bot.callbackQuery("settings_spend_limit", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Дневной лимит расхода:", { reply_markup: spendLimitKeyboard() });
});

bot.callbackQuery("settings_restart", async (ctx) => {
  await ctx.answerCallbackQuery("Перезагрузка...");
  await ctx.editMessageText("Перезагружаюсь...");
  setTimeout(() => process.exit(0), 500);
});

bot.callbackQuery("settings_close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage();
});

bot.callbackQuery("settings_back", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("⚙️ Настройки", { reply_markup: settingsKeyboard() });
});

bot.callbackQuery("settings_reauth_claude", async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  try { await ctx.deleteMessage(); } catch {}
  await startReauthFlow(ctx);
});

bot.callbackQuery("reauth_claude:cancel", async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery("Отменено");
  const s = reauthSessions.get(String(ctx.from.id));
  if (s) {
    clearTimeout(s.timer);
    reauthSessions.delete(String(ctx.from.id));
  }
  appendReauthLog(`flow cancelled by user ${ctx.from.id}`);
  try {
    await ctx.editMessageText("Отменено. Когда захочешь — /settings → 🔑 Переподключить Claude");
  } catch {
    await ctx.reply("Отменено. Когда захочешь — /settings → 🔑 Переподключить Claude");
  }
});

// Model selection callbacks
bot.callbackQuery(/^model_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const model = ctx.callbackQuery.data.replace("model_", "");
  if (["haiku", "sonnet", "opus"].includes(model)) {
    state.model = model;
    saveState(state);
    await ctx.editMessageText("Выбери модель:", { reply_markup: modelKeyboard() });
  }
});

// Mode selection callbacks
bot.callbackQuery(/^mode_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const mode = ctx.callbackQuery.data.replace("mode_", "");
  if (["normal", "auto"].includes(mode)) {
    state.mode = mode;
    saveState(state);
    await ctx.editMessageText(
      "Обычный — Claude спрашивает перед действиями\nАвто — Claude действует самостоятельно",
      { reply_markup: modeKeyboard() }
    );
  }
});

// Timezone selection callbacks
bot.callbackQuery(/^tz_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tz = ctx.callbackQuery.data.replace("tz_", "");
  state.timezone = tz;
  saveState(state);
  await ctx.editMessageText("Выбери часовой пояс:", { reply_markup: tzKeyboard() });
});

// Spend limit selection callbacks
bot.callbackQuery(/^spend_/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const limit = parseInt(ctx.callbackQuery.data.replace("spend_", ""));
  state.dailySpendLimit = limit;
  saveState(state);
  await ctx.editMessageText("Дневной лимит расхода:", { reply_markup: spendLimitKeyboard() });
});

// /start — with bootstrap trigger
bot.command("start", async (ctx) => {
  // Auto-lock: first user to /start becomes the owner
  if (!_ownerId) {
    saveOwner(ctx);
  }
  if (!isOwner(ctx)) return;

  // If bootstrap not done — start the 6-question wizard
  if (!state.bootstrapDone) {
    bootstrapStep.set(String(ctx.from.id), "ask_name");
    bootstrapData.set(String(ctx.from.id), {});
    await ctx.reply(
      "Привет! Я твой персональный AI-агент.\n\n" +
      "Давай настроим меня под тебя — это займёт 1 минуту (6 вопросов).\n\n" +
      BOOTSTRAP_STEPS.ask_name.question,
      {}
    );
    return;
  }

  await ctx.reply(
    "Привет! Я твой персональный AI-агент.\n\n" +
    "Пиши мне текстом, отправляй голосовые, фото или файлы — я помогу с любыми задачами.\n\n" +
    "Просто пиши мне текстом, отправляй голосовые, фото или файлы.\n\n" +
    "/settings — настройки\n/reset — новая сессия\n/status — статус системы"
  );
});

// Bootstrap callbacks
bot.callbackQuery("bootstrap_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const data = bootstrapData.get(userId);
  if (!data) return;

  try {
    writeDNAFiles(data);
    state.bootstrapDone = true;
    saveState(state);
    bootstrapStep.delete(userId);
    bootstrapData.delete(userId);
    await ctx.reply(
      "✅ ДНК создана! Все 8 файлов записаны.\n\n" +
      "Теперь просто пиши — я готов работать.\n\n" +
      "/settings — настройки"
    );
  } catch (err) {
    console.error("[bootstrap]", err.message);
    await ctx.reply("Ошибка при создании ДНК: " + err.message.slice(0, 200));
  }
});

bot.callbackQuery("bootstrap_restart", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  bootstrapStep.set(userId, "ask_name");
  bootstrapData.set(userId, {});
  await ctx.reply("Начинаем заново.\n\n" + BOOTSTRAP_STEPS.ask_name.question);
});

// /model — redirect to settings (command still works, but not in menu)
bot.command("model", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply("Выбери модель:", { reply_markup: modelKeyboard() });
});

// /reset
bot.command("reset", async (ctx) => {
  if (!isOwner(ctx)) return;
  const userId = String(ctx.from.id);
  sessions.delete(userId);
  saveSessions();
  await ctx.reply("🧹 Сессия сброшена. Начинаем с чистого листа.");
});

// /stop — kill active Claude process
bot.command("stop", async (ctx) => {
  if (!isOwner(ctx)) return;
  if (!_activeChild && !isCliBusy()) {
    await ctx.reply("Нет активной задачи.");
    return;
  }
  if (_activeChild) {
    _activeChild.kill("SIGTERM");
    setTimeout(() => { if (_activeChild) _activeChild.kill("SIGKILL"); }, 3000);
  }
  if (_activeStatus) {
    _activeStatus.stop();
    try {
      await ctx.api.editMessageText(ctx.chat.id, _activeStatus.messageId, "⏹ Задача остановлена.");
    } catch {}
    _activeStatus = null;
  }
  console.warn("[/stop] Task stopped by user");
});

// /status — extended info
bot.command("status", async (ctx) => {
  if (!isOwner(ctx)) return;
  const spent = getTodaySpend();
  const limit = state.dailySpendLimit || 50;
  const spendStatus = checkSpendLimit();
  const spendIcon = spendStatus === "blocked" ? "🔴" : spendStatus === "warning" ? "🟡" : "🟢";

  const status =
    `<b>Agent v${BOT_VERSION}</b>\n\n` +
    `<b>Модель:</b> ${state.model || "sonnet"}\n` +
    `<b>Режим:</b> ${state.mode || "normal"}\n` +
    `<b>Часовой пояс:</b> ${state.timezone || "Europe/Moscow"}\n` +
    `<b>Bootstrap:</b> ${state.bootstrapDone ? "✅" : "⏳"}\n` +
    `<b>Сессия:</b> ${sessions.has(String(ctx.from.id)) ? "активна" : "нет"}\n\n` +
    `${spendIcon} <b>Расход сегодня:</b> $${spent.toFixed(2)} / $${limit}`;

  await ctx.reply(status, { parse_mode: "HTML" });
});

// /update — self-update from GitHub
bot.command("update", async (ctx) => {
  if (!isOwner(ctx)) return;

  const currentVer = (() => {
    try { return readFileSync(join(import.meta.dirname, "VERSION"), "utf8").trim(); }
    catch { return "unknown"; }
  })();

  await ctx.reply(`Проверяю обновления... (текущая версия: ${currentVer})`);

  try {
    // Check remote version
    const remoteVer = await new Promise((resolve, reject) => {
      https.get("https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/bot/VERSION", {
        timeout: 10000,
        headers: { "User-Agent": "AgentBot" },
      }, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        let data = "";
        res.on("data", (d) => data += d);
        res.on("end", () => resolve(data.trim()));
      }).on("error", reject);
    });

    if (remoteVer === currentVer) {
      await ctx.reply(`У тебя последняя версия (${currentVer}).`);
      return;
    }

    await ctx.reply(`Доступна версия ${remoteVer}. Обновляю...`);

    // Run update-bot.sh
    const botDir = import.meta.dirname;
    const updateScript = join(botDir, "update-bot.sh");

    // If update-bot.sh doesn't exist yet, download it first
    if (!existsSync(updateScript)) {
      execSync(
        `curl -fsSL "https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/bot/update-bot.sh" -o "${updateScript}" && chmod +x "${updateScript}"`,
        { timeout: 15000 }
      );
    }

    // Run the update script (it will restart the bot via systemd)
    const result = execSync(`bash "${updateScript}" 2>&1`, {
      timeout: 120000,
      cwd: botDir,
    }).toString();

    // If we get here, the bot hasn't restarted yet (no systemd)
    const lines = result.split("\n").filter(l => l.includes("===") || l.includes("ERROR") || l.includes("WARN"));
    await ctx.reply(lines.join("\n") || "Обновление завершено. Бот перезапустится.");

  } catch (err) {
    console.error("[update]", err.message);
    await ctx.reply(
      `Ошибка обновления: ${err.message.slice(0, 200)}\n\nПопробуй вручную:\nbash update-bot.sh`,
      {}
    );
  }
});

// /version
bot.command("version", async (ctx) => {
  if (!isOwner(ctx)) return;
  const ver = (() => {
    try { return readFileSync(join(import.meta.dirname, "VERSION"), "utf8").trim(); }
    catch { return "unknown"; }
  })();
  await ctx.reply(`Agent Bot v${ver}`);
});

// ─── CONFIRMATION CALLBACKS ─────────────────────────────────────────────────

bot.callbackQuery("confirm_continue", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = String(ctx.from.id);
  const sessionId = sessions.get(userId) || null;

  const thinkingMsg = await ctx.reply(formatThinkingPhrase(0, 0));
  const status = new StatusMessage(ctx, thinkingMsg.message_id);
  _activeStatus = status;
  status.start();

  try {
    const result = await callClaude("✔ Продолжай выполнение.", sessionId);
    if (result.sessionId) {
      sessions.set(userId, result.sessionId);
      saveSessions();
    }
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await sendResponse(ctx, result.text);
  } catch (err) {
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    const friendly = humanizeError(err.message);
    await ctx.reply(friendly || "Ошибка. Попробуй ещё раз.");
  }
});

bot.callbackQuery("confirm_stop", async (ctx) => {
  await ctx.answerCallbackQuery("Остановлено");
  await ctx.reply("Остановлено. Что делаем дальше?");
});

// Handle photos (single or media group)
bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // largest size
  await enqueueMedia(ctx, {
    kind: "photo",
    fileId: photo.file_id,
    ext: ".jpg",
    caption: ctx.message.caption || null,
  });
});

// Handle documents (PDF, DOCX, etc.)
bot.on("message:document", async (ctx) => {
  if (!isOwner(ctx)) return;
  const doc = ctx.message.document;
  const ext = doc.file_name ? "." + doc.file_name.split(".").pop() : ".bin";
  await enqueueMedia(ctx, {
    kind: "document",
    fileId: doc.file_id,
    ext,
    fileName: doc.file_name,
    caption: ctx.message.caption || null,
  });
});

// Handle video
bot.on("message:video", async (ctx) => {
  if (!isOwner(ctx)) return;
  await enqueueMedia(ctx, {
    kind: "video",
    fileId: ctx.message.video.file_id,
    ext: ".mp4",
    caption: ctx.message.caption || null,
  });
});

// ─── VS CODE TUNNEL (/connect) ────────────────────────────────────────────────
// Портировано из agent-factory@3c47c37 (v4.6).
// Архитектура root-делегата через path-юниты:
//   бот пишет flag ~/.agent/.tunnel-{start,stop} (без sudo)
//   → tunnel-{ctl,stop}.path (watcher) триггерит tunnel-{ctl,stop}.service от root
//   → systemctl start/stop agent-tunnel.service
// systemd-юниты ставит templates/vscode-tunnel/install-vscode-tunnel.sh.

const TUNNEL_SERVICE = "agent-tunnel";
const TUNNEL_STATE_DIR = join(AGENT_HOME, ".vscode-tunnel");
const TUNNEL_TOKEN_FILE = join(TUNNEL_STATE_DIR, "token.json");
const TUNNEL_LOCK_FILE = join(TUNNEL_STATE_DIR, "tunnel-stable.lock");
const TUNNEL_START_FLAG = join(DATA_DIR, ".tunnel-start");
const TUNNEL_STOP_FLAG = join(DATA_DIR, ".tunnel-stop");
const CODE_BIN = "/usr/local/bin/code";

// chatId → { proc, cancelled } для активного OAuth-флоу (даёт отмену через кнопку)
const connectProcs = new Map();

// ─── REAUTH CLAUDE (/reauth) ─────────────────────────────────────────────────
// Константы для команды /reauth — переподключение Claude через PKCE OAuth.
// Портировано из agent-factory@03a493a (v4.7).

const ENV_FILE = join(DATA_DIR, ".env");
const REAUTH_LOG_FILE = join(DATA_DIR, ".reauth.log");
const REAUTH_NOTIFY_FILE = join(DATA_DIR, ".reauth-pending-notify.json");
const CREDENTIALS_FILE = join(AGENT_HOME, ".claude", ".credentials.json");
const STEP5_AUTHORIZE_IMG = join(import.meta.dirname, "images", "step5_claude_authorize.png");
const STEP5_ERROR_IMG = join(import.meta.dirname, "images", "step5_browser_error.png");
const REAUTH_TIMEOUT_MS = 10 * 60 * 1000;

// userId → { codeVerifier, state, timer } для активного PKCE-флоу (живёт 10 мин)
const reauthSessions = new Map();

// Лог reauth-событий БЕЗ значений токенов — только факты (started, exchanged, failed)
function appendReauthLog(line) {
  try {
    const ts = new Date().toISOString();
    appendFileSync(REAUTH_LOG_FILE, `[${ts}] ${line}\n`);
  } catch {}
}

// Шаг 1 reauth: генерим PKCE, шлём 2 скриншота + кнопку «Авторизоваться»
async function startReauthFlow(ctx) {
  const userId = String(ctx.from.id);
  const prev = reauthSessions.get(userId);
  if (prev) clearTimeout(prev.timer);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const stateValue = generateState();
  const authUrl = buildAuthUrl(codeChallenge, stateValue);

  const timer = setTimeout(() => {
    if (reauthSessions.has(userId)) {
      reauthSessions.delete(userId);
      appendReauthLog(`flow timed out for user ${userId}`);
      bot.api.sendMessage(
        ctx.chat.id,
        "⌛ Время на авторизацию истекло (10 минут). Начни заново через /settings → 🔑 Переподключить Claude"
      ).catch(() => {});
    }
  }, REAUTH_TIMEOUT_MS);

  reauthSessions.set(userId, { codeVerifier, state: stateValue, timer });
  appendReauthLog(`flow started for user ${userId}`);

  try {
    if (existsSync(STEP5_AUTHORIZE_IMG)) {
      await ctx.replyWithPhoto(new InputFile(STEP5_AUTHORIZE_IMG), {
        caption: "Шаг 1: откроется страница Claude — войди в аккаунт и нажми <b>Authorize</b>",
        parse_mode: "HTML",
      });
    }
    if (existsSync(STEP5_ERROR_IMG)) {
      await ctx.replyWithPhoto(new InputFile(STEP5_ERROR_IMG), {
        caption: "Шаг 2: в браузере появится <b>ошибка</b> — это нормально. Скопируй ВЕСЬ адрес из адресной строки и пришли сюда сообщением.",
        parse_mode: "HTML",
      });
    }
  } catch (e) {
    console.warn("[reauth] photo send failed:", e.message);
  }

  const kb = new InlineKeyboard()
    .url("🔗 Авторизоваться в Claude", authUrl)
    .row()
    .text("✖ Отменить", "reauth_claude:cancel");

  await ctx.reply(
    "<b>🔑 Переподключение Claude</b>\n\n" +
      "1) Нажми «Авторизоваться в Claude» ниже\n" +
      "2) Войди в аккаунт Claude → нажми «Authorize»\n" +
      "3) В браузере появится ошибка (это норма) — скопируй ВЕСЬ адрес и пришли сюда сообщением\n\n" +
      "У тебя 10 минут. Передумал — жми «Отменить».",
    { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }
  );
}

// Шаг 2 reauth: парсим URL, обмениваем code → token, пишем .env, рестартим бота.
// Возвращает true если сообщение было обработано как reauth-URL (тогда не передаём в Claude).
async function completeReauthFlow(ctx, text) {
  const userId = String(ctx.from.id);
  const session = reauthSessions.get(userId);
  if (!session) return false;

  const m = text.match(/[?&]code=([^&\s]+)/);
  if (!m) {
    await ctx.reply(
      "Не вижу <code>code=</code> в сообщении. Пришли ВЕСЬ адрес из адресной строки браузера (он начинается с <code>http://localhost:16424/callback?code=…</code>).",
      { parse_mode: "HTML" }
    );
    return true;
  }

  const authCode = decodeURIComponent(m[1]);
  appendReauthLog(`code received from user ${userId} (${authCode.slice(0, 10)}...)`);

  await ctx.reply("⏳ Обмениваю код на токен (до 30 секунд)...");

  let tokenData;
  try {
    tokenData = await exchangeCodeForToken(authCode, session.codeVerifier, session.state);
  } catch (e) {
    appendReauthLog(`exchange FAILED for user ${userId}: ${e.message}`);
    await ctx.reply(
      `❌ Ошибка обмена: ${e.message}\n\nПопробуй ещё раз через /settings → 🔑 Переподключить Claude — нужен <b>новый</b> URL, старый одноразовый.`,
      { parse_mode: "HTML" }
    );
    clearTimeout(session.timer);
    reauthSessions.delete(userId);
    return true;
  }

  // Бэкап credentials.json (best-effort)
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      const backup = `${CREDENTIALS_FILE}.bak.${Date.now()}`;
      writeFileSync(backup, readFileSync(CREDENTIALS_FILE), { mode: 0o600 });
      appendReauthLog(`backup credentials → ${basename(backup)}`);
    }
  } catch (e) {
    console.warn("[reauth] backup failed:", e.message);
  }

  // Запись refresh+scopes в .env, удаление старого TOKEN
  try {
    safeEnvRemove(ENV_FILE, "CLAUDE_CODE_OAUTH_TOKEN");
    safeEnvWrite(ENV_FILE, "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", tokenData.refresh_token);
    safeEnvWrite(ENV_FILE, "CLAUDE_CODE_OAUTH_SCOPES", OAUTH_SCOPES);
    appendReauthLog(`env updated (refresh+scopes), old TOKEN removed`);
  } catch (e) {
    appendReauthLog(`env write FAILED: ${e.message}`);
    await ctx.reply(`❌ Не смог записать в .env: ${e.message}`);
    clearTimeout(session.timer);
    reauthSessions.delete(userId);
    return true;
  }

  // Регистрация токена в Claude CLI (best-effort — на рестарте auth-check должен дотянуть)
  await ctx.reply("🔧 Регистрирую токен в Claude CLI...");
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("claude", ["auth", "login"], {
        env: {
          ...process.env,
          HOME: AGENT_HOME,
          NODE_OPTIONS: "--dns-result-order=ipv4first",
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: tokenData.refresh_token,
          CLAUDE_CODE_OAUTH_SCOPES: OAUTH_SCOPES,
        },
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`exit code ${code}: ${stderr.slice(0, 200)}`));
      });
      child.on("error", reject);
    });
    appendReauthLog(`claude auth login OK`);
  } catch (e) {
    appendReauthLog(`claude auth login FAILED: ${e.message}`);
    await ctx.reply(
      `⚠️ Токен записан в .env, но <code>claude auth login</code> не отработал: ${e.message}\n\nЯ всё равно перезапущусь — авто-recovery на boot должен дотянуть.`,
      { parse_mode: "HTML" }
    );
  }

  clearTimeout(session.timer);
  reauthSessions.delete(userId);

  // Pending-notify marker: после рестарта пришлю "Готов к работе"
  try {
    writeFileSync(
      REAUTH_NOTIFY_FILE,
      JSON.stringify({ chatId: ctx.chat.id, ts: Date.now() }),
      { mode: 0o600 }
    );
  } catch (e) {
    appendReauthLog(`notify-marker write failed: ${e.message}`);
  }

  await ctx.reply("✅ Готово! Перезагружаюсь — через 10 секунд скажу что готов.");
  appendReauthLog(`flow completed for user ${userId}, exiting for systemd restart`);
  setTimeout(() => process.exit(0), 1500);
  return true;
}

// agent-XXXXXXXX — первые 8 hex от md5(hostname).
// Привязано к серверу, не к ученику — совпадает с тем что setup-server.sh
// поставил в systemd-юнит (agent-tunnel.service). Бот и установщик считают
// имя одинаково, без необходимости знать OWNER_ID на этапе установки.
function vscodeTunnelName() {
  const hex = createHash("md5").update(hostname()).digest("hex").slice(0, 8);
  return `agent-${hex}`;
}

// "23 июн., 09:31 UTC (~5ч 12м назад)"
function formatTunnelTimeAgo(iso) {
  try {
    const dt = new Date(iso);
    const dateStr = dt.toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
    const timeStr = dt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    const diffMs = Date.now() - dt.getTime();
    const totalMin = Math.max(0, Math.floor(diffMs / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    const ago = h > 0 ? `~${h}ч ${m}м назад` : `~${m}м назад`;
    return `${dateStr}, ${timeStr} UTC (${ago})`;
  } catch {
    return iso;
  }
}

// systemctl is-active --quiet через exec (без блокировки event loop)
function isTunnelServiceActive() {
  return new Promise((resolve) => {
    execFile("systemctl", ["is-active", "--quiet", TUNNEL_SERVICE], (err) => resolve(!err));
  });
}

bot.command("connect", async (ctx) => {
  if (!isOwner(ctx)) return;
  const chatId = ctx.chat.id;
  const tunnelName = vscodeTunnelName();

  // === ПУТЬ A: уже подключён (по state) ===
  if (state.tunnelReady) {
    const active = await isTunnelServiceActive();
    if (active) {
      if (!existsSync(TUNNEL_TOKEN_FILE)) {
        // Сервис жив, но GitHub-токен пропал — переподключаем
        state.tunnelReady = false;
        state.tunnelConnectedAt = undefined;
        saveState(state);
        await ctx.reply("🔄 Туннель работает, но авторизация слетела. Переподключаю...");
        // fall through к OAuth
      } else {
        const since = state.tunnelConnectedAt ? `\nПодключён: ${formatTunnelTimeAgo(state.tunnelConnectedAt)}` : "";
        const url = `https://vscode.dev/tunnel/${tunnelName}`;
        const kb = new InlineKeyboard().text("⏹ Отключить", "connect:disconnect");
        await ctx.reply(
          `✔ <b>VS Code подключён</b>\n\n` +
          `Имя туннеля: <code>${tunnelName}</code>${since}\n\n` +
          `🔗 <a href="${url}">Открыть в браузере</a>\n\n` +
          `Или в VS Code: Cmd+Shift+P → Remote-Tunnels: Connect to Tunnel → <code>${tunnelName}</code>`,
          { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }
        );
        return;
      }
    } else {
      // state говорит ready, но сервис не активен → сбрасываем и переподключаем
      state.tunnelReady = false;
      state.tunnelConnectedAt = undefined;
      saveState(state);
      await ctx.reply(
        "🔄 Туннель отключился — нужна повторная авторизация GitHub.\n" +
        "Это нормально — токен действует ~24 часа.\n\nПереподключаю..."
      );
    }
  }

  // === ПУТЬ B: подключаемся через OAuth ===
  // Отменяем предыдущий висящий процесс если был
  const prev = connectProcs.get(chatId);
  if (prev) {
    prev.cancelled = true;
    try { prev.proc.kill(); } catch {}
    connectProcs.delete(chatId);
  }

  // Проверка что бинарь code установлен
  if (!existsSync(CODE_BIN)) {
    await ctx.reply(
      "⚠️ VS Code CLI не установлен на сервере.\n\n" +
      "Похоже что setup-server.sh пропустил установку туннеля (нет интернета или GitHub был недоступен).\n\n" +
      "Перезапусти установку:\n" +
      "<code>curl -sL https://raw.githubusercontent.com/Ntmib/jarvis-architect/main/setup-server.sh | bash</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  await ctx.reply("🔌 Запускаю VS Code подключение...");

  // IIFE чтобы команда вернулась сразу, OAuth идёт в фоне
  (async () => {
    let stepMsgId;
    try {
      // Pre-cleanup: если сервис активен но токена нет — корректно остановить
      try {
        const wasActive = await isTunnelServiceActive();
        if (wasActive && !existsSync(TUNNEL_TOKEN_FILE)) {
          writeFileSync(TUNNEL_STOP_FLAG, "");
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            if (!(await isTunnelServiceActive())) break;
          }
        }
        try { unlinkSync(TUNNEL_START_FLAG); } catch {}
        try { unlinkSync(TUNNEL_LOCK_FILE); } catch {}
      } catch {}

      // === OAUTH: spawn code tunnel user login --provider github ===
      const deviceCode = await new Promise((resolve, reject) => {
        const proc = spawn(CODE_BIN, ["tunnel", "user", "login", "--provider", "github"], {
          env: {
            ...process.env,
            HOME: AGENT_HOME,
            VSCODE_CLI_DATA_DIR: TUNNEL_STATE_DIR,
          },
        });
        let buf = "";
        const onData = (chunk) => {
          buf += chunk.toString();
          const urlMatch = buf.match(/https:\/\/github\.com\/login\/device/);
          const codeMatch = buf.match(/code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i);
          if (urlMatch && codeMatch) {
            resolve({ url: "https://github.com/login/device", code: codeMatch[1], proc });
          }
        };
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", onData);
        proc.on("error", reject);
        setTimeout(() => reject(new Error("Timeout: device code не получен за 30 сек")), 30000);
      });

      const entry = { proc: deviceCode.proc, cancelled: false };
      connectProcs.set(chatId, entry);

      const kbCancel = new InlineKeyboard().text("🚫 Отменить", `connect:cancel:${chatId}`);
      const stepMsg = await bot.api.sendMessage(
        chatId,
        `📱 <b>Шаг 1 из 2 — GitHub авторизация</b>\n\n` +
        `1. Открой в браузере: <a href="${deviceCode.url}">${deviceCode.url}</a>\n` +
        `2. Введи код: <code>${deviceCode.code}</code>\n\n` +
        `⏳ Жду подтверждения (до 2 минут)...`,
        { parse_mode: "HTML", reply_markup: kbCancel, link_preview_options: { is_disabled: true } }
      );
      stepMsgId = stepMsg.message_id;

      // Ждём exit 0 = юзер успешно авторизовался
      await new Promise((resolve, reject) => {
        deviceCode.proc.on("close", (code) => {
          if (entry.cancelled) reject(new Error("cancelled"));
          else if (code === 0) resolve();
          else reject(new Error(`code tunnel exited with code ${code}`));
        });
        setTimeout(() => {
          try { deviceCode.proc.kill(); } catch {}
          reject(new Error("Timeout: авторизация не выполнена за 2 минуты"));
        }, 120000);
      });

      connectProcs.delete(chatId);
      if (stepMsgId) try { await bot.api.deleteMessage(chatId, stepMsgId); } catch {}

      // === ЗАПУСК сервиса через path-юнит ===
      writeFileSync(TUNNEL_START_FLAG, "");
      await new Promise((r) => setTimeout(r, 6000));

      if (!(await isTunnelServiceActive())) {
        throw new Error("agent-tunnel.service не запустился. Попробуй /connect ещё раз.");
      }

      // === УСПЕХ ===
      const nowIso = new Date().toISOString();
      state.tunnelReady = true;
      state.tunnelConnectedAt = nowIso;
      saveState(state);

      const url = `https://vscode.dev/tunnel/${tunnelName}`;
      const kbDisconnect = new InlineKeyboard().text("⏹ Отключить", "connect:disconnect");
      await bot.api.sendMessage(
        chatId,
        `✔ <b>VS Code подключение готово!</b>\n\n` +
        `Имя туннеля: <code>${tunnelName}</code>\n` +
        `Подключён: ${formatTunnelTimeAgo(nowIso)}\n\n` +
        `🔗 <a href="${url}">Открыть в браузере</a>\n\n` +
        `Или в VS Code на компьютере:\n` +
        `Cmd+Shift+P → "Remote-Tunnels: Connect to Tunnel" → <code>${tunnelName}</code>`,
        { parse_mode: "HTML", reply_markup: kbDisconnect, link_preview_options: { is_disabled: true } }
      );
    } catch (err) {
      connectProcs.delete(chatId);
      if (err.message === "cancelled") return;
      if (stepMsgId) try { await bot.api.deleteMessage(chatId, stepMsgId); } catch {}
      await bot.api.sendMessage(chatId, `❌ Ошибка: ${err.message}\n\nПопробуй снова /connect`);
    }
  })();
});

// /reauth — запуск flow переподключения Claude.
// Регистрируется ДО bot.on("message:text") иначе message:text перехватит
// сообщение первым и оборвёт цепочку (классическая Grammy-ловушка).
bot.command("reauth", async (ctx) => {
  if (!isOwner(ctx)) return;
  await startReauthFlow(ctx);
});

bot.callbackQuery(/^connect:cancel:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery("⛔");
  const chatId = parseInt(ctx.match[1]);
  const entry = connectProcs.get(chatId);
  if (entry) {
    entry.cancelled = true;
    try { entry.proc.kill(); } catch {}
    connectProcs.delete(chatId);
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("🚫 Подключение отменено.");
});

bot.callbackQuery("connect:disconnect", async (ctx) => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery("⛔");
  await ctx.answerCallbackQuery();
  try {
    writeFileSync(TUNNEL_STOP_FLAG, "");
    state.tunnelReady = false;
    state.tunnelConnectedAt = undefined;
    saveState(state);
    await new Promise((r) => setTimeout(r, 2000));
    await ctx.editMessageText("⏹ VS Code туннель отключён.\n\nДля повторного подключения: /connect");
  } catch (err) {
    await ctx.editMessageText(`❌ Ошибка при отключении: ${err.message}`);
  }
});

// Handle text messages
bot.on("message:text", async (ctx) => {
  if (!isOwner(ctx)) return;

  const text = ctx.message.text;

  // Reauth flow: highest priority — юзер вставляет URL с ?code=...
  if (reauthSessions.has(String(ctx.from.id))) {
    const handled = await completeReauthFlow(ctx, text);
    if (handled) return;
  }

  // Если ждём ввод секрета — обработать и не передавать в Claude
  if (await handlePendingInput(ctx)) return;

  // Bootstrap intercept — if wizard is active, handle answers
  if (await handleBootstrap(ctx, text)) return;

  // Text batching — collect rapid messages (1.5s window)
  enqueueText(ctx, text);
});

// Core text handler (called from batch processor or directly)
async function handleTextMessage(ctx, text) {
  const userId = String(ctx.from.id);

  const thinkingMsg = await ctx.reply(formatThinkingPhrase(0, 0));
  const status = new StatusMessage(ctx, thinkingMsg.message_id);
  _activeStatus = status;
  status.start();

  try {
    // Pre-fetch URLs in message (including Google Docs/Sheets)
    const urlContext = await prefetchUrls(text);
    const enrichedPrompt = urlContext ? text + urlContext : text;

    const sessionId = sessions.get(userId) || null;
    let result = await callClaude(enrichedPrompt, sessionId);

    if (result.sessionId) {
      sessions.set(userId, result.sessionId);
      saveSessions();
    }

    // Auto-continue: if response looks truncated, send continuation
    let autoContinues = 0;
    while (autoContinues < 3 && isResponseTruncated(result.text)) {
      autoContinues++;
      console.log(`[auto-continue] Attempt ${autoContinues} for session ${result.sessionId}`);
      const contResult = await callClaude("Продолжай.", result.sessionId);
      if (contResult.sessionId) {
        sessions.set(userId, contResult.sessionId);
        saveSessions();
      }
      result.text += "\n\n" + contResult.text;
      result.sessionId = contResult.sessionId || result.sessionId;
    }

    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await sendResponse(ctx, result.text);
  } catch (err) {
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    console.error("[error]", err.message);

    // Check for rate limit
    const match = err.message.match(/retry.after.*?(\d+)/i);
    if (match) setGlobalRateLimit(parseInt(match[1]));

    const friendly = humanizeError(err.message);
    await ctx.reply(friendly || "Произошла ошибка. Попробуй ещё раз или нажми 🔄 Новый диалог.");
  }
}

// Auto-continue detection: response looks cut off mid-sentence
function isResponseTruncated(text) {
  if (!text || text.length < 200) return false;
  const trimmed = text.trimEnd();
  // Ends mid-word, mid-code-block, or with ellipsis-like patterns
  if (trimmed.match(/```[^`]*$/)) return true; // unclosed code block
  const lastChar = trimmed[trimmed.length - 1];
  // Normal endings
  if (".!?)>\"':;".includes(lastChar)) return false;
  // Ends with a letter/digit mid-sentence — likely truncated
  if (/[\w\u0400-\u04FF]$/.test(trimmed)) return true;
  return false;
}

// Handle voice messages
bot.on("message:voice", async (ctx) => {
  if (!isOwner(ctx)) return;

  const thinkingMsg = await ctx.reply("Слушаю голосовое… 🎤");
  const status = new StatusMessage(ctx, thinkingMsg.message_id);
  _activeStatus = status;
  status.start();

  try {
    const file = await ctx.getFile();
    const tmpPath = `/tmp/voice_${ctx.from.id}_${Date.now()}.ogg`;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    await downloadTgFile(fileUrl, tmpPath);

    const transcript = await transcribeVoice(tmpPath);
    try { unlinkSync(tmpPath); } catch {}

    if (!transcript) {
      status.stop();
      _activeStatus = null;
      await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});

      if (!hasAnyTranscriber()) {
        return ctx.reply(VOICE_FALLBACK_PROMPT, {
          parse_mode: "HTML",
          reply_markup: voiceFallbackKeyboard(),
        });
      }

      return ctx.reply(
        "Не получилось распознать на этот раз. Попробуй ещё раз или отправь текстом.",
        {}
      );
    }

    await ctx.api.editMessageText(ctx.chat.id, thinkingMsg.message_id,
      `Распознано: "${transcript.slice(0, 100)}${transcript.length > 100 ? "..." : ""}"\n\n${formatThinkingPhrase(1, 0)}`);

    const userId = String(ctx.from.id);
    const sessionId = sessions.get(userId) || null;
    const result = await callClaude(transcript, sessionId);

    if (result.sessionId) {
      sessions.set(userId, result.sessionId);
      saveSessions();
    }

    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await sendResponse(ctx, result.text);
  } catch (err) {
    status.stop();
    _activeStatus = null;
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    console.error("[voice-error]", err.message);
    const friendly = humanizeError(err.message);
    await ctx.reply(friendly || "Ошибка обработки голосового. Попробуй текстом.");
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error("[bot-error]", err.message);
  // Detect rate limit from bot framework
  const match = String(err.message).match(/retry.after.*?(\d+)/i);
  if (match) setGlobalRateLimit(parseInt(match[1]));
});

bot.start({
  onStart: async () => {
    await bot.api.setMyCommands([
      { command: "start", description: "Меню" },
      { command: "stop", description: "Остановить задачу" },
      { command: "reset", description: "Новая сессия" },
      { command: "settings", description: "Настройки" },
      { command: "status", description: "Статус системы" },
      { command: "connect", description: "🔌 VS Code через туннель" },
      { command: "reauth", description: "🔑 Переподключить Claude" },
    ]);

    // Initialize optional modules
    await initSemanticMemory();
    startScheduler();

    // Reauth notify: если только что прошёл reauth-flow — сообщить юзеру что готов.
    // Маркер пишется в completeReauthFlow перед process.exit(0); systemd рестартит.
    try {
      if (existsSync(REAUTH_NOTIFY_FILE)) {
        const data = JSON.parse(readFileSync(REAUTH_NOTIFY_FILE, "utf8"));
        const age = Date.now() - (data.ts || 0);
        if (age < 5 * 60 * 1000 && data.chatId) {
          await bot.api.sendMessage(
            data.chatId,
            "✅ Готов к работе! Можешь писать обычным сообщением."
          );
          appendReauthLog(`notify sent to chat ${data.chatId} (age ${age}ms)`);
        } else {
          appendReauthLog(`notify-marker stale (age ${age}ms) — discarded`);
        }
        unlinkSync(REAUTH_NOTIFY_FILE);
      }
    } catch (e) {
      console.warn("[reauth-notify] error:", e.message);
      try { unlinkSync(REAUTH_NOTIFY_FILE); } catch {}
    }

    console.log(`Agent bot v${BOT_VERSION} started (workspace: ${WORKSPACE}, projects: ${PROJECTS})`);
    console.log(`Model: ${getCurrentModel()}, Bootstrap: ${state.bootstrapDone ? "done" : "pending"}`);
    if (_ownerId) console.log(`Owner: ${_ownerId} (only owner can use bot)`);
    else console.log("No owner yet — first /start will auto-lock");
  },
  drop_pending_updates: true,
});
