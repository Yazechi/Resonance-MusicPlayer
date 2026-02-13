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
Respond with ONLY valid JSON with NO markdown, NO backticks, NO extra text. Use this exact format:
{"message":"short friendly reply","suggestions":[{"query":"Artist - Song Title","reason":"brief reason"}]}
Include 5-6 suggestions. Be specific with artist + song title. If unrelated to music, redirect politely.
CRITICAL: Your entire response must be valid JSON. Do not include any text before or after the JSON object.`;

function cleanJsonResponse(text) {
  // Remove markdown code blocks if present
  let cleaned = text.trim();
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    cleaned = jsonMatch[1].trim();
  }
  
  // Remove any leading/trailing non-JSON text
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
  }
  
  return cleaned;
}

function validateResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }
  if (!parsed.message || typeof parsed.message !== 'string') {
    return false;
  }
  if (!Array.isArray(parsed.suggestions)) {
    return false;
  }
  // Validate each suggestion
  for (const suggestion of parsed.suggestions) {
    if (!suggestion.query || typeof suggestion.query !== 'string') {
      return false;
    }
  }
  return true;
}

export async function chat(userMessage, recentHistory) {
  const model = getModel();
  const historyBlock = recentHistory.length
    ? `\nHistory:\n${recentHistory.map((h, i) => `${i + 1}. "${h.title}" by ${h.uploader}`).join("\n")}`
    : "";

  const prompt = `${SYSTEM_PROMPT}${historyBlock}\n\nUser: ${userMessage}`;

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text();
      
      // Clean and parse the response
      const cleaned = cleanJsonResponse(text);
      
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseErr) {
        console.error("JSON parse error:", parseErr.message);
        console.error("Attempted to parse:", cleaned.substring(0, 200));
        throw new Error("AI returned invalid JSON format");
      }
      
      // Validate the response structure
      if (!validateResponse(parsed)) {
        throw new Error("AI response missing required fields");
      }
      
      return parsed;
    } catch (err) {
      lastErr = err;
      console.error(`Chat attempt ${attempt + 1} failed:`, err.message);
      
      // Retry on rate limit errors
      if (err.message?.includes("429") && attempt < 2) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      
      // Don't retry on JSON parse errors after first attempt
      if (err.message?.includes("JSON") && attempt > 0) {
        break;
      }
    }
  }
  
  // Handle specific error types
  if (lastErr?.message?.includes("429") || lastErr?.message?.includes("quota")) {
    throw new Error("Gemini API quota exceeded — try again later or enable billing at https://ai.google.dev");
  }
  
  if (lastErr?.message?.includes("JSON")) {
    throw new Error("AI generated invalid response format. Please try rephrasing your request.");
  }
  
  throw lastErr || new Error("Failed to get AI response after multiple attempts");
}