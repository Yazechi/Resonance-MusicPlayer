#!/usr/bin/env node
import { play, pause, resume, stop, setVolume, getStatus } from "./player.js";

function usage() {
  console.log(`Usage:
  node src/index.js play "<query or url>"
  node src/index.js pause
  node src/index.js resume
  node src/index.js stop
  node src/index.js volume <0-100>
  node src/index.js status
  node src/index.js serve   # simple stdio JSON server

Prereqs: yt-dlp and mpv must be in PATH.`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case "serve": {
        console.log(JSON.stringify({ ready: true, commands: ["play", "pause", "resume", "stop", "volume", "status"] }));
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", async (chunk) => {
          const lines = chunk.split("\n").filter(Boolean);
          for (const line of lines) {
            let payload;
            try {
              payload = JSON.parse(line);
            } catch (err) {
              console.log(JSON.stringify({ ok: false, error: "Invalid JSON" }));
              continue;
            }
            const { action, args } = payload;
            try {
              let result;
              switch (action) {
                case "play":
                  result = await play(args?.query ?? "");
                  break;
                case "pause":
                  result = await pause();
                  break;
                case "resume":
                  result = await resume();
                  break;
                case "stop":
                  result = await stop();
                  break;
                case "volume":
                  result = await setVolume(args?.level);
                  break;
                case "status":
                  result = await getStatus();
                  break;
                default:
                  throw new Error("Unknown action");
              }
              console.log(JSON.stringify({ ok: true, result }));
            } catch (err) {
              console.log(JSON.stringify({ ok: false, error: err.message }));
            }
          }
        });
        process.stdin.resume();
        break;
      }
      case "play": {
        const query = rest.join(" ").trim();
        if (!query) throw new Error("Provide a search query or URL");
        const result = await play(query);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "pause":
        console.log(JSON.stringify(await pause(), null, 2));
        break;
      case "resume":
        console.log(JSON.stringify(await resume(), null, 2));
        break;
      case "stop":
        console.log(JSON.stringify(await stop(), null, 2));
        break;
      case "volume":
        if (!rest[0]) throw new Error("Provide volume 0-100");
        console.log(JSON.stringify(await setVolume(rest[0]), null, 2));
        break;
      case "status":
        console.log(JSON.stringify(await getStatus(), null, 2));
        break;
      default:
        usage();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
