#!/usr/bin/env node
/**
 * CLI script for manual full reindex of memory
 * Usage: node ~/.agent/bot/scripts/reindex.js
 */

import { initDb, closeDb } from "../lib/db.js";
import { reindexAll } from "../lib/memory-indexer.js";

try {
  await initDb();
  await reindexAll();
  closeDb();
  console.log("Reindex complete.");
} catch (e) {
  console.error("Reindex failed:", e.message);
  process.exit(1);
}
