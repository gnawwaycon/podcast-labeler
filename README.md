# 🏊 Podcast Labeler

A tiny local web app for prepping podcasts to play on a **screenless MP3 player** (the kind you swim with). It does two things:

1. **Labels episodes** — prepends a spoken announcement of the episode name to the start of each MP3, so you know what's playing (and whether you've already heard it) without a screen.
2. **Removes ads** — a waveform editor lets you play the audio, mark ad segments, and cut them out.

Both happen in **one export**: pick episodes, optionally mark ads, hit **Export**, and you get clean, labeled files ready to copy onto your player. Originals are never modified.

![status: personal project](https://img.shields.io/badge/status-personal%20project-blue)

## Requirements

- **macOS** — uses the built-in `say` command for text-to-speech.
- **[FFmpeg](https://ffmpeg.org/)** (`ffmpeg` + `ffprobe`) — `brew install ffmpeg`.
- **Node.js** ≥ 18.

No `npm install` needed — the app has zero runtime dependencies (it uses Node's built-in HTTP server, plus a vendored copy of [WaveSurfer.js](https://wavesurfer.xyz/) for the waveform).

## Usage

```bash
node server.js
# then open http://localhost:4321
```

- Use **📁 Change folder…** to point it at any folder of MP3s on your Mac (the app browses your filesystem locally).
- Edit the spoken text per episode, pick a voice and speed.
- Click **✂️ edit ads** on any episode to open the waveform editor: drag to mark ads, fine-tune with editable timestamps, and it auto-saves.
- Hit **⬇︎ Export selected** — each file gets its ads cut and the spoken name prepended, written to a `labeled/` subfolder.

Set a different default folder or port with env vars:

```bash
MEDIA_DIR="/path/to/podcasts" PORT=8080 node server.js
```

## How it works

- **TTS**: macOS `say` renders the episode name to audio.
- **Labeling (no ads marked)**: the announcement is stream-copied onto the front of the MP3 — fast and lossless.
- **Ad removal + labeling**: FFmpeg builds an `atrim`/`concat` filtergraph from the *kept* (non-ad) segments, prepends the announcement, and re-encodes with `libmp3lame`.
- Ad markings persist per-folder in a hidden `.podlabel-regions.json` so you can mark ads across many episodes before exporting.

## Notes

- Media files, generated output, and ad-timing data are git-ignored — this repo is code only.
- Everything runs locally; no audio ever leaves your machine.

## License

MIT
