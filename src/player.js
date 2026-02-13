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
const urlCache = new Map();
const URL_CACHE_MS = 5 * 60 * 1000;
const metaCache = new Map();
const searchCache = new Map();
const CACHE_MS = 5 * 60 * 1000;
let requestId = 0;
let pendingPlayRequest = null; // Track if there's a play operation in progress

function assertDeps() {
  if (!YT_CMD) {
    throw new Error("yt-dlp not found. Ensure it is on PATH or installed via winget.");
  }
  if (!MPV_CMD) {
    throw new Error("mpv not found. Ensure it is on PATH or installed via winget.");
  }
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
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => errChunks.push(d));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(errChunks).toString() || errorMessage));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(new Error(errorMessage)); }
    });
  });
}

function pickEntry(data) {
  if (!data) return null;
  if (Array.isArray(data.entries) && data.entries.length > 0) {
    return data.entries.find(Boolean);
  }
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
  if (cached && Date.now() - cached.t < URL_CACHE_MS) return cached.v;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const proc = spawn(YT_CMD, ["--ignore-config", "--no-warnings", "-f", "bestaudio/best", "--get-url", target], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout.on("data", (d) => chunks.push(d));
    proc.stderr.on("data", (d) => errChunks.push(d));
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
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
    try {
      ipcClient.destroy();
    } catch (err) {
      // Ignore cleanup errors
    }
    ipcClient = null;
  }
}

