import { spawn, spawnSync } from "child_process";
import { createConnection } from "net";
import { setTimeout as delay } from "timers/promises";
import fs from "fs";

const IPC_PIPE = process.platform === "win32" ? "\\\\.\\pipe\\copilot-music" : "/tmp/copilot-music.sock";
const YT_CANDIDATES = [
  "yt-dlp",
  "yt-dlp.exe",
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
    const res = spawnSync(candidate, ["--version"], { windowsHide: true, stdio: "ignore" });
    if (res.status === 0) return candidate;
  }
  return null;
}

const YT_CMD = resolveBinary(YT_CANDIDATES);
const MPV_CMD = resolveBinary(MPV_CANDIDATES);

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
  return {
    id: entry.id,
    title: entry.title,
    uploader: entry.uploader,
    duration: entry.duration_string || entry.duration,
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

// Kill any running mpv processes on the OS level.
// On Windows this is slow (~150ms) so we only do it when strictly needed.
function killMpvProcesses() {
  try {
    if (process.platform === "win32") {
      try { spawnSync("taskkill", ["/IM", "mpv.exe", "/F", "/T"], { windowsHide: true, stdio: "ignore" }); } catch {}
      try { spawnSync("taskkill", ["/IM", "mpv-console-launcher.exe", "/F", "/T"], { windowsHide: true, stdio: "ignore" }); } catch {}
    } else {
      try { spawnSync("pkill", ["-9", "-f", "mpv"], { stdio: "ignore" }); } catch {}
    }
  } catch {}
}

function removeIpcSocket() {
  if (process.platform !== "win32") {
    try { if (fs.existsSync(IPC_PIPE)) fs.unlinkSync(IPC_PIPE); } catch {}
  }
}

async function forceStopPlayer() {
  pendingPlayRequest = null;

  if (playerProcess) {
    const proc = playerProcess;
    playerProcess = null; // clear reference first
    try {
      proc.kill("SIGTERM");
      // Give it a very short window to exit gracefully
      await delay(30);
      if (!proc.killed) proc.kill("SIGKILL");
    } catch {}
  }

  cleanupIpc();

  // Only call the OS-level kill if we know mpv might be orphaned
  // (i.e. playerProcess reference was already null when we got here,
  // suggesting a previous crash left a zombie).
  // For normal stop flows the SIGKILL above is sufficient.
  if (state !== "idle") {
    killMpvProcesses();
  }

  removeIpcSocket();

  state = "idle";
  lastUrl = null;
  lastMeta = null;
}

async function connectIpc(retries = 12) {
  cleanupIpc();
  for (let i = 0; i < retries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const client = createConnection(IPC_PIPE, () => {
          ipcClient = client;
          ipcClient.setEncoding("utf8");
          resolve();
        });
        client.on("error", reject);
      });
      return;
    } catch {
      await delay(80);
    }
  }
  throw new Error("Could not connect to mpv IPC server");
}

/* IPC command queue – serialises access */
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
    cleanupIpc();
    try { resolve(await _rawSend(cmd, expectResponse)); }
    catch { reject(err); }
  } finally {
    ipcProcessing = false;
    _drainIpc();
  }
}

async function _rawSend(cmd, expectResponse) {
  if (!ipcClient) await connectIpc();
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const payload = { ...cmd, request_id: id };
    let timer;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      ipcClient?.off("error", onErr);
      ipcClient?.off("end", onEnd);
      if (expectResponse) ipcClient?.off("data", onData);
    };
    const onErr = e => { cleanup(); cleanupIpc(); reject(e); };
    const onEnd = ()  => { cleanup(); cleanupIpc(); reject(new Error("IPC connection closed")); };
    const onData = chunk => {
      for (const line of chunk.toString().trim().split("\n")) {
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
      if (err) { cleanup(); reject(err); }
      else if (!expectResponse) { cleanup(); resolve(); }
      else { timer = setTimeout(() => { cleanup(); reject(new Error("mpv response timeout")); }, 1000); }
    });
  });
}

