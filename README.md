# 🎵 Online Music Player

A full-featured web-based music player that streams audio from YouTube, powered by `yt-dlp` + `mpv` with AI-driven song recommendations via Google Gemini.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔍 **YouTube Search** | Search millions of songs by title, artist, or keywords with paginated results |
| 🎶 **Audio Streaming** | High-quality audio playback via mpv with no video overhead |
| ⏯️ **Full Playback Controls** | Play, pause, resume, stop, seek, and volume — all from the browser |
| 📊 **Animated Visualizer** | Wave-based audio visualizer that responds to playback state |
| 🕐 **Progress Slider** | Draggable timeline with real-time position tracking and seek |
| 🤖 **AI Recommendations** | Chat with Copilot Music AI to discover songs by mood, genre, or vibe |
| 📝 **Listening History** | Automatically tracks plays to personalize future AI suggestions |
| 🎵 **Related Music** | Sidebar with similar songs based on the currently playing track |
| 💻 **CLI Mode** | Command-line interface for quick terminal-based playback |
| 🔌 **Stdio Server** | JSON-over-stdio protocol for integration with Copilot CLI or other tools |

---

## 📋 Prerequisites

You need **four tools** installed before running the app:

### 1. Node.js (v18 or higher)

```powershell
# Check if installed
node --version

# Install via winget (Windows)
winget install OpenJS.NodeJS
```

Or download from https://nodejs.org/

### 2. yt-dlp (YouTube downloader)

```powershell
# Check if installed
yt-dlp --version

# Install via winget (Windows)
winget install yt-dlp.yt-dlp
```

Or download from https://github.com/yt-dlp/yt-dlp/releases

### 3. mpv (media player)

```powershell
# Check if installed
mpv --version

# Install via Microsoft Store (Windows)
winget install 9P3JFR0CLLL6
```

Or download from https://mpv.io/installation/

### 4. FFmpeg (audio processing)

```powershell
# Check if installed
ffmpeg -version

# Usually installed automatically with yt-dlp
# If not:
winget install Gyan.FFmpeg
```

> ⚠️ **Important:** After installing via winget, **restart your terminal** so the new binaries are on PATH. The app also has built-in fallback paths for common winget install locations.

---

## 🚀 Setup

### Step 1 — Clone or download the project

```powershell
git clone <repo-url>
cd OnlineMusicPlayer
```

### Step 2 — Install Node.js dependencies

```powershell
npm install
```

This installs:
- `express` — HTTP server framework
- `@google/generative-ai` — Google Gemini AI SDK
- `dotenv` — Environment variable loader

### Step 3 — Configure AI recommendations (optional)

The AI chat feature requires a **Google Gemini API key** (free tier available).

1. Go to https://aistudio.google.com/apikey
2. Click **Create API Key**
3. Create a `.env` file in the project root:

```
GEMINI_API_KEY=your_api_key_here
```

> The `.env` file is gitignored and will never be committed. The AI uses `gemini-2.5-flash-lite` (free tier: 10 requests/min, 20 requests/day). The app works fine without an API key — you just won't have the AI chat feature.

### Step 4 — Start the app

```powershell
npm start
```

Open your browser and go to **http://localhost:3000**

---

## 🌐 Using the Web App

### Searching for music

1. Type a song title, artist name, or keywords into the search bar
2. Press **Enter** or click **Search**
3. Browse results (10 per page, use Next/Prev to paginate)
4. Click **▶ Play** on any result

### Player view

Once a song starts playing, you'll see:

- **Visualizer** — Animated wave bars across the top of the player card
- **Song info** — Title, artist, and playback status badge
- **Progress slider** — Shows current position and total duration; drag to seek
- **Controls** — Pause, Resume, Stop buttons
- **Volume slider** — Adjust volume from 0 to 100
- **← Back** — Return to search results
- **Related sidebar** — Similar songs you can play with one click

### AI chat panel

1. Click the **🤖 button** in the bottom-right corner
2. Type what you're in the mood for, for example:
   - *"chill lo-fi for studying"*
   - *"upbeat workout music"*
   - *"sad songs like Adele"*
   - *"Japanese city pop from the 80s"*
3. The AI returns personalized suggestions based on your request and listening history
4. Click any suggestion to **instantly play** it

---

## 💻 Using the CLI

The CLI works independently of the web server — no browser needed.

