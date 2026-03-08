import { spawn, spawnSync } from "child_process";
import { createConnection } from "net";
import { setTimeout as delay } from "timers/promises";
import { EventEmitter } from "events";
import fs from "fs";

// ── Player event emitter — server.js subscribes for SSE push ──────────────
export const playerEvents = new EventEmitter();
playerEvents.setMaxListeners(50);

const IPC_PIPE = process.platform === "win32" ? "\\\\.\\pipe\\copilot-music" : "/tmp/copilot-music.sock";

const YT_CANDIDATES = [
  "yt-dlp",
  "yt-dlp.exe",
  "C:\\Users\\ASUS TUF\\AppData\\Roaming\\Python\\Python313\\Scripts\\yt-dlp.exe",
  "C:\\Users\\ASUS TUF\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe",
  "C:\\Users\\ASUS TUF\\AppData\\Local\\Microsoft\\WindowsApps\\yt-dlp.exe"
];
const MPV_CANDIDATES = [
  "mpv",
  "mpv.exe",
  "C:\\Users\\ASUS TUF\\AppData\\Local\\Microsoft\\WindowsApps\\mpv.exe"
];

function resolveBinary(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    const res = spawnSync(candidate, ["--version"], { windowsHide: true, stdio: "ignore" });
    if (res.status === 0) return candidate;
  }
  return null;
}

const YT_CMD = resolveBinary(YT_CANDIDATES);
const MPV_CMD = resolveBinary(MPV_CANDIDATES);
console.log(`[startup] yt-dlp: ${YT_CMD}`);
console.log(`[startup] mpv: ${MPV_CMD}`);

const YTSEARCH_MAX = 30;

let playerProcess = null;
let ipcClient = null;
let state = "idle";
let lastUrl = null;
let lastMeta = null;

// Caches
const urlCache = new Map();
const metaCache = new Map();
const searchCache = new Map();
const CACHE_MS = 5 * 60 * 1000;

let requestId = 0;
let pendingPlayRequest = null;
let currentEq = "";

function assertDeps() {
  if (!YT_CMD) throw new Error("yt-dlp not found. Ensure it is on PATH or installed via winget.");
  if (!MPV_CMD) throw new Error("mpv not found. Ensure it is on PATH or installed via winget.");
}

function isUrl(text) {
  return /^https?:\/\//i.test(text);
}

function runJson(args, errorMessage) {
  if (!YT_CMD) throw new Error("yt-dlp not found");
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const proc = spawn(YT_CMD, ["--ignore-config", "--no-warnings", ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout.on("data", d => chunks.push(d));
    proc.stderr.on("data", d => errChunks.push(d));
    proc.on("error", err => reject(err));
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(Buffer.concat(errChunks).toString() || errorMessage));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(new Error(errorMessage)); }
    });
  });
}

function pickEntry(data) {
  if (!data) return null;
  if (Array.isArray(data.entries) && data.entries.length > 0) return data.entries.find(Boolean);
  return data;
}

