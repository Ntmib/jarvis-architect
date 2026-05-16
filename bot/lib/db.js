/**
 * db.js — SQLite database via sql.js (WASM, no native compilation)
 * Handles: init, migrations, save/load, basic CRUD for memory_chunks
 */

import initSqlJs from "sql.js";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
const DB_PATH = join(AGENT_HOME, ".agent", "memory.db");
const MIGRATIONS_DIR = join(AGENT_HOME, ".agent", "bot", "migrations");

let _db = null;
let _SQL = null;
let _saveTimer = null;

// Debounced save — writes to disk at most once per 2 seconds
function _scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    _saveToDisk();
  }, 2000);
}

function _saveToDisk() {
  if (!_db) return;
  try {
    const data = _db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error("[db] save failed:", e.message);
  }
}

/**
 * Initialize database: load sql.js WASM, open/create DB, run migrations
 */
export async function initDb() {
  if (_db) return _db;

  _SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const buf = readFileSync(DB_PATH);
    _db = new _SQL.Database(buf);
  } else {
    _db = new _SQL.Database();
  }

  // Enable WAL-like behavior (not real WAL in sql.js, but helps with reads)
  _db.run("PRAGMA journal_mode=MEMORY");

  _runMigrations();
  _saveToDisk();

  return _db;
}

/**
 * Run all pending SQL migrations from migrations/ directory
 * Idempotent — tracks applied migrations in schema_migrations table
 */
function _runMigrations() {
  // Ensure schema_migrations exists (bootstrap)
  _db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  const applied = new Set();
  const rows = _db.exec("SELECT version FROM schema_migrations");
  if (rows.length > 0) {
    for (const row of rows[0].values) {
      applied.add(row[0]);
    }
  }

  // Find and sort migration files
  let files = [];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    console.warn("[db] No migrations directory found at", MIGRATIONS_DIR);
    return;
  }

  for (const file of files) {
    const match = file.match(/^(\d+)/);
    if (!match) continue;
    const version = parseInt(match[1], 10);
    if (applied.has(version)) continue;

    console.log(`[db] Running migration ${file}...`);
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

    // Remove comment lines, then split by semicolons
    const cleanSql = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const statements = cleanSql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      try {
        _db.run(stmt);
      } catch (e) {
        // FTS5 virtual tables throw if already exist — safe to ignore
        if (e.message.includes("already exists")) continue;
        console.error(`[db] Migration ${file} failed on statement:`, stmt.slice(0, 80));
        throw e;
      }
    }

    _db.run("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
    console.log(`[db] Migration ${file} applied`);
  }
}

/**
 * Get the raw sql.js Database instance
 */
export function getDb() {
  if (!_db) throw new Error("[db] Not initialized. Call initDb() first");
  return _db;
}

/**
 * Insert or replace a memory chunk
 */
export function upsertChunk(filePath, lineStart, lineEnd, content, contentHash, embedding = null) {
  const db = getDb();
  db.run(
    `INSERT INTO memory_chunks (file_path, line_start, line_end, content, content_hash, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(file_path, line_start) DO UPDATE SET
       line_end = excluded.line_end,
       content = excluded.content,
       content_hash = excluded.content_hash,
       embedding = excluded.embedding,
       updated_at = CURRENT_TIMESTAMP`,
    [filePath, lineStart, lineEnd, content, contentHash, embedding]
  );

  _scheduleSave();
}

/**
 * Delete all chunks for a given file path
 */
export function deleteChunksForFile(filePath) {
  const db = getDb();
  db.run("DELETE FROM memory_chunks WHERE file_path = ?", [filePath]);
  _scheduleSave();
}

/**
 * Get all content hashes for a file (for skip-if-unchanged logic)
 */
export function getHashesForFile(filePath) {
  const db = getDb();
  const result = db.exec(
    "SELECT line_start, content_hash FROM memory_chunks WHERE file_path = ?",
    [filePath]
  );
  const map = new Map();
  if (result.length > 0) {
    for (const row of result[0].values) {
      map.set(row[0], row[1]);
    }
  }
  return map;
}

/**
 * Get all chunks with embeddings (for vector search)
 */
export function getAllEmbeddings() {
  const db = getDb();
  const result = db.exec(
    "SELECT id, file_path, line_start, line_end, content, embedding FROM memory_chunks WHERE embedding IS NOT NULL"
  );
  if (result.length === 0) return [];
  return result[0].values.map((row) => ({
    id: row[0],
    filePath: row[1],
    lineStart: row[2],
    lineEnd: row[3],
    content: row[4],
    embedding: row[5] ? new Float32Array(row[5].buffer, row[5].byteOffset, row[5].byteLength / 4) : null,
  }));
}

/**
 * Text search — LIKE-based fallback when no Voyage AI key
 * Searches for each word independently, scores by number of matches
 */
export function textSearch(query, limit = 5) {
  const db = getDb();
  const words = query
    .replace(/[^\w\sа-яА-ЯёЁ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (words.length === 0) return [];

  // Build WHERE clause: content LIKE '%word1%' OR content LIKE '%word2%'
  const conditions = words.map(() => "content LIKE ?").join(" OR ");
  const params = words.map((w) => `%${w}%`);
  params.push(limit);

  const result = db.exec(
    `SELECT id, file_path, line_start, line_end, content FROM memory_chunks
     WHERE ${conditions}
     LIMIT ?`,
    params
  );
  if (result.length === 0) return [];

  return result[0].values.map((row) => {
    const content = row[4].toLowerCase();
    const matchCount = words.filter((w) => content.includes(w.toLowerCase())).length;
    return {
      id: row[0],
      filePath: row[1],
      lineStart: row[2],
      lineEnd: row[3],
      content: row[4],
      score: matchCount / words.length, // 0..1 proportion of matched words
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Get chunk count
 */
export function getChunkCount() {
  const db = getDb();
  const result = db.exec("SELECT COUNT(*) FROM memory_chunks");
  return result.length > 0 ? result[0].values[0][0] : 0;
}

/**
 * Force save to disk (call before shutdown)
 */
export function saveNow() {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  _saveToDisk();
}

/**
 * Close database
 */
export function closeDb() {
  saveNow();
  if (_db) {
    _db.close();
    _db = null;
  }
}