### Play a song

```powershell
# Search and play the first result
node src/index.js play "bohemian rhapsody"

# Play from a direct YouTube URL
node src/index.js play "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

### Playback controls

```powershell
node src/index.js pause          # Pause current song
node src/index.js resume         # Resume playback
node src/index.js stop           # Stop and kill mpv
node src/index.js volume 50      # Set volume (0-100)
node src/index.js status         # Show current playback info
```

### Example output

```json
{
  "status": "playing",
  "url": "https://...",
  "backend": "mpv+yt-dlp",
  "meta": {
    "title": "Queen - Bohemian Rhapsody (Official Video)",
    "uploader": "Queen Official",
    "duration": "5:55",
    "durationSeconds": 355
  }
}
```

> **Note:** CLI and web app share the same playback engine. If you play a song via CLI, the web UI will reflect it, and vice versa. Only one song plays at a time.

---

## 🔌 Stdio Server (for Copilot CLI / MCP integration)

Start a JSON-over-stdio server for programmatic control:

```powershell
node src/index.js serve
```

Send JSON commands via stdin (one per line):

```json
{"action":"play","args":{"query":"lofi beats"}}
{"action":"pause"}
{"action":"resume"}
{"action":"stop"}
{"action":"volume","args":{"level":25}}
{"action":"status"}
```

Responses come as JSON lines on stdout:

```json
{"ok":true,"result":{"status":"playing","meta":{"title":"..."}}}
{"ok":false,"error":"Nothing is playing"}
```

### Copilot CLI MCP config

To let GitHub Copilot CLI control the music player, add to your MCP config (`~/.config/copilot/mcp.json`):

```json
{
  "servers": {
    "music": {
      "command": "node",
      "args": ["D:\\OnlineMusicPlayer\\src\\index.js", "serve"]
    }
  }
}
```

---

## 🗂️ Project Structure

```
OnlineMusicPlayer/
├── public/
│   └── index.html          # Single-page web UI (search, player, visualizer, AI chat)
├── src/
│   ├── server.js            # Express HTTP server + REST API endpoints
│   ├── player.js            # Playback engine (mpv spawn, IPC, yt-dlp search/metadata)
│   ├── ai.js                # Google Gemini AI chat + listening history
│   └── index.js             # CLI entry point + stdio JSON server
├── .env                     # Gemini API key (gitignored, create manually)
├── .gitignore               # Ignores node_modules, .env, logs
├── listening-history.json   # Auto-generated play history (max 100 entries)
├── package.json             # Dependencies and scripts
└── README.md                # This file
```

---

## 🔧 API Reference

All endpoints are served at `http://localhost:3000`.

### Search

```
GET /api/search?q=<query>&limit=<number>
```

| Param | Default | Description |
|-------|---------|-------------|
| `q` | required | Search keywords |
| `limit` | 30 | Max results (10–50) |

**Response:**
```json
{
  "ok": true,
  "results": [
    { "id": "abc123", "title": "Song Title", "uploader": "Artist", "duration": "3:45", "thumbnail": "https://..." }
  ]
}
```

### Play

```
POST /api/play
Content-Type: application/json
```

**Body** (provide one of):
```json
{ "id": "youtube_video_id" }
{ "url": "https://www.youtube.com/watch?v=..." }
{ "query": "artist - song title" }
```

### Controls

```
POST /api/pause                              # Pause playback
POST /api/resume                             # Resume playback
POST /api/stop                               # Stop and kill mpv
POST /api/seek    { "position": 90 }         # Seek to 90 seconds
POST /api/volume  { "level": 50 }            # Volume 0-100
```

### Status

```
GET /api/status
```

**Response:**
```json
{
  "ok": true,
  "result": {
    "status": "playing",
    "position": 42.5,
    "durationSeconds": 225,
    "meta": { "id": "abc123", "title": "...", "uploader": "..." }
  }
}
```

### AI Chat

```
POST /api/chat
Content-Type: application/json
```

**Body:**
```json
{ "message": "recommend me some chill jazz" }
```

**Response:**
```json
{
  "ok": true,
  "message": "Here are some smooth jazz picks for you!",
  "suggestions": [
    { "query": "Miles Davis - So What", "reason": "Timeless cool jazz classic" },
    { "query": "Chet Baker - Almost Blue", "reason": "Beautifully melancholic trumpet" }
  ]
}
```

