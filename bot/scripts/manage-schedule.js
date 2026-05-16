#!/usr/bin/env node
/**
 * manage-schedule.js — CRUD for schedules.json
 * Called by Claude via Bash: node ~/.agent/bot/scripts/manage-schedule.js <command> [args]
 *
 * Commands:
 *   add '{"name":"...", "type":"daily", ...}'
 *   list
 *   search "text"
 *   remove <id>
 *   update <id> '{"hour": 8}'
 *   enable <id>
 *   disable <id>
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
const AGENT_DIR = join(AGENT_HOME, ".agent");
const SCHEDULES_FILE = join(AGENT_DIR, "schedules.json");
const STATE_FILE = join(AGENT_DIR, "state.json");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadSchedules() {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSchedules(schedules) {
  const tmp = SCHEDULES_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(schedules, null, 2));
  renameSync(tmp, SCHEDULES_FILE);
}

function getTimezone() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return state.timezone || "Europe/Moscow";
  } catch {
    return "Europe/Moscow";
  }
}

function nowLocal() {
  const tz = getTimezone();
  const str = new Date().toLocaleString("en-US", { timeZone: tz });
  return new Date(str);
}

function ok(message, extra = {}) {
  console.log(JSON.stringify({ ok: true, message, ...extra }));
  process.exit(0);
}

function fail(error) {
  console.log(JSON.stringify({ ok: false, error }));
  process.exit(1);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_TYPES = ["daily", "weekly", "once"];
const VALID_PAYLOADS = ["reminder", "task"];

function validate(entry) {
  if (!entry.name) fail("name is required");
  if (!VALID_TYPES.includes(entry.type)) fail(`type must be one of: ${VALID_TYPES.join(", ")}`);

  if (entry.type === "daily" || entry.type === "weekly") {
    if (typeof entry.hour !== "number" || entry.hour < 0 || entry.hour > 23)
      fail("hour must be 0-23");
    if (entry.minute !== undefined && (typeof entry.minute !== "number" || entry.minute < 0 || entry.minute > 59))
      fail("minute must be 0-59");
  }

  if (entry.type === "weekly") {
    if (!Array.isArray(entry.weekdays) || !entry.weekdays.length)
      fail("weekdays required for weekly (array of 1-7)");
    if (entry.weekdays.some((d) => d < 1 || d > 7))
      fail("weekdays must be 1 (Mon) - 7 (Sun)");
  }

  if (entry.type === "once") {
    if (!entry.at) fail("at (ISO datetime) required for once");
    const d = new Date(entry.at);
    if (isNaN(d.getTime())) fail("at must be valid ISO datetime");
  }

  const payload = entry.payload || "task";
  if (!VALID_PAYLOADS.includes(payload)) fail(`payload must be: ${VALID_PAYLOADS.join(", ")}`);
  if (payload === "reminder" && !entry.text) fail("text is required for reminder payload");
  if (payload === "task" && !entry.prompt) fail("prompt is required for task payload");
}

// ─── Commands ────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

if (!command) {
  fail("Usage: manage-schedule.js <add|list|search|remove|update|enable|disable> [args]");
}

const schedules = loadSchedules();

switch (command) {
  case "add": {
    if (!args[0]) fail("JSON argument required");
    let entry;
    try {
      entry = JSON.parse(args[0]);
    } catch {
      fail("Invalid JSON");
    }
    validate(entry);

    const id = randomUUID().slice(0, 8);
    const sched = {
      id,
      name: entry.name,
      type: entry.type,
      ...(entry.hour !== undefined && { hour: entry.hour }),
      ...(entry.minute !== undefined && { minute: entry.minute || 0 }),
      ...(entry.weekdays && { weekdays: entry.weekdays }),
      ...(entry.at && { at: entry.at }),
      payload: entry.payload || "task",
      ...(entry.text && { text: entry.text }),
      ...(entry.prompt && { prompt: entry.prompt }),
      enabled: true,
      deleteAfterRun: entry.type === "once" ? true : false,
      createdAt: new Date().toISOString(),
    };

    schedules.push(sched);
    saveSchedules(schedules);

    const timeStr =
      sched.type === "once"
        ? new Date(sched.at).toLocaleString("ru-RU", { timeZone: getTimezone() })
        : sched.type === "daily"
          ? `каждый день в ${String(sched.hour).padStart(2, "0")}:${String(sched.minute || 0).padStart(2, "0")}`
          : `еженедельно в ${String(sched.hour).padStart(2, "0")}:${String(sched.minute || 0).padStart(2, "0")}`;

    ok(`Создано: "${sched.name}" — ${timeStr}`, { schedule: sched });
    break;
  }

  case "list": {
    const active = schedules.filter((s) => s.enabled);
    const inactive = schedules.filter((s) => !s.enabled);
    ok(`Активных: ${active.length}, отключённых: ${inactive.length}`, {
      active,
      inactive,
    });
    break;
  }

  case "search": {
    const query = (args[0] || "").toLowerCase();
    if (!query) fail("Search query required");
    const found = schedules.filter(
      (s) =>
        (s.name || "").toLowerCase().includes(query) ||
        (s.text || "").toLowerCase().includes(query) ||
        (s.prompt || "").toLowerCase().includes(query)
    );
    ok(`Найдено: ${found.length}`, { results: found });
    break;
  }

  case "remove": {
    const id = args[0];
    if (!id) fail("ID required");
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) fail(`Schedule ${id} not found`);
    const removed = schedules.splice(idx, 1)[0];
    saveSchedules(schedules);
    ok(`Удалено: "${removed.name}" (${removed.id})`);
    break;
  }

  case "update": {
    const id = args[0];
    if (!id || !args[1]) fail("ID and JSON patch required");
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx === -1) fail(`Schedule ${id} not found`);
    let patch;
    try {
      patch = JSON.parse(args[1]);
    } catch {
      fail("Invalid JSON patch");
    }
    // Only allow safe fields to be patched
    const allowed = ["name", "hour", "minute", "weekdays", "at", "text", "prompt", "payload"];
    for (const key of Object.keys(patch)) {
      if (!allowed.includes(key)) fail(`Cannot update field: ${key}`);
      schedules[idx][key] = patch[key];
    }
    schedules[idx].updatedAt = new Date().toISOString();
    saveSchedules(schedules);
    ok(`Обновлено: "${schedules[idx].name}" (${id})`, { schedule: schedules[idx] });
    break;
  }

  case "enable": {
    const id = args[0];
    if (!id) fail("ID required");
    const sched = schedules.find((s) => s.id === id);
    if (!sched) fail(`Schedule ${id} not found`);
    sched.enabled = true;
    sched.updatedAt = new Date().toISOString();
    saveSchedules(schedules);
    ok(`Включено: "${sched.name}" (${id})`);
    break;
  }

  case "disable": {
    const id = args[0];
    if (!id) fail("ID required");
    const sched = schedules.find((s) => s.id === id);
    if (!sched) fail(`Schedule ${id} not found`);
    sched.enabled = false;
    sched.updatedAt = new Date().toISOString();
    saveSchedules(schedules);
    ok(`Отключено: "${sched.name}" (${id})`);
    break;
  }

  default:
    fail(`Unknown command: ${command}. Available: add, list, search, remove, update, enable, disable`);
}
