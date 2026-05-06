/**
 * Agent Bot — Telegram bot powered by Claude Code CLI
 * Part of jarvis-architect: personal AI agent for course students
 *
 * Features: text + voice + photos + documents + media groups → Claude Code → response
 *           sessions, DNA files, persistent keyboard, folder structure awareness
 */

import { Bot, Keyboard } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import https from "node:https";
import http from "node:http";

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID || null; // Telegram ID владельца (если задан — бот отвечает только ему)
const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
const WORKSPACE = join(AGENT_HOME, "workspace");
const PROJECTS = join(AGENT_HOME, "projects");
const DATA_DIR = join(AGENT_HOME, ".agent");
const MEDIA_DIR = join(WORKSPACE, ".media");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

// Ensure directories exist
for (const dir of [DATA_DIR, join(WORKSPACE, "memory"), join(WORKSPACE, "knowledge"), PROJECTS, MEDIA_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── OWNER CHECK ────────────────────────────────────────────────────────────

function isOwner(ctx) {
  if (!OWNER_ID) return true; // Если OWNER_ID не задан — бот открыт для всех
  return String(ctx.from?.id) === String(OWNER_ID);
}

// ─── PERSISTENT KEYBOARD ────────────────────────────────────────────────────

const mainKeyboard = new Keyboard()
  .text("📋 Статус").text("🔄 Новый диалог").row()
  .text("📁 Проекты").text("🧠 Память").row()
  .resized()
  .persistent();

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

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────

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
|   |-- .media/                 <- медиафайлы от пользователя (фото, документы)
|   |-- memory/                 <- дневники по дням (YYYY-MM-DD.md)
|   +-- knowledge/              <- база знаний (справочники, инструкции)
|-- projects/                   <- папка для ПРОЕКТОВ
+-- .agent/                     <- служебная папка бота (не трогай)

ВАЖНО:
- Новые проекты ВСЕГДА создавай в /home/agent/projects/название-проекта/, НЕ в workspace/
- Workspace — только для DNA-файлов и памяти
- Скиллы лежат в /home/agent/.claude/skills/ — если пользователь просит установить скилл, клади туда
- Настройки Claude Code (settings.json) — в /home/agent/.claude/
- Медиафайлы от пользователя сохраняются в workspace/.media/ — используй Read для их чтения
`;

function buildSystemPrompt() {
  const parts = [ARCHITECTURE_CONTEXT];

  // DNA files — read each if exists
  const dnaFiles = ["SOUL.md", "MEMORY.md", "GOALS.md", "CLAUDE.md"];
  for (const name of dnaFiles) {
    const path = join(WORKSPACE, name);
    if (existsSync(path)) {
      try {
        parts.push(`--- ${name} ---\n${readFileSync(path, "utf8")}`);
      } catch {}
    }
  }

  // Today's diary
  const today = new Date().toISOString().split("T")[0];
  const diaryPath = join(WORKSPACE, "memory", `${today}.md`);
  if (existsSync(diaryPath)) {
    try {
      parts.push(`--- Дневник ${today} ---\n${readFileSync(diaryPath, "utf8")}`);
    } catch {}
  }

  return parts.join("\n\n");
}

// ─── CLAUDE CODE CLI ─────────────────────────────────────────────────────────

// Sequential queue — only one Claude call at a time
let _queue = Promise.resolve();

function callClaude(prompt, sessionId) {
  const p = _queue.then(() => _callClaudeInner(prompt, sessionId));
  _queue = p.catch(() => {});
  return p;
}

function _callClaudeInner(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--max-turns", "15",
      "--model", "sonnet",
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
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));

    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        return reject(new Error(`Claude exit ${code}: ${stderr.slice(0, 300)}`));
      }
      try {
        const result = JSON.parse(stdout);
        resolve({
          text: result.result || result.text || "(пустой ответ)",
          sessionId: result.session_id || sessionId,
          cost: result.cost_usd || 0,
        });
      } catch {
        const text = stdout.trim();
        resolve({ text: text || "(пустой ответ)", sessionId, cost: 0 });
      }
    });

    child.on("error", reject);
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

  // Move to persistent .media/ directory
  const destPath = join(MEDIA_DIR, `${Date.now()}_${fileId.slice(-8)}${ext}`);
  renameSync(tmpPath, destPath);
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

  try {
    await ctx.api.editMessageText(chatId, statusMsgId, "Думаю... ⏳");
  } catch {}

  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(chatId, "typing").catch(() => {});
  }, 4000);

  try {
    const sessionId = sessions.get(userId) || null;
    const result = await callClaude(prompt, sessionId);

    if (result.sessionId) {
      sessions.set(userId, result.sessionId);
      saveSessions();
    }

    clearInterval(typingInterval);
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    await sendResponse(ctx, result.text);
  } catch (err) {
    clearInterval(typingInterval);
    await ctx.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.error("[media-error]", err.message);
    await ctx.reply("Ошибка обработки медиа. Попробуй ещё раз или нажми 🔄 Новый диалог.", { reply_markup: mainKeyboard });
  }
}

// ─── VOICE HANDLING ──────────────────────────────────────────────────────────

async function transcribeVoice(filePath) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return null;

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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getStatusText() {
  const dnaFiles = ["SOUL.md", "MEMORY.md", "GOALS.md", "CLAUDE.md"];
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

  const today = new Date().toISOString().split("T")[0];
  const hasDiary = existsSync(join(WORKSPACE, "memory", `${today}.md`));

  return (
    `📋 Статус агента\n\n` +
    `DNA-файлы: ${found.length}/4 (${found.join(", ")})\n` +
    `${missing.length > 0 ? `Не найдены: ${missing.join(", ")}\n` : ""}` +
    `Дневник сегодня: ${hasDiary ? "есть" : "нет"}\n` +
    `Медиафайлов: ${mediaCount}\n` +
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
      .filter((f) => f.endsWith(".md"))
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

async function sendResponse(ctx, text) {
  if (text.length <= 4096) {
    await ctx.reply(text, { reply_markup: mainKeyboard });
  } else {
    const chunks = [];
    for (let i = 0; i < text.length; i += 4096) {
      chunks.push(text.slice(i, i + 4096));
    }
    for (let i = 0; i < chunks.length; i++) {
      const markup = i === chunks.length - 1 ? { reply_markup: mainKeyboard } : {};
      await ctx.reply(chunks[i], markup);
    }
  }
}

// ─── TELEGRAM BOT ────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);
bot.api.config.use(autoRetry());

// /start
bot.command("start", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply(
    "Привет! Я твой персональный AI-агент.\n\n" +
    "Пиши мне текстом, отправляй голосовые, фото или файлы — я помогу с любыми задачами.\n\n" +
    "Используй кнопки внизу или просто пиши.",
    { reply_markup: mainKeyboard }
  );
});

// /reset
bot.command("reset", async (ctx) => {
  if (!isOwner(ctx)) return;
  const userId = String(ctx.from.id);
  sessions.delete(userId);
  saveSessions();
  await ctx.reply("Сессия сброшена. Начинаем с чистого листа.", { reply_markup: mainKeyboard });
});

// /status
bot.command("status", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply(getStatusText(), { reply_markup: mainKeyboard });
});

// Button handlers
bot.hears("📋 Статус", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply(getStatusText(), { reply_markup: mainKeyboard });
});

bot.hears("🔄 Новый диалог", async (ctx) => {
  if (!isOwner(ctx)) return;
  const userId = String(ctx.from.id);
  sessions.delete(userId);
  saveSessions();
  await ctx.reply("Сессия сброшена. Начинаем с чистого листа.", { reply_markup: mainKeyboard });
});

bot.hears("📁 Проекты", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply(getProjectsText(), { reply_markup: mainKeyboard });
});

bot.hears("🧠 Память", async (ctx) => {
  if (!isOwner(ctx)) return;
  await ctx.reply(getMemoryText(), { reply_markup: mainKeyboard });
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

// Handle text messages
bot.on("message:text", async (ctx) => {
  if (!isOwner(ctx)) return;
  const userId = String(ctx.from.id);
  const text = ctx.message.text;

  const thinkingMsg = await ctx.reply("Думаю... ⏳");
  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);

  try {
    const sessionId = sessions.get(userId) || null;
    const result = await callClaude(text, sessionId);

    if (result.sessionId) {
      sessions.set(userId, result.sessionId);
      saveSessions();
    }

    clearInterval(typingInterval);
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await sendResponse(ctx, result.text);
  } catch (err) {
    clearInterval(typingInterval);
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    console.error("[error]", err.message);
    await ctx.reply("Произошла ошибка. Попробуй ещё раз или нажми 🔄 Новый диалог.", { reply_markup: mainKeyboard });
  }
});

// Handle voice messages
bot.on("message:voice", async (ctx) => {
  if (!isOwner(ctx)) return;
  if (!process.env.DEEPGRAM_API_KEY) {
    return ctx.reply("Голосовые пока не поддерживаются. Нужен DEEPGRAM_API_KEY в .env", { reply_markup: mainKeyboard });
  }

  const thinkingMsg = await ctx.reply("Слушаю голосовое... 🎤");
  const typingInterval = setInterval(() => {
    ctx.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);

  try {
    const file = await ctx.getFile();
    const tmpPath = `/tmp/voice_${ctx.from.id}_${Date.now()}.ogg`;
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    await downloadTgFile(fileUrl, tmpPath);

    const transcript = await transcribeVoice(tmpPath);
    unlinkSync(tmpPath);

    if (!transcript) {
      clearInterval(typingInterval);
      await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
      return ctx.reply("Не удалось распознать голосовое. Попробуй ещё раз.", { reply_markup: mainKeyboard });
    }

    await ctx.api.editMessageText(ctx.chat.id, thinkingMsg.message_id,
      `Распознано: "${transcript.slice(0, 100)}${transcript.length > 100 ? "..." : ""}"\n\nДумаю... ⏳`);

    const userId = String(ctx.from.id);
    const sessionId = sessions.get(userId) || null;
    const result = await callClaude(transcript, sessionId);

    if (result.sessionId) {
      sessions.set(userId, result.sessionId);
      saveSessions();
    }

    clearInterval(typingInterval);
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    await sendResponse(ctx, result.text);
  } catch (err) {
    clearInterval(typingInterval);
    await ctx.api.deleteMessage(ctx.chat.id, thinkingMsg.message_id).catch(() => {});
    console.error("[voice-error]", err.message);
    await ctx.reply("Ошибка обработки голосового. Попробуй текстом.", { reply_markup: mainKeyboard });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

bot.catch((err) => console.error("[bot-error]", err.message));

bot.start({
  onStart: () => {
    console.log(`Agent bot started (workspace: ${WORKSPACE}, projects: ${PROJECTS})`);
    if (OWNER_ID) console.log(`Owner: ${OWNER_ID} (only owner can use bot)`);
    else console.log("Warning: OWNER_ID not set — bot accepts messages from anyone");
  },
  drop_pending_updates: true,
});
