import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { play, pause, resume, stop, setVolume, getStatus, search, seek, related } from "./player.js";
import { recordPlay, getHistory, chat } from "./ai.js";
import { listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist, addTrack, removeTrack, reorderTrack } from "./playlist.js";

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
    const limit = Math.max(5, Math.min(50, Number(req.query.limit) || 15));
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

/* ---- Playlist routes ---- */

app.get("/api/playlists", (_req, res) => {
  res.json({ ok: true, playlists: listPlaylists() });
});

app.post("/api/playlists", (req, res) => {
  try {
    const { name, description } = req.body || {};
    res.json({ ok: true, playlist: createPlaylist(name, description) });
  } catch (err) {
    sendError(res, err, 400);
  }
});

app.get("/api/playlists/:id", (req, res) => {
  try {
    res.json({ ok: true, playlist: getPlaylist(req.params.id) });
  } catch (err) {
    sendError(res, err, 404);
  }
});

app.patch("/api/playlists/:id", (req, res) => {
  try {
    const { name, description } = req.body || {};
    res.json({ ok: true, playlist: updatePlaylist(req.params.id, { name, description }) });
  } catch (err) {
    sendError(res, err, 404);
  }
});

app.delete("/api/playlists/:id", (req, res) => {
  try {
    res.json({ ok: true, playlist: deletePlaylist(req.params.id) });
  } catch (err) {
    sendError(res, err, 404);
  }
});

app.post("/api/playlists/:id/tracks", (req, res) => {
  try {
    const track = req.body || {};
    res.json({ ok: true, playlist: addTrack(req.params.id, track) });
  } catch (err) {
    sendError(res, err, 400);
  }
});

app.delete("/api/playlists/:id/tracks/:trackId", (req, res) => {
  try {
    res.json({ ok: true, playlist: removeTrack(req.params.id, req.params.trackId) });
  } catch (err) {
    sendError(res, err, 404);
  }
});

app.patch("/api/playlists/:id/tracks/:trackId/reorder", (req, res) => {
  try {
    const { position } = req.body || {};
    if (position === undefined) return sendError(res, new Error("position is required"), 400);
    res.json({ ok: true, playlist: reorderTrack(req.params.id, req.params.trackId, position) });
  } catch (err) {
    sendError(res, err, 404);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Resonance listening on http://localhost:${PORT}`);
});
