/**
 * memory-search.js — Semantic memory search
 * Vector search (Voyage AI) with FTS5 fallback
 * Used as a Claude tool via CLI script
 */

import { getAllEmbeddings, textSearch } from "./db.js";
import { getEmbedding, cosineSimilarity, isVoyageAvailable } from "./embeddings.js";

/**
 * Search memory chunks by semantic similarity or FTS5
 * @param {string} query - Search query
 * @param {number} topK - Number of results (default 5)
 * @returns {Promise<Array<{content, filePath, lineStart, lineEnd, score}>>}
 */
export async function searchMemory(query, topK = 5) {
  if (!query || query.trim().length === 0) return [];

  // Try vector search first
  if (isVoyageAvailable()) {
    const results = await _vectorSearch(query, topK);
    if (results && results.length > 0) {
      console.log(`[semantic-memory] vector search: ${results.length} results for "${query.slice(0, 50)}"`);
      return results;
    }
  }

  // Fallback to text search (LIKE-based)
  const textResults = _textSearchSafe(query, topK);
  console.log(`[semantic-memory] text search: ${textResults.length} results for "${query.slice(0, 50)}"`);
  return textResults;
}

/**
 * Vector search using cosine similarity
 */
async function _vectorSearch(query, topK) {
  const queryEmb = await getEmbedding(query);
  if (!queryEmb) return null;

  const chunks = getAllEmbeddings();
  if (chunks.length === 0) return null;

  const scored = chunks
    .map((chunk) => ({
      content: chunk.content,
      filePath: chunk.filePath,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      score: cosineSimilarity(queryEmb, chunk.embedding),
    }))
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

/**
 * Text search fallback (LIKE-based)
 */
function _textSearchSafe(query, topK) {
  try {
    return textSearch(query, topK);
  } catch (e) {
    console.warn("[semantic-memory] text search error:", e.message);
    return [];
  }
}

/**
 * Format search results as JSON for Claude tool output
 */
export function formatResults(results) {
  if (results.length === 0) {
    return JSON.stringify({ results: [], message: "Nothing found in memory" });
  }

  return JSON.stringify({
    results: results.map((r) => ({
      content: r.content,
      source: `${r.filePath}:${r.lineStart}-${r.lineEnd}`,
      score: Math.round(r.score * 100) / 100,
    })),
    count: results.length,
  });
}