// Force kill any existing player process - synchronous and aggressive
async function forceStopPlayer() {
  // Clear any pending requests first
  pendingPlayRequest = null;
  
  // Kill the player process immediately
  if (playerProcess) {
    try {
      // Try graceful kill first
      playerProcess.kill("SIGTERM");
      // Wait a tiny bit
      await delay(20);
      // Force kill if still alive
      if (playerProcess && !playerProcess.killed) {
        playerProcess.kill("SIGKILL");
      }
      // Wait for process to actually die
      await delay(30);
    } catch (err) {
      // Ignore kill errors
    }
    playerProcess = null;
  }
  
  // Clean up IPC immediately
  cleanupIpc();

  // Aggressively kill any lingering mpv processes as a safety-net
  try {
    if (process.platform === "win32") {
      // taskkill will terminate mpv and its launcher if present
      try { spawnSync("taskkill", ["/IM", "mpv.exe", "/F", "/T"], { windowsHide: true, stdio: "ignore" }); } catch {}
      try { spawnSync("taskkill", ["/IM", "mpv-console-launcher.exe", "/F", "/T"], { windowsHide: true, stdio: "ignore" }); } catch {}
    } else {
      try { spawnSync("pkill", ["-f", "mpv"], { windowsHide: true, stdio: "ignore" }); } catch {}
    }
  } catch (err) {
    // ignore
  }
  
  // Try to remove the pipe file if it exists (Unix)
  if (process.platform !== "win32") {
    try {
      if (fs.existsSync(IPC_PIPE)) {
        fs.unlinkSync(IPC_PIPE);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }
  
  state = "idle";
  lastUrl = null;
  lastMeta = null;
}

async function connectIpc(retries = 10) {
  cleanupIpc();
  for (let i = 0; i < retries; i += 1) {
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
      await delay(100);
    }
  }
  throw new Error("Could not connect to mpv IPC server");
}

/* IPC command queue – serialises access to prevent race conditions */
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
    // reconnect and retry once
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
    const onErr  = (e) => { cleanup(); cleanupIpc(); reject(e); };
    const onEnd  = ()  => { cleanup(); cleanupIpc(); reject(new Error("IPC connection closed")); };
    const onData = (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        try {
          const obj = JSON.parse(line);
          if (obj.request_id === id) { cleanup(); resolve(obj); return; }
        } catch { /* skip */ }
      }
    };
    ipcClient.once("error", onErr);
    ipcClient.once("end", onEnd);
    if (expectResponse) ipcClient.on("data", onData);
    ipcClient.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (err) { cleanup(); reject(err); }
      else if (!expectResponse) { cleanup(); resolve(); }
      else { timer = setTimeout(() => { cleanup(); reject(new Error("mpv response timeout")); }, 800); }
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
    // Only reset state if this is still the active process
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
  const target = isUrl(input) ? input : `ytsearch1:${input}`;
  
  // Create a unique request ID to track this play request
  const requestTimestamp = Date.now();
  
  // Debounce repeated play requests for the same song within 1s
  if (lastPlayRequest.target === target && requestTimestamp - lastPlayRequest.time < 1000) {
    return { status: state, url: lastUrl, backend: "mpv+yt-dlp", meta: lastMeta };
  }
  lastPlayRequest = { target, time: requestTimestamp };
  
  // If there's already a play request in progress, cancel it
  if (pendingPlayRequest) {
    pendingPlayRequest.cancelled = true;
  }
  
  // Create a new play request tracker
  const currentRequest = { cancelled: false, timestamp: requestTimestamp };
  pendingPlayRequest = currentRequest;
  
  // CRITICAL: Force stop any existing player immediately and wait for it to die
  await forceStopPlayer();
  
  // Extra safety: wait a bit more to ensure everything is cleaned up
  await delay(50);
  
  // Fetch URL and metadata in parallel
  let url, meta;
  try {
    // Use Promise.all for parallel execution
    [url, meta] = await Promise.all([
      resolveUrl(target),
      getMetadata(target)
    ]);
    
    // Check if this request was cancelled while we were fetching
    if (currentRequest.cancelled) {
      return { status: "cancelled", url: null, backend: "mpv+yt-dlp", meta: null };
    }
  } catch (e) {
    state = "idle";
    pendingPlayRequest = null;
    throw e;
  }
  
  // One final check: ensure nothing is playing before we spawn
  if (playerProcess) {
    await forceStopPlayer();
    await delay(30);
  }
  
  // Spawn the player
  const proc = spawnPlayer(url);
  
  // Check again if cancelled before setting as active
  if (currentRequest.cancelled) {
    try {
      proc.kill("SIGKILL");
    } catch (err) {
      // Ignore
    }
    return { status: "cancelled", url: null, backend: "mpv+yt-dlp", meta: null };
  }
  
  playerProcess = proc;
  lastUrl = url;
  lastMeta = meta;
  state = "playing";
  pendingPlayRequest = null;
  
  // Reduced delay for faster startup
  await delay(50);
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
  
  // Cancel any pending play requests
  if (pendingPlayRequest) {
    pendingPlayRequest.cancelled = true;
    pendingPlayRequest = null;
  }
  
  // Force kill the player
  if (playerProcess) {
    try {
      playerProcess.kill("SIGTERM");
      await delay(20);
      if (playerProcess && !playerProcess.killed) {
        playerProcess.kill("SIGKILL");
      }
    } catch (err) {
      // Ignore
    }
    playerProcess = null;
  }
  
  // Try IPC quit as backup
  try {
    await sendMpv({ command: ["quit"] });
  } catch {
    // Ignore IPC errors
  }
  
  // Clean up everything
  cleanupIpc();
  
  // Remove pipe file on Unix
  if (process.platform !== "win32") {
    try {
      if (fs.existsSync(IPC_PIPE)) {
        fs.unlinkSync(IPC_PIPE);
      }
    } catch (err) {
      // Ignore
    }
  }

  // As a last-resort, kill lingering mpv processes (Windows / Unix)
  try {
    if (process.platform === "win32") {
      try { spawnSync("taskkill", ["/IM", "mpv.exe", "/F", "/T"], { windowsHide: true, stdio: "ignore" }); } catch {}
      try { spawnSync("taskkill", ["/IM", "mpv-console-launcher.exe", "/F", "/T"], { windowsHide: true, stdio: "ignore" }); } catch {}
    } else {
      try { spawnSync("pkill", ["-f", "mpv"], { windowsHide: true, stdio: "ignore" }); } catch {}
    }
  } catch (err) {
    // ignore
  }
  
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
  } catch {
    // ignore
  }
  const durationSeconds = lastMeta?.durationSeconds ?? null;
  return {
    status: state,
    url: lastUrl,
    backend: playerProcess ? "mpv+yt-dlp" : null,
    meta: lastMeta,
    position,
    durationSeconds
  };
}

