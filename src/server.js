import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { play, pause, resume, stop, setVolume, getStatus, search, seek, related } from "./player.js";
import { setEq } from "./player.js";
import { recordPlay, getHistory, chat } from "./ai.js";
import { listPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist, addTrack, removeTrack, reorderTrack } from "./playlist.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static files with aggressive caching for fonts/images, short cache for HTML
app.use(express.static(path.join(__dirname, "..", "public"), {
  maxAge: "1d",
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

function sendError(res, error, status = 500) {
  res.status(status).json({ ok: false, error: error.message || String(error) });
}

// Simple last-value ETag for /api/status to let browser skip parsing unchanged responses
let lastStatusETag = "";
let lastStatusJson = "";

// Simple in-memory queue kept server-side for optional sync with clients
let serverQueue = [];

app.get("/api/status", async (req, res) => {
  try {
    const result = await getStatus();
    const json = JSON.stringify({ ok: true, result });

    // Only recompute ETag when value changes
    if (json !== lastStatusJson) {
      lastStatusJson = json;
      lastStatusETag = `"${Date.now().toString(36)}"`;
    }

    res.setHeader("ETag", lastStatusETag);
    res.setHeader("Cache-Control", "no-store");

    if (req.headers["if-none-match"] === lastStatusETag) {
      return res.status(304).end();
    }

    res.setHeader("Content-Type", "application/json");
    res.end(json);
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return sendError(res, new Error("Query parameter q is required"), 400);
    // Default 30, clamp between 5 and 50 — consistent with player.js default
    const limit = Math.max(5, Math.min(50, Number(req.query.limit) || 30));
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
  try { res.json({ ok: true, result: await pause() }); }
  catch (err) { sendError(res, err); }
});

app.post("/api/resume", async (_req, res) => {
  try { res.json({ ok: true, result: await resume() }); }
  catch (err) { sendError(res, err); }
});

app.post("/api/stop", async (_req, res) => {
  try { res.json({ ok: true, result: await stop() }); }
  catch (err) { sendError(res, err); }
});

app.post("/api/volume", async (req, res) => {
  try {
    const { level } = req.body || {};
    if (level === undefined) return sendError(res, new Error("Volume level is required"), 400);
    res.json({ ok: true, result: await setVolume(level) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/seek", async (req, res) => {
  try {
    const { position } = req.body || {};
    if (position === undefined) return sendError(res, new Error("Position is required"), 400);
    res.json({ ok: true, result: await seek(position) });
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/eq", async (req, res) => {
  try {
    const { filters } = req.body || {};
    // filters is an mpv af string; empty string means Flat (clear)
    const af = typeof filters === 'string' ? filters : '';
    const result = await setEq(af);
    res.json({ ok: true, result });
  } catch (err) {
    // EQ failures are non-fatal — player might not be running yet
    res.json({ ok: true, result: { skipped: true, reason: err.message } });
  }
});

app.get("/api/related", async (req, res) => {
  try {
    const { title, uploader, limit } = req.query;
    if (!title) return sendError(res, new Error("title query param required"), 400);
    const maxLimit = Math.min(Number(limit) || 8, 50);
    const results = await related(title, uploader, maxLimit);
    res.json({ ok: true, results });
  } catch (err) {
    sendError(res, err);
  }
});

app.get("/api/history", (_req, res) => {
  res.json({ ok: true, history: getHistory(20) });
});

// Lyrics proxy endpoint — tries lrclib then lyrics.ovh
app.get("/api/lyrics", async (req, res) => {
  try {
    const title = req.query.title || req.query.track || "";
    const artist = req.query.artist || req.query.uploader || "";
    if (!title) return sendError(res, new Error("title query param required"), 400);
    // Try lrclib first
    const q = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    try {
      const r = await fetch(q);
      if (r.ok) {
        const d = await r.json();
        const lyrics = d.plainLyrics || (d.syncedLyrics ? d.syncedLyrics.replace(/\[\d+:\d+\.\d+\]/g, "") : null);
        if (lyrics) return res.json({ ok: true, source: 'lrclib', lyrics });
      }
    } catch {}
    // Fallback to lyrics.ovh
    try {
      const r2 = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
      if (r2.ok) {
        const d2 = await r2.json();
        if (d2.lyrics) return res.json({ ok: true, source: 'lyrics.ovh', lyrics: d2.lyrics });
      }
    } catch {}
    return sendError(res, new Error('Lyrics not found'), 404);
  } catch (err) { sendError(res, err); }
});

// Simple queue endpoints to allow frontend reorder sync
app.get("/api/queue", (_req, res) => { res.json({ ok: true, queue: serverQueue }); });

app.post("/api/queue/reorder", express.json(), (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (from === undefined || to === undefined) return sendError(res, new Error('from and to are required'), 400);
    const f = Number(from), t = Number(to);
    if (Number.isNaN(f) || Number.isNaN(t) || f < 0 || t < 0 || f >= serverQueue.length || t >= serverQueue.length) return sendError(res, new Error('invalid indexes'), 400);
    const [item] = serverQueue.splice(f, 1);
    serverQueue.splice(t, 0, item);
    res.json({ ok: true, queue: serverQueue });
  } catch (err) { sendError(res, err); }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message?.trim()) return sendError(res, new Error("message is required"), 400);
    const result = await chat(message, getHistory(5));
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
  try { res.json({ ok: true, playlist: getPlaylist(req.params.id) }); }
  catch (err) { sendError(res, err, 404); }
});

app.patch("/api/playlists/:id", (req, res) => {
  try {
    const { name, description } = req.body || {};
    res.json({ ok: true, playlist: updatePlaylist(req.params.id, { name, description }) });
  } catch (err) { sendError(res, err, 404); }
});

app.delete("/api/playlists/:id", (req, res) => {
  try { res.json({ ok: true, playlist: deletePlaylist(req.params.id) }); }
  catch (err) { sendError(res, err, 404); }
});

app.post("/api/playlists/:id/tracks", (req, res) => {
  try { res.json({ ok: true, playlist: addTrack(req.params.id, req.body || {}) }); }
  catch (err) { sendError(res, err, 400); }
});

app.delete("/api/playlists/:id/tracks/:trackId", (req, res) => {
  try { res.json({ ok: true, playlist: removeTrack(req.params.id, req.params.trackId) }); }
  catch (err) { sendError(res, err, 404); }
});

app.patch("/api/playlists/:id/tracks/:trackId/reorder", (req, res) => {
  try {
    const { position } = req.body || {};
    if (position === undefined) return sendError(res, new Error("position is required"), 400);
    res.json({ ok: true, playlist: reorderTrack(req.params.id, req.params.trackId, position) });
  } catch (err) { sendError(res, err, 404); }
});

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Resonance listening on http://localhost:${PORT}`);
});