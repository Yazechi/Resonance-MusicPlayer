# Resonance Project - Gemini Context

## Project Overview

Resonance is a web-based music player that streams audio directly from YouTube. It is built with a Node.js Express backend and a Vanilla HTML/JS/CSS frontend. The application uses `yt-dlp` to search and resolve YouTube audio streams, and `mpv` to handle high-quality headless audio playback. It features a rich user interface with full playback controls, playlists, queue management, an audio visualizer, and a smart AI chat assistant powered by Google Gemini to recommend songs based on user mood and listening history.

Additionally, the project supports a standalone CLI mode for terminal-based playback and a JSON-over-stdio server designed for integration with tools like GitHub Copilot CLI or other MCP (Model Context Protocol) clients.

## Key Technologies

*   **Backend:** Node.js (v18+), Express.js
*   **AI Integration:** `@google/generative-ai` (Gemini API)
*   **Media Stack (Required System Binaries):** `yt-dlp` (Stream resolution), `mpv` (Playback engine), `FFmpeg` (Audio processing)
*   **Frontend:** Single-Page Application (SPA) using standard web technologies.

## Building and Running

Ensure that `Node.js`, `yt-dlp`, `mpv`, and `FFmpeg` are installed on your system and available in your PATH.

*   **Install Dependencies:**
    ```bash
    npm install
    ```
*   **Configuration:** Create a `.env` file in the project root to enable AI features:
    ```env
    GEMINI_API_KEY=your_gemini_api_key_here
    ```
*   **Start the Web Application:**
    ```bash
    npm start
    ```
    *The app will be available at `http://localhost:3000`.*
*   **Use the CLI:**
    ```bash
    npm run cli play "song name"
    # or using node directly
    node src/index.js status
    ```
*   **Run Linter (Syntax Check):**
    ```bash
    npm run lint
    ```

## Development Conventions & Architecture

*   **Module System:** The codebase uses ES Modules (`"type": "module"` in `package.json`).
*   **Backend Structure (`src/`):**
    *   `server.js`: The Express application, serving the frontend and exposing REST API endpoints for player controls, search, and AI interactions.
    *   `player.js`: The core playback engine. It orchestrates `yt-dlp` for fetching metadata/stream URLs and spawns `mpv` as a child process, communicating with it via Windows named pipes (IPC).
    *   `ai.js`: Handles interactions with the Google Gemini API, managing prompt construction and listening history context for personalized song recommendations.
    *   `playlist.js`: Manages playlist logic and state.
    *   `index.js`: The CLI interface and stdio server handler.
*   **Frontend Structure (`public/`):**
    *   `index.html`: Contains the complete Single-Page Application, including the UI for search, player controls, visualizer, and AI chat panel. All client-side logic and styling are embedded or linked from here.
*   **Data Persistence:** User data such as listening history and playlists are stored locally in auto-generated JSON files (`listening-history.json`, `playlists.json`) at the project root.
*   **IPC Communication:** Commands (play, pause, volume) between the Node backend and the `mpv` player are sent as JSON payloads over an IPC named pipe (e.g., `\\.\pipe\copilot-music`).