### Related Music

```
GET /api/related?title=<song>&uploader=<artist>
```

### Listening History

```
GET /api/history
```

---

## 🛠️ npm Scripts

```powershell
npm start        # Start the web server (http://localhost:3000)
npm run cli      # Shortcut for the CLI (node src/index.js)
npm run lint     # Check all source files for syntax errors
```

---

## ❓ Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `yt-dlp not found` | Not on PATH | Restart terminal after install, or set PATH manually |
| `mpv not found` | Not installed or not on PATH | `winget install 9P3JFR0CLLL6` then restart terminal |
| `EADDRINUSE: port 3000` | Another server is already running | Find and kill it: `Get-NetTCPConnection -LocalPort 3000` then `Stop-Process -Id <PID>` |
| `IPC connection closed` / `socket ended` | mpv process crashed or was killed | Play a new song — it will spawn a fresh mpv instance |
| `Gemini API quota exceeded` | Free tier daily limit reached | Wait for reset (resets daily) or enable billing at https://ai.google.dev |
| `ERR_NETWORK_CHANGED` | Your network connection reset (Wi-Fi, VPN) | Refresh the browser page once connection stabilizes |
| Player says "Nothing is playing" | mpv exited (song ended or crashed) | Play a new song |
| Search is slow | yt-dlp fetching 30 results | Normal — results are cached for 5 minutes so repeat searches are instant |
| AI chat not working | Missing `.env` file or invalid API key | Create `.env` with `GEMINI_API_KEY=your_key` and restart the server |

---

## ⚙️ How It Works Under the Hood

### Architecture diagram

```
┌──────────────────────────────────────────────────────┐
│  Browser (http://localhost:3000)                      │
│  ┌─────────┐  ┌──────────┐  ┌─────────────────────┐ │
│  │ Search   │  │ Player   │  │ 🤖 AI Chat Panel   │ │
│  │ View     │  │ View     │  │                     │ │
│  └────┬─────┘  └────┬─────┘  └──────────┬──────────┘ │
└───────┼──────────────┼───────────────────┼────────────┘
        │ REST API     │ REST API          │ REST API
        ▼              ▼                   ▼
┌──────────────────────────────────────────────────────┐
│  Express Server (src/server.js)                       │
│  ┌──────────────────┐  ┌───────────────────────────┐ │
│  │  Player Engine    │  │  AI Module (src/ai.js)    │ │
│  │  (src/player.js)  │  │  - Gemini API             │ │
│  │  - yt-dlp search  │  │  - Listening history      │ │
│  │  - mpv spawn      │  │  - Personalized recs      │ │
│  │  - IPC control    │  └───────────────────────────┘ │
│  └────────┬──────────┘                                │
└───────────┼───────────────────────────────────────────┘
            │
   ┌────────┴────────┐
   ▼                 ▼
┌────────┐    ┌────────────┐
│ yt-dlp │    │    mpv     │
│ search │    │  audio     │
│ + URL  │    │  playback  │
│ resolve│    │  via IPC   │
└────────┘    │  named pipe│
              └────────────┘
```

### Playback flow

1. **Search** — `yt-dlp --flat-playlist ytsearch30:<query>` returns metadata (title, artist, thumbnail, duration)
2. **URL resolution** — `yt-dlp -f bestaudio --get-url <video>` gets the direct audio stream URL
3. **Playback** — `mpv --no-video --input-ipc-server=\\.\pipe\copilot-music <url>` streams the audio
4. **IPC control** — Commands (pause, seek, volume) are sent as JSON over the Windows named pipe
5. **Status polling** — Frontend polls `/api/status` every 1 second; `requestAnimationFrame` interpolates for smooth slider updates between polls

### AI recommendation flow

1. User types a request in the chat panel
2. Backend sends the message + last 5 listening history entries to Google Gemini
3. Gemini returns JSON with a friendly message and 5–6 song suggestions (artist + title)
4. User clicks a suggestion → plays directly via `ytsearch1:` (single result, fast)

### Caching

- **Search results** — Cached in memory for 5 minutes (key: query + limit)
- **Song metadata** — Cached in memory for 5 minutes (key: video URL/ID)
- **AI recommendations** — Cached client-side per chat session
- **Related music** — Cached client-side by song title + artist

---

## 📄 License

MIT