function normalizeMeta(entry) {
  if (!entry) return null;
  const thumbnail =
    (Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0
      ? entry.thumbnails[entry.thumbnails.length - 1].url
      : null) || entry.thumbnail;
  const durationSeconds = typeof entry.duration === "number" ? entry.duration : null;
  // Compute a readable duration string if yt-dlp didn't provide one
  let durationStr = entry.duration_string || null;
  if (!durationStr && durationSeconds != null) {
    const s = Math.max(0, Math.round(durationSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    durationStr = h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
      : `${m}:${String(sec).padStart(2,'0')}`;
  }
  return {
    id: entry.id,
    title: entry.title,
    uploader: entry.uploader || entry.channel || "",
    duration: durationStr,
    durationSeconds,
    thumbnail,
    webpageUrl: entry.webpage_url || entry.url
  };
}

async function resolveUrl(target) {
  if (!YT_CMD) throw new Error("yt-dlp not found");
  const cached = urlCache.get(target);
  if (cached && Date.now() - cached.t < CACHE_MS) return cached.v;
  return new Promise((resolve, reject) => {
    const chunks = [], errChunks = [];
    const proc = spawn(YT_CMD, ["--ignore-config", "--no-warnings", "-f", "bestaudio/best", "--get-url", target], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout.on("data", d => chunks.push(d));
    proc.stderr.on("data", d => errChunks.push(d));
    proc.on("error", err => reject(err));
    proc.on("close", code => {
      const out = Buffer.concat(chunks).toString().trim();
      if (code !== 0 || !out) return reject(new Error(Buffer.concat(errChunks).toString() || "Unable to resolve stream URL via yt-dlp"));
      const url = out.split("\n")[0].trim();
      urlCache.set(target, { t: Date.now(), v: url });
      resolve(url);
    });
  });
}

async function getMetadata(target) {
  const cached = metaCache.get(target);
  if (cached && Date.now() - cached.t < CACHE_MS) return cached.v;
  const data = await runJson(["-J", target], "Unable to fetch metadata via yt-dlp");
  const entry = pickEntry(data);
  const meta = normalizeMeta(entry);
  if (!meta) throw new Error("No metadata found");
  metaCache.set(target, { t: Date.now(), v: meta });
  return meta;
}

function cleanupIpc() {
  if (ipcClient) {
    try { ipcClient.destroy(); } catch {}
    ipcClient = null;
  }
}

function killMpvProcesses() {
  // Only kill the mpv process we spawned, not all system mpv instances
  if (playerProcess && !playerProcess.killed) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(playerProcess.pid), "/F", "/T"], { windowsHide: true, stdio: "ignore" });
      } else {
        try { process.kill(playerProcess.pid, "SIGKILL"); } catch {}
      }
    } catch {}
  }
}

function removeIpcSocket() {
  if (process.platform !== "win32") {
    try { if (fs.existsSync(IPC_PIPE)) fs.unlinkSync(IPC_PIPE); } catch {}
  }
}

async function forceStopPlayer() {
  pendingPlayRequest = null;

  const proc = playerProcess;
  playerProcess = null;

  if (proc) {
    // Save PID before any cleanup — killMpvProcesses needs it
    const pid = proc.pid;
    try {
      if (process.platform === "win32" && pid) {
        spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], { windowsHide: true, stdio: "ignore" });
      } else {
        try { proc.kill("SIGKILL"); } catch {}
      }
    } catch {}
    // Give OS time to release the named pipe
    await delay(150);
  }

  cleanupIpc();
  removeIpcSocket();

  state = "idle";
  lastUrl = null;
  lastMeta = null;
}

async function connectIpc(retries = 20) {
  // If already connected, reuse — never tear down a working connection
  if (ipcClient && !ipcClient.destroyed) return;
  cleanupIpc();
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const client = createConnection(IPC_PIPE, () => {
          ipcClient = client;
          ipcClient.setEncoding("utf8");
          // Auto-cleanup if mpv closes the socket
          ipcClient.once("close", () => { if (ipcClient === client) { ipcClient = null; } });
          resolve();
        });
        client.once("error", reject);
      });
      return; // connected
    } catch {
      await delay(100);
    }
  }
  throw new Error("Could not connect to mpv IPC server");
}

const ipcQueue = [];
let ipcProcessing = false;

function sendMpv(cmd, expectResponse = false) {
  return new Promise((resolve, reject) => {
    ipcQueue.push({ cmd, expectResponse, resolve, reject });
    _drainIpc();
  });
}

async function _drainIpc() {
  if (ipcProcessing || ipcQueue.length === 0) return;
  ipcProcessing = true;
  const { cmd, expectResponse, resolve, reject } = ipcQueue.shift();
  try {
    resolve(await _rawSend(cmd, expectResponse));
  } catch (err) {
    reject(err);
  } finally {
    ipcProcessing = false;
    _drainIpc();
  }
}

