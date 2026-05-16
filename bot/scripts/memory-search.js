#!/usr/bin/env node
/**
 * CLI wrapper for memory search — called by Claude as a tool
 * Usage: node ~/.agent/bot/scripts/memory-search.js "search query"
 * Output: JSON with top-5 results
 */

import { initDb } from "../lib/db.js";
import { searchMemory, formatResults } from "../lib/memory-search.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_HOME = process.env.AGENT_HOME || "/home/agent";
const STATE_FILE = join(AGENT_HOME, ".agent", "state.json");

function incrementSearchCount() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!state.semanticSearchStats) state.semanticSearchStats = { totalSearches: 0, lastSearch: null };
    state.semanticSearchStats.totalSearches++;
    state.semanticSearchStats.lastSearch = new Date().toISOString();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

const query = process.argv[2];
if (!query) {
  console.log(JSON.stringify({ error: "Usage: memory-search.js 'query'" }));
  process.exit(1);
}

try {
  await initDb();
  const results = await searchMemory(query, 5);
  incrementSearchCount();
  console.log(formatResults(results));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
}
