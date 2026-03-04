import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { play, pause, resume, stop, setVolume, getStatus, search, seek, related, prefetchNext, playerEvents } from "./player.js";
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

    // Exclude `position` from ETag — it changes every second and would defeat caching.
    // We only want 304 when the track, status, and duration haven't changed.
    const { position: _pos, ...etagResult } = result;
    const etagJson = JSON.stringify({ ok: true, result: etagResult });

    if (etagJson !== lastStatusJson) {
      lastStatusJson = etagJson;
      lastStatusETag = `"${Date.now().toString(36)}"`;
    }

    res.setHeader("ETag", lastStatusETag);
    res.setHeader("Cache-Control", "no-store");

    if (req.headers["if-none-match"] === lastStatusETag) {
      return res.status(304).end();
    }

    const json = JSON.stringify({ ok: true, result });
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

// ── SSE: push track-ended instantly so frontend advances queue without polling lag ──
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders();

  // Send a heartbeat every 25s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 25000);

  const onTrackEnded = () => {
    if (!res.writableEnded) res.write(`event: track-ended\ndata: {}\n\n`);
  };
  const onTrackStarted = (data) => {
    if (!res.writableEnded) res.write(`event: track-started\ndata: ${JSON.stringify(data)}\n\n`);
  };

  playerEvents.on("track-ended", onTrackEnded);
  playerEvents.on("track-started", onTrackStarted);

  req.on("close", () => {
    clearInterval(heartbeat);
    playerEvents.off("track-ended", onTrackEnded);
    playerEvents.off("track-started", onTrackStarted);
  });
});

// ── Prefetch: pre-resolve URL+meta for next track while current one plays ──
app.post("/api/prefetch", async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.json({ ok: true, skipped: true });
    // Fire-and-forget — don't await, just start the background resolution
    prefetchNext(id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true, skipped: true }); // Prefetch failures are always non-fatal
  }
});

// Lyrics proxy endpoint — tries lrclib exact, lrclib search, then lyrics.ovh
app.get("/api/lyrics", async (req, res) => {
  try {
    const title = req.query.title || req.query.track || "";
    const artist = req.query.artist || req.query.uploader || "";
    if (!title) return sendError(res, new Error("title query param required"), 400);

    // 1. lrclib exact GET (fastest, most accurate)
    try {
      const r = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`);
      if (r.ok) {
        const d = await r.json();
        if (d.syncedLyrics) return res.json({ ok: true, source: 'lrclib-synced', lyrics: d.syncedLyrics });
        if (d.plainLyrics)  return res.json({ ok: true, source: 'lrclib', lyrics: d.plainLyrics });
      }
    } catch {}

    // 2. lrclib fuzzy search (handles messy YouTube titles)
    try {
      const q = encodeURIComponent(`${artist} ${title}`.trim());
      const r = await fetch(`https://lrclib.net/api/search?q=${q}`);
      if (r.ok) {
        const data = await r.json();
        if (Array.isArray(data) && data.length) {
          const best = data.find(t => t.syncedLyrics) || data.find(t => t.plainLyrics);
          if (best) {
            const lyrics = best.syncedLyrics || best.plainLyrics;
            return res.json({ ok: true, source: best.syncedLyrics ? 'lrclib-synced' : 'lrclib', lyrics });
          }
        }
      }
    } catch {}

    // 3. lyrics.ovh fallback
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

app.post("/api/queue/sync", (req, res) => {
  try {
    const { queue } = req.body || {};
    if (!Array.isArray(queue)) return sendError(res, new Error('queue array is required'), 400);
    serverQueue = queue;
    res.json({ ok: true, queue: serverQueue });
  } catch (err) { sendError(res, err); }
});

app.post("/api/queue/reorder", (req, res) => {
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