'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const PORT = process.env.PORT || 4321;
const DEFAULT_DIR = process.env.MEDIA_DIR || __dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');

// Resolve a client-supplied folder to an absolute path, falling back to the
// default. The server runs locally, so browsing the real filesystem is fine.
function resolveDir(dir) {
  if (!dir || typeof dir !== 'string') return DEFAULT_DIR;
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
  return abs;
}

function outDirFor(dir) {
  return path.join(dir, 'labeled');
}

// ---- helpers ----------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 16, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

// Spoken-friendly duration, e.g. "29 minutes", "1 minute", "45 seconds".
function formatSpokenLength(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

// Default spoken announcement for an episode: title, then its length.
function announcementFor(filename, seconds) {
  const title = humanize(filename.replace(/\.mp3$/i, ''));
  return seconds && isFinite(seconds) ? `${title}, ${formatSpokenLength(seconds)}` : title;
}

async function listMp3s(dir) {
  const outDir = outDirFor(dir);
  const marks = loadRegions(dir);
  const names = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.mp3'))
    .sort((a, b) => a.localeCompare(b));
  return Promise.all(
    names.map(async (f) => {
      const rs = marks[f] || [];
      const adSeconds = rs.reduce((s, r) => s + Math.max(0, r.end - r.start), 0);
      let dur = 0;
      try {
        dur = await probeDuration(path.join(dir, f));
      } catch {}
      return {
        filename: f,
        defaultText: announcementFor(f, dur),
        durationSec: Math.round(dur),
        done: fs.existsSync(path.join(outDir, f)),
        adCount: rs.length,
        adSeconds: Math.round(adSeconds),
      };
    })
  );
}

// ---- ad-region persistence --------------------------------------------------
// Marked ad regions are stored per-folder in a hidden JSON file, keyed by
// filename, so you can mark ads across many episodes before exporting.
function regionsFile(dir) {
  return path.join(dir, '.podlabel-regions.json');
}
function loadRegions(dir) {
  try {
    return JSON.parse(fs.readFileSync(regionsFile(dir), 'utf8'));
  } catch {
    return {};
  }
}
function saveRegionsFor(dir, file, regions) {
  const all = loadRegions(dir);
  const clean = (regions || [])
    .map((r) => ({ start: +r.start, end: +r.end }))
    .filter((r) => isFinite(r.start) && isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (clean.length) all[file] = clean;
  else delete all[file];
  fs.writeFileSync(regionsFile(dir), JSON.stringify(all, null, 2));
  return clean;
}

// From ad ranges to REMOVE + total duration, return the segments to KEEP.
function keepSegments(remove, total) {
  const ranges = remove
    .map((r) => ({ start: Math.max(0, +r.start), end: Math.min(total, +r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const keeps = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.start > cursor + 0.02) keeps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < total - 0.02) keeps.push({ start: cursor, end: total });
  return keeps;
}

// List sub-folders of `dir` (plus its parent) so the UI can navigate the disk.
function browseDir(dir) {
  let entries = [];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    throw new Error('Cannot read folder: ' + err.message);
  }
  const mp3Count = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.mp3')).length;
  const parent = path.dirname(dir);
  return {
    dir,
    parent: parent === dir ? null : parent,
    home: os.homedir(),
    dirs: entries,
    mp3Count,
  };
}

// Turn a label like "americandream" / "AIBooks" / "spacexipo" into something a
// TTS voice reads more naturally. We can't perfectly split run-together words,
// but we split camelCase and digit boundaries which covers most labels.
function humanize(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels',
    '-of', 'json',
    file,
  ]);
  const s = (JSON.parse(stdout).streams || [])[0] || {};
  return {
    sampleRate: s.sample_rate || '44100',
    channels: s.channels || 2,
  };
}

async function getVoices() {
  try {
    const { stdout } = await run('say', ['-v', '?']);
    return stdout
      .split('\n')
      .map((line) => {
        // Format: "Name             en_US    # comment"
        const m = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})/);
        if (!m) return null;
        return { name: m[1].trim(), locale: m[2] };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function probeDuration(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  return parseFloat(stdout.trim()) || 0;
}

// The single "export" step: remove any saved ad regions for this file AND
// prepend the spoken episode marker, producing the final swim-ready mp3 in
// <dir>/labeled/<filename>. Originals are never modified.
async function exportFinal({ dir, filename, text, voice, rate }) {
  const input = path.join(dir, filename);
  if (!fs.existsSync(input)) throw new Error('File not found: ' + filename);

  const outDir = outDirFor(dir);
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, filename);

  const regions = loadRegions(dir)[filename] || [];
  const { sampleRate, channels } = await probe(input);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'label-'));
  const aiff = path.join(tmp, 'announce.aiff');
  const announceMp3 = path.join(tmp, 'announce.mp3');

  try {
    // 1. Generate the spoken marker and encode it to match the podcast's
    //    format (so segments can be concatenated), with a short silence tail.
    const sayArgs = ['-o', aiff];
    if (voice) sayArgs.push('-v', voice);
    if (rate) sayArgs.push('-r', String(rate));
    // Fall back to "title, length" if the caller sent no custom text.
    let spoken = text && text.trim();
    if (!spoken) {
      let d = 0;
      try {
        d = await probeDuration(input);
      } catch {}
      spoken = announcementFor(filename, d);
    }
    sayArgs.push('--', spoken);
    await run('say', sayArgs);
    await run('ffmpeg', [
      '-y', '-i', aiff,
      '-af', 'apad=pad_dur=0.6',
      '-ar', String(sampleRate), '-ac', String(channels),
      '-c:a', 'libmp3lame', '-q:a', '4',
      announceMp3,
    ]);

    let total = 0, newDur = 0;
    if (regions.length) {
      // Marker + kept (non-ad) segments, stitched in one re-encode pass.
      total = await probeDuration(input);
      const keeps = keepSegments(regions, total);
      if (!keeps.length) throw new Error('Ad marks would remove the entire file.');
      const parts = keeps.map(
        (k, i) => `[1:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
      );
      const concatIn = '[0:a]' + keeps.map((_, i) => `[a${i}]`).join('');
      // The trailing aresample re-buffers concat's output frames with the padding
      // libmp3lame needs — without it some cut-point alignments trigger an
      // "inadequate AVFrame plane padding" encoder error on certain episodes.
      const filter = `${parts.join(';')};${concatIn}concat=n=${keeps.length + 1}:v=0:a=1,aresample=${sampleRate}[out]`;
      await run('ffmpeg', [
        '-y', '-i', announceMp3, '-i', input,
        '-filter_complex', filter, '-map', '[out]',
        '-c:a', 'libmp3lame', '-q:a', '2',
        out,
      ]);
    } else {
      // No ads marked: just prepend the marker (stream copy — fast, lossless).
      const listFile = path.join(tmp, 'list.txt');
      fs.writeFileSync(
        listFile,
        `file '${announceMp3.replace(/'/g, "'\\''")}'\nfile '${input.replace(/'/g, "'\\''")}'\n`
      );
      await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out]);
    }

    newDur = await probeDuration(out);
    return {
      out,
      adCount: regions.length,
      adSeconds: Math.round(regions.reduce((s, r) => s + Math.max(0, r.end - r.start), 0)),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Stream an mp3 with HTTP range support so the browser can seek during playback.
function streamAudio(req, res, dir, filename) {
  const file = path.join(dir, filename);
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    const start = parseInt(m[1], 10) || 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
  }
}