async function _rawSend(cmd, expectResponse) {
  // Ensure connected — reuses existing socket if alive
  if (!ipcClient || ipcClient.destroyed) await connectIpc();
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const payload = { ...cmd, request_id: id };
    let timer;
    let buf = "";
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ipcClient?.off("error", onErr);
      ipcClient?.off("end", onEnd);
      if (expectResponse) ipcClient?.off("data", onData);
    };
    const onErr = e => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error("IPC connection closed")); };
    const onData = chunk => {
      buf += chunk.toString();
      // mpv sends newline-delimited JSON — handle partial reads
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.request_id === id) { cleanup(); resolve(obj); return; }
        } catch {}
      }
    };
    ipcClient.once("error", onErr);
    ipcClient.once("end", onEnd);
    if (expectResponse) ipcClient.on("data", onData);
    ipcClient.write(`${JSON.stringify(payload)}\n`, err => {
      if (err) { cleanup(); reject(err); return; }
      if (!expectResponse) { cleanup(); resolve(null); }
      else { timer = setTimeout(() => { cleanup(); reject(new Error("mpv IPC timeout")); }, 2000); }
    });
  });
}

// ── Pre-resolve cache for next-track prefetch ─────────────────────────────
// Key: the exact string play() will use as `target` — either a full URL or "ytsearch1:ID"
const prefetchCache = new Map();

