import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "..", "listening-history.json");
const MAX_HISTORY = 100;

/* ---- Listening history ---- */

let history = [];
try {
  history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
} catch {
  /* fresh start — file doesn't exist yet */
}

/**
 * FIX: YouTube CDN thumbnail URLs (i.ytimg.com with query params) expire after
 * a few hours. Instead, derive a stable thumbnail URL directly from the video ID
 * using YouTube's standard thumbnail format which never expires.
 *
 * Format: https://i.ytimg.com/vi/{videoId}/mqdefault.jpg
 * mqdefault = medium quality (320x180), always available for any public video.
 */
function stableThumbnail(id, fallbackUrl) {
  if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) {
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  }
  // For non-standard IDs (e.g. AI query strings), keep the original URL as-is
  return fallbackUrl || "";
}

export function recordPlay(meta) {
  if (!meta?.title) return;
  // Avoid duplicate consecutive entries for the same song
  if (history[0]?.id && history[0].id === meta.id) return;
  history.unshift({
    title: meta.title,
    uploader: meta.uploader || "",
    id: meta.id || "",
    // FIX: store a stable thumbnail derived from the video ID, not the expiring CDN URL
    thumbnail: stableThumbnail(meta.id, meta.thumbnail),
    ts: Date.now()
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  // Write async — don't block the response
  fs.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), () => {});
}

export function getHistory(limit = 20) {
  return history.slice(0, limit).map(item => ({
    ...item,
    // FIX: also re-derive thumbnail on read in case old entries have expiring URLs
    thumbnail: stableThumbnail(item.id, item.thumbnail)
  }));
}

/* ---- Gemini AI chat ---- */

let genModel = null;

function getModel() {
  if (genModel) return genModel;
  const key = process.env.GEMINI_API_KEY;

  
  if (!key) throw new Error("GEMINI_API_KEY not set. Add it to your .env file.");
  const genAI = new GoogleGenerativeAI(key);
  genModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  return genModel;
}

const SYSTEM_PROMPT = `You are Resonance AI, a music recommendation assistant. Suggest SONGS (music tracks) based on the user's request and history.
Respond with ONLY valid JSON with NO markdown, NO backticks, NO extra text. Use this exact format:
{"message":"short friendly reply","suggestions":[{"query":"Artist - Song Title","reason":"brief reason"}]}
Include 5-6 suggestions. Each suggestion MUST be a real music track (song), NOT a podcast, interview, movie, TV show, or general video.
Be specific with artist name + song title so it can be found on YouTube Music. If unrelated to music, redirect politely.
CRITICAL: Your entire response must be valid JSON. Do not include any text before or after the JSON object.`;

function cleanJsonResponse(text) {
  let cleaned = text.trim();
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) cleaned = jsonMatch[1].trim();
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd !== -1) cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  return cleaned;
}

function validateResponse(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  if (!parsed.message || typeof parsed.message !== "string") return false;
  if (!Array.isArray(parsed.suggestions)) return false;
  for (const s of parsed.suggestions) {
    if (!s.query || typeof s.query !== "string") return false;
  }
  return true;
}

export async function chat(userMessage, recentHistory) {
  const model = getModel();
  const historyBlock = recentHistory.length
    ? `\nHistory:\n${recentHistory.map((h, i) => `${i + 1}. "${h.title}" by ${h.uploader}`).join("\n")}`
    : "";

  const prompt = `${SYSTEM_PROMPT}${historyBlock}\n\nUser: ${userMessage}`;

  const MAX_ATTEMPTS = 3;
  let lastErr;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      const cleaned = cleanJsonResponse(text);

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.error(`[ai] JSON parse error (attempt ${attempt + 1}):`, parseErr.message);
        throw new Error("AI returned invalid JSON format");
      }

      if (!validateResponse(parsed)) throw new Error("AI response missing required fields");
      return parsed;

    } catch (err) {
      lastErr = err;
      console.error(`[ai] chat attempt ${attempt + 1}/${MAX_ATTEMPTS} failed:`, err.message);

      const isRateLimit = err.message?.includes("429") || err.message?.includes("quota");
      const isJsonErr = err.message?.includes("JSON") || err.message?.includes("required fields");

      if (attempt < MAX_ATTEMPTS - 1) {
        if (isRateLimit) {
          const wait = 2000 * Math.pow(2, attempt);
          console.error(`[ai] rate limited, waiting ${wait}ms before retry`);
          await new Promise(r => setTimeout(r, wait));
        } else if (isJsonErr) {
          if (attempt > 0) break;
          await new Promise(r => setTimeout(r, 500));
        } else {
          break;
        }
      }
    }
  }

  const msg = lastErr?.message || "";
  if (msg.includes("429") || msg.includes("quota")) {
    throw new Error("Gemini API quota exceeded — try again later or enable billing at https://ai.google.dev");
  }
  if (msg.includes("JSON") || msg.includes("required fields")) {
    throw new Error("AI generated an invalid response. Please try rephrasing your request.");
  }
  if (msg.includes("GEMINI_API_KEY")) throw lastErr;
  throw new Error("Failed to get AI response. Please try again.");
}