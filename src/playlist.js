import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLAYLISTS_PATH = path.join(__dirname, "..", "playlists.json");

let playlists = [];
try { playlists = JSON.parse(fs.readFileSync(PLAYLISTS_PATH, "utf8")); } catch { /* fresh start */ }

function save() {
  fs.writeFileSync(PLAYLISTS_PATH, JSON.stringify(playlists, null, 2));
}

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

export function listPlaylists() {
  return playlists.map(({ id, name, description, tracks, createdAt, updatedAt }) => ({
    id, name, description, trackCount: tracks.length, createdAt, updatedAt
  }));
}

export function getPlaylist(id) {
  const pl = playlists.find((p) => p.id === id);
  if (!pl) throw new Error("Playlist not found");
  return pl;
}

export function createPlaylist(name, description = "") {
  if (!name?.trim()) throw new Error("Playlist name is required");
  const now = Date.now();
  const pl = { id: generateId(), name: name.trim(), description: description.trim(), tracks: [], createdAt: now, updatedAt: now };
  playlists.push(pl);
  save();
  return pl;
}

export function updatePlaylist(id, updates) {
  const pl = playlists.find((p) => p.id === id);
  if (!pl) throw new Error("Playlist not found");
  if (updates.name !== undefined) pl.name = updates.name.trim();
  if (updates.description !== undefined) pl.description = updates.description.trim();
  pl.updatedAt = Date.now();
  save();
  return pl;
}

export function deletePlaylist(id) {
  const idx = playlists.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error("Playlist not found");
  const [removed] = playlists.splice(idx, 1);
  save();
  return removed;
}

export function addTrack(playlistId, track) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) throw new Error("Playlist not found");
  if (!track?.id || !track?.title) throw new Error("Track must have id and title");
  if (pl.tracks.some((t) => t.id === track.id)) throw new Error("Track already in playlist");
  pl.tracks.push({
    id: track.id,
    title: track.title,
    uploader: track.uploader || "",
    duration: track.duration || null,
    thumbnail: track.thumbnail || null,
    addedAt: Date.now()
  });
  pl.updatedAt = Date.now();
  save();
  return pl;
}

export function removeTrack(playlistId, trackId) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) throw new Error("Playlist not found");
  const idx = pl.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) throw new Error("Track not found in playlist");
  pl.tracks.splice(idx, 1);
  pl.updatedAt = Date.now();
  save();
  return pl;
}

export function reorderTrack(playlistId, trackId, newIndex) {
  const pl = playlists.find((p) => p.id === playlistId);
  if (!pl) throw new Error("Playlist not found");
  const idx = pl.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) throw new Error("Track not found in playlist");
  const clamped = Math.max(0, Math.min(pl.tracks.length - 1, newIndex));
  const [track] = pl.tracks.splice(idx, 1);
  pl.tracks.splice(clamped, 0, track);
  pl.updatedAt = Date.now();
  save();
  return pl;
}