// ---- http -------------------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] ||
      'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/files') {
      const dir = resolveDir(url.searchParams.get('dir'));
      return sendJson(res, 200, { dir, files: await listMp3s(dir), outDir: outDirFor(dir) });
    }

    if (req.method === 'GET' && url.pathname === '/api/browse') {
      const dir = resolveDir(url.searchParams.get('dir'));
      return sendJson(res, 200, browseDir(dir));
    }

    if (req.method === 'GET' && url.pathname === '/api/voices') {
      return sendJson(res, 200, { voices: await getVoices() });
    }

    if (req.method === 'POST' && url.pathname === '/api/export') {
      const { dir, filename, text, voice, rate } = JSON.parse(await readBody(req));
      const result = await exportFinal({ dir: resolveDir(dir), filename, text, voice, rate });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && url.pathname === '/api/audio') {
      const dir = resolveDir(url.searchParams.get('dir'));
      const filename = path.basename(url.searchParams.get('file') || '');
      return streamAudio(req, res, dir, filename);
    }

    if (req.method === 'GET' && url.pathname === '/api/regions') {
      const dir = resolveDir(url.searchParams.get('dir'));
      const file = path.basename(url.searchParams.get('file') || '');
      return sendJson(res, 200, { regions: loadRegions(dir)[file] || [] });
    }

    if (req.method === 'POST' && url.pathname === '/api/regions') {
      const { dir, file, regions } = JSON.parse(await readBody(req));
      const saved = saveRegionsFor(resolveDir(dir), path.basename(file || ''), regions);
      return sendJson(res, 200, { ok: true, regions: saved });
    }

    if (req.method === 'GET') {
      return serveStatic(res, url.pathname);
    }

    res.writeHead(405);
    res.end('Method not allowed');
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message, detail: err.stderr || '' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  🏊  Podcast labeler running`);
  console.log(`      Default folder: ${DEFAULT_DIR}`);
  console.log(`      Open          : http://localhost:${PORT}\n`);
});
