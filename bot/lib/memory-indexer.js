/**
 * memory-indexer.js — Background indexer for memory files
 * Watches memory/, knowledge/, MEMORY.md and indexes changes into SQLite
 * Uses fs.watch (Node.js 20+ recursive) + debounce
 */

import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { upsertChunk, deleteChunksForFile, getHashesForFile, getChunkCount } from "./db.js";
import { getEmbeddings, isVoyageAvailable } from "./embeddings.js";

const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
const WORKSPACE = join(AGENT_HOME, "workspace");
const MEMORY_DIR = join(WORKSPACE, "memory");
const KNOWLEDGE_DIR = join(WORKSPACE, "knowledge");
const MEMORY_MD = join(WORKSPACE, "MEMORY.md");

const CHUNK_SIZE = 450; // characters per chunk
const CHUNK_OVERLAP = 80;
const DEBOUNCE_MS = 1500;

// Track pending file changes for debounce
const _pendingFiles = new Map();
let _indexingInProgress = false;

/**
 * Start the background file watcher
 */
export function startWatcher() {
  const watchPaths = [
    { path: MEMORY_DIR, recursive: true },
    { path: KNOWLEDGE_DIR, recursive: true },
  ];

  for (const { path, recursive } of watchPaths) {
    if (!existsSync(path)) continue;
    try {
      watch(path, { recursive }, (eventType, filename) => {
        if (!filename || !filename.endsWith(".md")) return;
        const fullPath = join(path, filename);
        _scheduleReindex(fullPath);
      });
      console.log(`[indexer] Watching ${path}`);
    } catch (e) {
      console.warn(`[indexer] Cannot watch ${path}: ${e.message}`);
    }
  }

  // Watch MEMORY.md separately (single file)
  if (existsSync(MEMORY_MD)) {
    try {
      watch(MEMORY_MD, () => _scheduleReindex(MEMORY_MD));
      console.log("[indexer] Watching MEMORY.md");
    } catch (e) {
      console.warn(`[indexer] Cannot watch MEMORY.md: ${e.message}`);
    }
  }
}

/**
 * Schedule a file for reindexing (debounced)
 */
function _scheduleReindex(filePath) {
  if (_pendingFiles.has(filePath)) {
    clearTimeout(_pendingFiles.get(filePath));
  }
  _pendingFiles.set(
    filePath,
    setTimeout(() => {
      _pendingFiles.delete(filePath);
      reindexFile(filePath).catch((e) =>
        console.error(`[indexer] Error reindexing ${filePath}:`, e.message)
      );
    }, DEBOUNCE_MS)
  );
}

/**
 * Reindex a single file: chunk it, hash, embed new chunks, upsert
 */
export async function reindexFile(filePath) {
  if (_indexingInProgress) return; // Skip if another indexing is running
  _indexingInProgress = true;

  try {
    // Check if file still exists
    try {
      await stat(filePath);
    } catch {
      // File deleted — remove its chunks
      deleteChunksForFile(filePath);
      console.log(`[indexer] Removed chunks for deleted file: ${filePath}`);
      return;
    }

    const content = await readFile(filePath, "utf8");
    if (!content.trim()) return;

    const relPath = relative(WORKSPACE, filePath);
    const chunks = _chunkText(content);
    const existingHashes = getHashesForFile(relPath);

    // Find new/changed chunks
    const newChunks = [];
    const newChunkMeta = [];

    for (const chunk of chunks) {
      const hash = createHash("sha256").update(chunk.text).digest("hex").slice(0, 16);
      const existingHash = existingHashes.get(chunk.lineStart);

      if (existingHash === hash) continue; // Unchanged — skip

      newChunks.push(chunk);
      newChunkMeta.push({ ...chunk, hash });
    }

    if (newChunks.length === 0) return;

    // Get embeddings for new chunks (batch)
    let embeddings = null;
    if (isVoyageAvailable()) {
      embeddings = await getEmbeddings(newChunks.map((c) => c.text));
    }

    // Upsert all new chunks
    for (let i = 0; i < newChunkMeta.length; i++) {
      const meta = newChunkMeta[i];
      const embedding = embeddings ? Buffer.from(embeddings[i].buffer) : null;
      upsertChunk(relPath, meta.lineStart, meta.lineEnd, meta.text, meta.hash, embedding);
    }

    console.log(`[indexer] Indexed ${newChunks.length} chunks from ${relPath} (total: ${getChunkCount()})`);
  } finally {
    _indexingInProgress = false;
  }
}

/**
 * Full reindex of all memory and knowledge files
 */
export async function reindexAll() {
  console.log("[indexer] Starting full reindex...");
  const files = [];

  // Collect all markdown files
  if (existsSync(MEMORY_MD)) files.push(MEMORY_MD);

  for (const dir of [MEMORY_DIR, KNOWLEDGE_DIR]) {
    if (!existsSync(dir)) continue;
    const entries = await _walkDir(dir);
    files.push(...entries);
  }

  let indexed = 0;
  for (const file of files) {
    await reindexFile(file);
    indexed++;
  }

  console.log(`[indexer] Full reindex complete: ${indexed} files, ${getChunkCount()} total chunks`);
}

/**
 * Recursively list all .md files in a directory
 */
async function _walkDir(dir) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await _walkDir(fullPath)));
      } else if (entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore unreadable dirs */ }
  return results;
}

/**
 * Split text into overlapping chunks of ~CHUNK_SIZE characters
 * Preserves line boundaries and tracks line numbers
 */
function _chunkText(text) {
  const lines = text.split("\n");
  const chunks = [];
  let currentChunk = "";
  let chunkLineStart = 1;
  let lineNum = 1;

  for (const line of lines) {
    if (currentChunk.length + line.length + 1 > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push({
        text: currentChunk.trim(),
        lineStart: chunkLineStart,
        lineEnd: lineNum - 1,
      });

      // Overlap: keep last few lines
      const overlapLines = currentChunk.split("\n");
      const overlapText = overlapLines.slice(-3).join("\n");
      if (overlapText.length <= CHUNK_OVERLAP) {
        currentChunk = overlapText + "\n" + line;
        chunkLineStart = Math.max(1, lineNum - 3);
      } else {
        currentChunk = line;
        chunkLineStart = lineNum;
      }
    } else {
      currentChunk += (currentChunk ? "\n" : "") + line;
    }
    lineNum++;
  }

  // Last chunk
  if (currentChunk.trim()) {
    chunks.push({
      text: currentChunk.trim(),
      lineStart: chunkLineStart,
      lineEnd: lineNum - 1,
    });
  }

  return chunks;
}
