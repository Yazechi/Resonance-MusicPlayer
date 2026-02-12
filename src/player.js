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
const metaCache = new Map();
const searchCache = new Map();
const CACHE_MS = 5 * 60 * 1000;
let requestId = 0;

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
      resolve(out.split("\n")[0].trim());
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
    ipcClient.destroy();
    ipcClient = null;
  }
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

/* IPC command queue — serialises access to prevent race conditions */
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
    state = "idle";
    lastUrl = null;
    lastMeta = null;
    cleanupIpc();
    playerProcess = null;
  });
  proc.stderr?.on("data", () => {});
  return proc;
}

export async function play(input) {
  assertDeps();
  if (playerProcess) {
    playerProcess.kill();
    cleanupIpc();
  }
  const target = isUrl(input) ? input : `ytsearch1:${input}`;
  const [url, meta] = await Promise.all([resolveUrl(target), getMetadata(target)]);
  const proc = spawnPlayer(url);
  playerProcess = proc;
  lastUrl = url;
  lastMeta = meta;
  state = "playing";
  await delay(150);
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
  try {
    if (playerProcess) {
      playerProcess.kill();
    } else {
      await sendMpv({ command: ["quit"] });
    }
    cleanupIpc();
    state = "idle";
    const url = lastUrl;
    const meta = lastMeta;
    lastUrl = null;
    lastMeta = null;
    return { status: state, url, meta };
  } catch {
    throw new Error("Nothing is playing");
  }
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
  const query = uploader ? `${uploader} ${title}` : title;
  const results = await search(query, limit + 2);
  return results.filter((r) => r.title !== title).slice(0, limit);
}
