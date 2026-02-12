import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "..", "listening-history.json");
const MAX_HISTORY = 100;

/* ---- Listening history ---- */

let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch { /* fresh start */ }

export function recordPlay(meta) {
  if (!meta?.title) return;
  history.unshift({
    title: meta.title,
    uploader: meta.uploader || "",
    id: meta.id || "",
    ts: Date.now()
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

export function getHistory(limit = 20) {
  return history.slice(0, limit);
}

/* ---- Gemini AI chat ---- */

let genModel = null;

function getModel() {
  if (genModel) return genModel;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set. Add it to your .env file.");
  const genAI = new GoogleGenerativeAI(key);
  genModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
  return genModel;
}

const SYSTEM_PROMPT = `You are Resonance AI, a music recommendation assistant. Suggest songs based on the user's request and history.
Respond with ONLY valid JSON: {"message":"short friendly reply","suggestions":[{"query":"Artist - Song Title","reason":"brief reason"}]}
Include 5-6 suggestions. Be specific with artist + song title. If unrelated to music, redirect politely.`;

export async function chat(userMessage, recentHistory) {
  const model = getModel();
  const historyBlock = recentHistory.length
    ? `\nHistory:\n${recentHistory.map((h, i) => `${i + 1}. "${h.title}" by ${h.uploader}`).join("\n")}`
    : "";

  const prompt = `${SYSTEM_PROMPT}${historyBlock}\n\nUser: ${userMessage}`;

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (!parsed.message || !Array.isArray(parsed.suggestions)) {
        throw new Error("Invalid AI response format");
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      if (err.message?.includes("429") && attempt < 1) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      break;
    }
  }
  if (lastErr?.message?.includes("429") || lastErr?.message?.includes("quota")) {
    throw new Error("Gemini API quota exceeded — try again later or enable billing at https://ai.google.dev");
  }
  throw lastErr;
}