// Normalize a YouTube video ID or URL to the same target key play() produces
function normalizeTarget(input) {
  if (!input) return null;
  if (isUrl(input)) return input;
  // Strip any existing ytsearch prefix
  const id = input.replace(/^ytsearch\d+:/, '').trim();
  // 11-char YouTube IDs get turned into full URLs (avoids ytsearch inside mpv)
  if (/^[A-Za-z0-9_-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
  return `ytsearch1:${id}`;
}

export async function prefetchNext(input) {
  if (!input || !YT_CMD) return;
  const target = normalizeTarget(input);
  if (!target) return;

  // Don't double-fetch — also skip if already cached fresh
  const cached = metaCache.get(target);
  const alreadyPrefetched = prefetchCache.get(target);
  if (alreadyPrefetched && alreadyPrefetched.streamUrl) return; // fully cached
  if (cached && Date.now() - cached.t < CACHE_MS && alreadyPrefetched) return;

  prefetchCache.set(target, null); // Mark in-progress
  try {
    // Fetch metadata and resolve stream URL in parallel for speed
    const [meta, streamUrl] = await Promise.all([
      (cached && Date.now() - cached.t < CACHE_MS) ? cached.v : getMetadata(target),
      resolveUrl(target).catch(() => null)
    ]);
    prefetchCache.set(target, { meta, streamUrl, t: Date.now() });
    metaCache.set(target, { t: Date.now(), v: meta });
    console.log(`[prefetch] cached next track: ${meta?.title || target}${streamUrl ? ' (stream ready)' : ''}`);
  } catch {
    prefetchCache.delete(target);
  }
}

function consumePrefetch(target) {
  const hit = prefetchCache.get(target);
  if (hit && Date.now() - hit.t <= 4 * 60 * 1000) {
    prefetchCache.delete(target);
    return hit; // { meta, streamUrl, t }
  }
  if (hit) prefetchCache.delete(target);
  // Fall back to metaCache only (no stream URL)
  const mc = metaCache.get(target);
  if (mc && Date.now() - mc.t < CACHE_MS) return { meta: mc.v, streamUrl: null, t: mc.t };
  return null;
}
function spawnPlayer(ytUrl) {
  // Pass the YouTube URL directly to mpv — it uses yt-dlp internally to stream.
  // This eliminates the separate resolveUrl (--get-url) step entirely.
  // mpv spawns yt-dlp itself with optimal streaming args, which is faster than
  // doing it manually because it can start buffering while metadata loads.
  const args = [
    "--no-video",
    "--force-window=no",
    "--idle=no",
    `--input-ipc-server=${IPC_PIPE}`,
    "--really-quiet",
    `--script-opts=ytdl_hook-ytdl_path=${YT_CMD}`,
    ytUrl
  ];
  if (currentEq) {
    args.push(`--af=${currentEq}`);
  }
  if (!MPV_CMD) throw new Error("mpv not found");
  const proc = spawn(MPV_CMD, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  proc.on("exit", (code) => {
    if (playerProcess === proc) {
      state = "idle";
      lastUrl = null;
      lastMeta = null;
      cleanupIpc();
      playerProcess = null;
      playerEvents.emit("track-ended", { code });
    }
  });
  proc.stderr?.on("data", () => {});
  return proc;
}

let lastPlayRequest = { target: null, time: 0 };

export async function play(input) {
  assertDeps();
  const target = normalizeTarget(input);
  if (!target) throw new Error("Invalid input");

  const requestTimestamp = Date.now();
  if (lastPlayRequest.target === target && requestTimestamp - lastPlayRequest.time < 1000) {
    return { status: state, url: target, backend: "mpv+yt-dlp", meta: lastMeta };
  }
  lastPlayRequest = { target, time: requestTimestamp };

  if (pendingPlayRequest) pendingPlayRequest.cancelled = true;
  const currentRequest = { cancelled: false, timestamp: requestTimestamp };
  pendingPlayRequest = currentRequest;

  await forceStopPlayer();
  await delay(40);

  let meta = null;
  let cachedStreamUrl = null;
  try {
    // consumePrefetch checks both prefetchCache and metaCache — instant if prefetched
    const prefetched = consumePrefetch(target);
    if (prefetched) {
      meta = prefetched.meta;
      cachedStreamUrl = prefetched.streamUrl || null;
    } else {
      meta = await getMetadata(target);
    }
    if (currentRequest.cancelled) return { status: "cancelled", url: null, backend: "mpv+yt-dlp", meta: null };
  } catch (e) {
    console.warn("[play] metadata fetch failed, playing without meta:", e.message);
  }

  if (playerProcess) { await forceStopPlayer(); await delay(20); }
  if (currentRequest.cancelled) return { status: "cancelled", url: null, backend: "mpv+yt-dlp", meta: null };

  // Use pre-resolved stream URL if available (skips yt-dlp inside mpv),
  // otherwise fall back to the canonical webpage URL
  const playUrl = cachedStreamUrl || meta?.webpageUrl || target;
  if (cachedStreamUrl) console.log("[play] using prefetched stream URL — instant start");

  const proc = spawnPlayer(playUrl);
  playerProcess = proc;
  lastUrl = playUrl;
  lastMeta = meta;
  state = "playing";
  pendingPlayRequest = null;
  playerEvents.emit("track-started", { meta });

  // Connect IPC eagerly so EQ/volume commands work immediately
  connectIpc(20).catch(() => {});

  await delay(40);
  return { status: state, url: playUrl, backend: "mpv+yt-dlp", meta };
}

export async function pause() {
  try {
    await sendMpv({ command: ["set_property", "pause", true] });
    state = "paused";
    return { status: state, url: lastUrl, meta: lastMeta };
  } catch {
    throw new Error("Nothing is playing");
  }
}

export async function resume() {
  try {
    await sendMpv({ command: ["set_property", "pause", false] });
    state = "playing";
    return { status: state, url: lastUrl, meta: lastMeta };
  } catch {
    throw new Error("Nothing is playing");
  }
}

export async function stop() {
  const url = lastUrl;
  const meta = lastMeta;

  if (pendingPlayRequest) { pendingPlayRequest.cancelled = true; pendingPlayRequest = null; }

  const proc = playerProcess;
  playerProcess = null; // Clear immediately to prevent exit handler from emitting track-ended

  // Try graceful IPC quit first, before killing the process
  try { await sendMpv({ command: ["quit"] }); } catch {}

  if (proc) {
    try {
      proc.kill("SIGTERM");
      await delay(20);
      if (proc && !proc.killed) proc.kill("SIGKILL");
    } catch {}
  }

  cleanupIpc();
  removeIpcSocket();
  killMpvProcesses();

  state = "idle";
  lastUrl = null;
  lastMeta = null;

  return { status: state, url, meta };
}

export async function seek(seconds) {
  if (seconds === undefined || seconds === null) throw new Error("Seek value required");
  if (!playerProcess) throw new Error("Nothing is playing");
  try {
    await sendMpv({ command: ["set_property", "time-pos", Number(seconds)] });
  } catch {
    throw new Error("Player not ready yet");
  }
  return { status: state, url: lastUrl, meta: lastMeta, position: seconds };
}

export async function setVolume(level) {
  const vol = Math.max(0, Math.min(100, Number(level)));
  if (Number.isNaN(vol)) throw new Error("Volume must be a number 0-100");
  // If nothing is playing, just acknowledge without error — UI stays responsive
  if (!playerProcess) return { status: state, url: lastUrl, meta: lastMeta, volume: vol };
  // If IPC isn't ready yet (mpv still starting), acknowledge silently
  try {
    await sendMpv({ command: ["set_property", "volume", vol] });
  } catch {
    // IPC not connected yet — non-fatal, mpv will use its default volume
  }
  return { status: state, url: lastUrl, meta: lastMeta, volume: vol };
}

export async function getStatus() {
  let position = null;
  let duration = lastMeta?.durationSeconds ?? null;

  if (playerProcess) {
    // Ensure IPC is connected — retry if previous connect failed
    if (!ipcClient || ipcClient.destroyed) {
      try { await connectIpc(10); } catch {}
    }
    if (ipcClient && !ipcClient.destroyed) {
      try {
        const [posResp, durResp] = await Promise.all([
          sendMpv({ command: ["get_property", "time-pos"] }, true).catch(() => null),
          sendMpv({ command: ["get_property", "duration"] }, true).catch(() => null),
        ]);
        if (typeof posResp?.data === "number") position = posResp.data;
        if (typeof durResp?.data === "number" && durResp.data > 0) {
          duration = durResp.data;
          // Keep lastMeta duration in sync with what mpv actually reports
          if (lastMeta) lastMeta.durationSeconds = duration;
        }
      } catch {}
    }
  }

  // Cap position at duration to prevent overrun display
  if (position !== null && duration !== null) {
    position = Math.min(position, duration);
  }

  return {
    status: state,
    url: lastUrl,
    backend: playerProcess ? "mpv+yt-dlp" : null,
    meta: lastMeta,
    position,
    durationSeconds: duration
  };
}

export async function search(query, limit = 30) {
  if (!query?.trim()) throw new Error("Search query is required");

  // Use ytsearch{N}: standard YouTube search, universally supported.
  const safeLimit = Math.min(limit, YTSEARCH_MAX);
  const key = `${safeLimit}:${query}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.t < CACHE_MS) return cached.v;

  const data = await runJson(
    ["-J", "--skip-download", "--flat-playlist", `ytsearch${safeLimit}:${query}`],
    "Unable to search via yt-dlp"
  );
  const entries = Array.isArray(data.entries) ? data.entries : [];

  // Words that strongly indicate non-original content
  const JUNK_PATTERN = /\b(reaction|reacts?|reacting|review|cover|covered|covers|compilation|mix(?:ed)?|mashup|parody|tribute|responds?|karaoke|tutorial|how to|lesson|drum|bass|guitar|piano|violin)\b/i;

  const results = entries
    .filter(Boolean)
    .map(entry => {
      const meta = normalizeMeta(entry);
      return {
        id: meta?.id,
        title: meta?.title,
        uploader: meta?.uploader,
        duration: meta?.duration,
        durationSeconds: meta?.durationSeconds,
        thumbnail: meta?.thumbnail,
        webpageUrl: meta?.webpageUrl
      };
    })
    .filter(item => {
      if (!item.id || !item.title) return false;
      const dur = item.durationSeconds;
      if (dur != null && (dur < 20 || dur > 1800)) return false;
      // Deprioritize (but don't hard-remove) junk titles — we'll sort them to the end
      return true;
    })
    .sort((a, b) => {
      // Push junk results to the bottom, keep originals at top
      const aJunk = JUNK_PATTERN.test(a.title || '');
      const bJunk = JUNK_PATTERN.test(b.title || '');
      return aJunk - bJunk;
    })
    .slice(0, limit);

  searchCache.set(key, { t: Date.now(), v: results });
  return results;
}

export async function related(title, uploader, limit = 8) {
  if (!YT_CMD) throw new Error("yt-dlp not found");

  const seenTitles = new Set([title.toLowerCase()]);
  const seenUploaders = new Map(); // uploader → count, cap at 2 per artist

  const cleanTitle = title.replace(/\(.*?\)|\[.*?\]|official|video|audio|lyrics|hd|4k/gi, "").trim();
  const genreKeywords = extractGenreKeywords(title);

  // Build targeted queries
  const queries = [];
  if (uploader) queries.push({ q: `${uploader} music`, weight: 3, type: 'artist' });
  if (genreKeywords.length) queries.push({ q: genreKeywords.slice(0, 2).join(" ") + " music", weight: 2, type: 'genre' });
  queries.push({ q: cleanTitle.substring(0, 40), weight: 1, type: 'similar' });
  if (uploader && genreKeywords.length) queries.push({ q: `${uploader} ${genreKeywords[0]}`, weight: 2, type: 'artist-genre' });

  const fetchCount = Math.min(limit + 8, YTSEARCH_MAX);
  const rawResults = await Promise.allSettled(
    queries.map(({ q }) => search(q, fetchCount))
  ).then(rs => rs.map((r, i) => ({ results: r.status === "fulfilled" ? r.value : [], weight: queries[i].weight })));

  // Score and deduplicate
  const scored = new Map(); // id → { item, score }
  for (const { results, weight } of rawResults) {
    for (const item of results) {
      if (!item.id || !item.title) continue;
      const titleKey = item.title.toLowerCase();
      if (seenTitles.has(titleKey)) continue;

      if (scored.has(item.id)) {
        scored.get(item.id).score += weight * 0.5; // Boost items appearing in multiple queries
      } else {
        scored.set(item.id, { item, score: weight });
      }
    }
  }

  // Sort by score, then cap artists at 2 results each for variety
  const sorted = [...scored.values()].sort((a, b) => b.score - a.score);
  const final = [];
  for (const { item } of sorted) {
    const uploaderKey = (item.uploader || '').toLowerCase();
    const uploaderCount = seenUploaders.get(uploaderKey) || 0;
    if (uploaderCount >= 2) continue; // Max 2 songs per artist
    const titleKey = item.title.toLowerCase();
    if (seenTitles.has(titleKey)) continue;
    seenTitles.add(titleKey);
    seenUploaders.set(uploaderKey, uploaderCount + 1);
    final.push(item);
    if (final.length >= limit) break;
  }

  return final;
}

function extractGenreKeywords(title) {
  if (!title) return [];
  const keywords = [];
  const lowerTitle = title.toLowerCase();
  const genres = [
    "rock", "pop", "jazz", "classical", "hip hop", "rap", "r&b", "rnb",
    "country", "folk", "blues", "reggae", "electronic", "edm", "house",
    "techno", "dubstep", "trap", "soul", "funk", "disco", "punk",
    "metal", "indie", "alternative", "ambient", "lofi", "lo-fi", "chill",
    "acoustic", "instrumental", "vocal", "remix", "cover", "live",
    "orchestral", "piano", "guitar", "violin", "drums", "bass",
    "ballad", "upbeat", "sad", "happy", "relaxing", "energetic",
    "dance", "synthwave", "vaporwave", "soundtrack", "ost", "anime",
    "k-pop", "kpop", "j-pop", "jpop", "latin", "spanish", "french"
  ];
  for (const genre of genres) {
    if (lowerTitle.includes(genre)) keywords.push(genre);
  }
  const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) keywords.push((Math.floor(parseInt(yearMatch[1]) / 10) * 10) + "s");
  return keywords;
}

export async function setEq(afString) {
  currentEq = afString || ""; // Always save for future spawns

  if (!playerProcess) {
    // No player running — saved above, will apply on next spawn via --af=
    return { status: state, af: afString || '', skipped: true, reason: 'no player' };
  }

  // Ensure IPC is connected — mpv may still be starting up
  try {
    if (!ipcClient) await connectIpc(25); // 25 × 80ms = 2s max wait
  } catch (err) {
    console.error("[eq] IPC not ready:", err.message);
    return { status: state, af: afString || '', skipped: true, reason: 'IPC not ready' };
  }

  try {
    if (!afString || afString.trim() === '') {
      await sendMpv({ command: ["af", "clr", ""] });
    } else {
      await sendMpv({ command: ["af", "set", afString] });
    }
    return { status: state, af: afString || '' };
  } catch (err) {
    console.error("[eq] Failed to apply EQ:", err.message);
    return { status: state, af: afString || '', skipped: true, reason: err.message };
  }
}