export async function search(query, limit = 30) {
  if (!query?.trim()) throw new Error("Search query is required");
  const key = `${limit}:${query}`;
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.t < CACHE_MS) return cached.v;
  const data = await runJson(["-J", "--skip-download", "--flat-playlist", `ytsearch${limit}:${query}`], "Unable to search via yt-dlp");
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const results = entries
    .filter(Boolean)
    .map((entry) => {
      const meta = normalizeMeta(entry);
      return {
        id: meta?.id,
        title: meta?.title,
        uploader: meta?.uploader,
        duration: meta?.duration,
        thumbnail: meta?.thumbnail,
        webpageUrl: meta?.webpageUrl
      };
    })
    .filter((item) => item.id && item.title);
  searchCache.set(key, { t: Date.now(), v: results });
  return results;
}

export async function related(title, uploader, limit = 8) {
  if (!YT_CMD) throw new Error("yt-dlp not found");
  
  const allResults = [];
  const seen = new Set([title.toLowerCase()]);
  
  // Strategy 1: Search by artist/uploader (30% of results - similar artists)
  if (uploader) {
    try {
      const artistCount = Math.ceil(limit * 0.3);
      const artistResults = await search(uploader, artistCount + 2);
      for (const item of artistResults) {
        if (item.title && !seen.has(item.title.toLowerCase())) {
          allResults.push(item);
          seen.add(item.title.toLowerCase());
        }
      }
    } catch (err) {
      // Continue with other strategies
    }
  }
  
  // Strategy 2: Genre/keyword based search (40% of results)
  const genreKeywords = extractGenreKeywords(title);
  if (genreKeywords.length > 0 && allResults.length < limit) {
    try {
      const genreCount = Math.ceil(limit * 0.4);
      const genreQuery = genreKeywords.slice(0, 3).join(' ') + ' music';
      const genreResults = await search(genreQuery, genreCount + 5);
      for (const item of genreResults) {
        if (item.title && !seen.has(item.title.toLowerCase()) && allResults.length < limit) {
          allResults.push(item);
          seen.add(item.title.toLowerCase());
        }
      }
    } catch (err) {
      // Continue
    }
  }
  
  // Strategy 3: "Similar to" search (30% of results)
  if (allResults.length < limit) {
    try {
      // Extract main title without extras
      const cleanTitle = title.replace(/\(.*?\)|\[.*?\]|official|video|audio|lyrics|hd|4k/gi, '').trim();
      const similarQuery = cleanTitle.substring(0, 40);
      const similarResults = await search(similarQuery, limit + 5);
      for (const item of similarResults) {
        if (item.title && !seen.has(item.title.toLowerCase()) && allResults.length < limit) {
          allResults.push(item);
          seen.add(item.title.toLowerCase());
        }
      }
    } catch (err) {
      // Continue
    }
  }
  
  // Shuffle results for variety
  shuffleArray(allResults);
  
  return allResults.slice(0, limit);
}

// Helper to shuffle array
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// Helper function to extract genre/type keywords from title
function extractGenreKeywords(title) {
  if (!title) return [];
  
  const keywords = [];
  const lowerTitle = title.toLowerCase();
  
  // Music genres and types
  const genres = [
    'rock', 'pop', 'jazz', 'classical', 'hip hop', 'rap', 'r&b', 'rnb',
    'country', 'folk', 'blues', 'reggae', 'electronic', 'edm', 'house',
    'techno', 'dubstep', 'trap', 'soul', 'funk', 'disco', 'punk',
    'metal', 'indie', 'alternative', 'ambient', 'lofi', 'lo-fi', 'chill',
    'acoustic', 'instrumental', 'vocal', 'remix', 'cover', 'live',
    'orchestral', 'piano', 'guitar', 'violin', 'drums', 'bass',
    'ballad', 'upbeat', 'sad', 'happy', 'relaxing', 'energetic',
    'dance', 'synthwave', 'vaporwave', 'soundtrack', 'ost', 'anime',
    'k-pop', 'kpop', 'j-pop', 'jpop', 'latin', 'spanish', 'french'
  ];
  
  for (const genre of genres) {
    if (lowerTitle.includes(genre)) {
      keywords.push(genre);
    }
  }
  
  // Extract year if present (for era-based recommendations)
  const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    const decade = Math.floor(parseInt(yearMatch[1]) / 10) * 10;
    keywords.push(decade + 's');
  }
  
  return keywords;
}