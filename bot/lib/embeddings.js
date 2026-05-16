/**
 * embeddings.js — Voyage AI wrapper for semantic embeddings
 * Model: voyage-3-lite ($0.02/1M tokens)
 * Fallback: returns null if no VOYAGE_API_KEY (FTS5 will be used instead)
 */

import https from "node:https";

const VOYAGE_API_URL = "api.voyageai.com";
const VOYAGE_MODEL = "voyage-3-lite";
const MAX_BATCH_SIZE = 128; // Voyage AI batch limit

/**
 * Check if Voyage AI is available
 */
export function isVoyageAvailable() {
  const key = process.env.VOYAGE_API_KEY;
  // Must exist and look like an API key (ASCII, no spaces, min 10 chars)
  return !!key && key.length >= 10 && /^[\x20-\x7E]+$/.test(key) && !key.includes(" ");
}

/**
 * Get embeddings for an array of texts
 * @param {string[]} texts - Array of text chunks
 * @returns {Promise<Float32Array[]|null>} Array of embedding vectors or null if unavailable
 */
export async function getEmbeddings(texts) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey || texts.length === 0) return null;

  const results = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const embeddings = await _callVoyage(apiKey, batch);
    if (!embeddings) return null;
    results.push(...embeddings);
  }

  return results;
}

/**
 * Get embedding for a single text (convenience wrapper)
 */
export async function getEmbedding(text) {
  const result = await getEmbeddings([text]);
  return result ? result[0] : null;
}

/**
 * Cosine similarity between two Float32Arrays
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Call Voyage AI API
 */
function _callVoyage(apiKey, texts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: "document",
    });

    const req = https.request(
      {
        hostname: VOYAGE_API_URL,
        port: 443,
        path: "/v1/embeddings",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            console.error(`[embeddings] Voyage API error ${res.statusCode}:`, data.slice(0, 200));
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(data);
            const embeddings = json.data
              .sort((a, b) => a.index - b.index)
              .map((item) => new Float32Array(item.embedding));
            resolve(embeddings);
          } catch (e) {
            console.error("[embeddings] Parse error:", e.message);
            resolve(null);
          }
        });
      }
    );

    req.on("error", (e) => {
      console.error("[embeddings] Request error:", e.message);
      resolve(null); // Don't crash on network errors
    });

    req.on("timeout", () => {
      req.destroy();
      console.error("[embeddings] Request timeout");
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}
