import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { play, pause, resume, stop, setVolume, getStatus, search, seek, related } from "./player.js";
import { recordPlay, getHistory, chat } from "./ai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function sendError(res, error, status = 500) {
  res.status(status).json({ ok: false, error: error.message || String(error) });
}

app.get("/api/status", async (_req, res) => {
  res.json({ ok: true, result: await getStatus() });
});

app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return sendError(res, new Error("Query parameter q is required"), 400);
    const limit = Math.max(10, Math.min(50, Number(req.query.limit) || 30));
    const results = await search(query, limit);
    res.json({ ok: true, results });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/play", async (req, res) => {
  try {
    const { url, id, query } = req.body || {};
    const target = url || (id ? `https://www.youtube.com/watch?v=${id}` : query);
    if (!target) return sendError(res, new Error("Provide url, id, or query"), 400);
    const result = await play(target);
    if (result.meta) recordPlay(result.meta);
    res.json({ ok: true, result });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/pause", async (_req, res) => {
  try {
    const result = await pause();
    res.json({ ok: true, result });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/resume", async (_req, res) => {
  try {
    const result = await resume();
    res.json({ ok: true, result });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/stop", async (_req, res) => {
  try {
    const result = await stop();
    res.json({ ok: true, result });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/volume", async (req, res) => {
  try {
    const { level } = req.body || {};
    if (level === undefined) return sendError(res, new Error("Volume level is required"), 400);
    const result = await setVolume(level);
    res.json({ ok: true, result });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/seek", async (req, res) => {
  try {
    const { position } = req.body || {};
    if (position === undefined) return sendError(res, new Error("Position is required"), 400);
    const result = await seek(position);
    res.json({ ok: true, result });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/related", async (req, res) => {
  try {
    const { title, uploader } = req.query;
    if (!title) return sendError(res, new Error("title query param required"), 400);
    const results = await related(title, uploader);
    res.json({ ok: true, results });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/history", (_req, res) => {
  res.json({ ok: true, history: getHistory(20) });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message?.trim()) return sendError(res, new Error("message is required"), 400);
    const history = getHistory(5);
    const result = await chat(message, history);
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Music app listening on http://localhost:${PORT}`);
});