function spawnPlayer(url) {
  const args = [
    "--no-video",
    "--force-window=no",
    "--idle=no",
    `--input-ipc-server=${IPC_PIPE}`,
    "--really-quiet",
    url
  ];
  if (!MPV_CMD) throw new Error("mpv not found");
  const proc = spawn(MPV_CMD, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  proc.on("exit", () => {
    if (playerProcess === proc) {
      state = "idle";
      lastUrl = null;
      lastMeta = null;
      cleanupIpc();
      playerProcess = null;
    }
  });
  proc.stderr?.on("data", () => {});
  return proc;
}

let lastPlayRequest = { target: null, time: 0 };

export async function play(input) {
  assertDeps();
  const target = isUrl(input) ? input : `ytmsearch1:${input}`;

  const requestTimestamp = Date.now();

  // Debounce repeated identical requests within 1s
  if (lastPlayRequest.target === target && requestTimestamp - lastPlayRequest.time < 1000) {
    return { status: state, url: lastUrl, backend: "mpv+yt-dlp", meta: lastMeta };
  }
  lastPlayRequest = { target, time: requestTimestamp };

  // Cancel any in-flight play
  if (pendingPlayRequest) pendingPlayRequest.cancelled = true;
  const currentRequest = { cancelled: false, timestamp: requestTimestamp };
  pendingPlayRequest = currentRequest;

  // Stop existing player
  await forceStopPlayer();
  await delay(40);

  // Fetch URL + metadata in parallel
  let url, meta;
  try {
    [url, meta] = await Promise.all([resolveUrl(target), getMetadata(target)]);
    if (currentRequest.cancelled) return { status: "cancelled", url: null, backend: "mpv+yt-dlp", meta: null };
  } catch (e) {
    state = "idle";
    pendingPlayRequest = null;
    throw e;
  }

  // Final guard
  if (playerProcess) { await forceStopPlayer(); await delay(20); }
  if (currentRequest.cancelled) return { status: "cancelled", url: null, backend: "mpv+yt-dlp", meta: null };

  const proc = spawnPlayer(url);
  playerProcess = proc;
  lastUrl = url;
  lastMeta = meta;
  state = "playing";
  pendingPlayRequest = null;

  await delay(40);
  return { status: state, url, backend: "mpv+yt-dlp", meta };
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

  if (playerProcess) {
    try {
      playerProcess.kill("SIGTERM");
      await delay(20);
      if (playerProcess && !playerProcess.killed) playerProcess.kill("SIGKILL");
    } catch {}
    playerProcess = null;
  }

  try { await sendMpv({ command: ["quit"] }); } catch {}

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
  await sendMpv({ command: ["set_property", "time-pos", Number(seconds)] });
  return { status: state, url: lastUrl, meta: lastMeta, position: seconds };
}

export async function setVolume(level) {
  if (!playerProcess) throw new Error("Nothing is playing");
  const vol = Math.max(0, Math.min(100, Number(level)));
  if (Number.isNaN(vol)) throw new Error("Volume must be a number 0-100");
  await sendMpv({ command: ["set_property", "volume", vol] });
  return { status: state, url: lastUrl, meta: lastMeta, volume: vol };
}

export async function getStatus() {
  let position = null;
  try {
    const posResp = await sendMpv({ command: ["get_property", "time-pos"] }, true);
    if (typeof posResp?.data === "number") position = posResp.data;
  } catch {}
  return {
    status: state,
    url: lastUrl,
    backend: playerProcess ? "mpv+yt-dlp" : null,
    meta: lastMeta,
    position,
    durationSeconds: lastMeta?.durationSeconds ?? null
  };
}

export async function search(query, limit = 30) {
  if (!query?.trim()) throw new Error("Search query is required");
  const key = `${limit}:${query}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.t < CACHE_MS) return cached.v;

  // ytmsearch uses YouTube Music — results are music tracks, not general videos.
  // Fetch extra so we still have `limit` results after duration filtering.
  const fetchCount = Math.min(limit * 2, 100);
  const data = await runJson(
    ["-J", "--skip-download", "--flat-playlist", `ytmsearch${fetchCount}:${query}`],
    "Unable to search via yt-dlp"
  );
  const entries = Array.isArray(data.entries) ? data.entries : [];
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
      // Drop clips shorter than 30s (ads) or longer than 12 min (live sets / movies)
      const dur = item.durationSeconds;
      if (dur != null && (dur < 30 || dur > 720)) return false;
      return true;
    })
    .slice(0, limit);

  searchCache.set(key, { t: Date.now(), v: results });
  return results;
}

export async function related(title, uploader, limit = 8) {
  if (!YT_CMD) throw new Error("yt-dlp not found");

  const seen = new Set([title.toLowerCase()]);

  // Build all three queries
  const cleanTitle = title.replace(/\(.*?\)|\[.*?\]|official|video|audio|lyrics|hd|4k/gi, "").trim();
  const genreKeywords = extractGenreKeywords(title);
  const genreQuery = genreKeywords.length > 0
    ? genreKeywords.slice(0, 3).join(" ") + " music"
    : null;

  // Fire all searches in parallel instead of serial
  const queries = [
    uploader ? search(uploader, Math.ceil(limit * 0.4) + 3) : Promise.resolve([]),
    genreQuery ? search(genreQuery, Math.ceil(limit * 0.4) + 5) : Promise.resolve([]),
    search(cleanTitle.substring(0, 40), limit + 5)
  ];

  const [artistResults, genreResults, similarResults] = await Promise.allSettled(queries).then(
    results => results.map(r => (r.status === "fulfilled" ? r.value : []))
  );

  const allResults = [];
  for (const item of [...artistResults, ...genreResults, ...similarResults]) {
    if (item.title && !seen.has(item.title.toLowerCase())) {
      allResults.push(item);
      seen.add(item.title.toLowerCase());
    }
  }

  shuffleArray(allResults);
  return allResults.slice(0, limit);
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
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

// Apply audio filter / equalizer via mpv IPC. `afString` should be a mpv af spec
// e.g. "equalizer=g=6" or "equalizer=f=250:g=-3:width_type=o:width=2"
export async function setEq(afString) {
  if (!afString) throw new Error('afString required');
  try {
    // mpv supports af operation via the IPC command: ["af", "add", "<spec>"]
    await sendMpv({ command: ["af", "add", afString] });
    return { status: state, af: afString };
  } catch (err) {
    throw new Error('Failed to apply EQ: ' + (err.message || err));
  }
}