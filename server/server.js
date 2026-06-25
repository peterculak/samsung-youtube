'use strict';

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────────────────────────────────────
// In-memory log ring buffer — last 200 lines, readable from /api/logs
// ─────────────────────────────────────────────────────────────────────────────
const LOG_RING = [];
const LOG_MAX  = 200;
function log(tag, msg) {
  const entry = `[${new Date().toISOString()}] [${tag}] ${msg}`;
  console.log(entry);
  LOG_RING.push(entry);
  if (LOG_RING.length > LOG_MAX) LOG_RING.shift();
}

const app  = express();
const PORT = process.env.PORT || 3000;

// Which browser to pull cookies from. Override with env var: BROWSER=firefox node server.js
// Supported values: chrome, chromium, brave, edge, vivaldi, opera, firefox, safari
const BROWSER = process.env.BROWSER || 'chrome';

// Directory where downloaded videos are stored
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR
  || path.resolve(__dirname, '../../../../ta3-cli/downloads/youtube');

app.use(cors());
app.use(express.json());
// Serve the Tizen web app (parent directory = YoutubeDownloader/)
app.use(express.static(path.join(__dirname, '..')));

// ─────────────────────────────────────────────────────────────────────────────
// Auth — uses yt-dlp --cookies-from-browser
// No device code needed. Just log into YouTube in Chrome (or BROWSER) on this Mac.
// ─────────────────────────────────────────────────────────────────────────────

let authState = {
  status:  'checking', // checking | authenticated | unauthenticated | error
  browser: BROWSER,
  message: '',
};

/**
 * Returns the yt-dlp cookie args if the user is authenticated, else [].
 * For public videos no cookies are needed at all.
 */
function cookieArgs() {
  return authState.status === 'authenticated'
    ? ['--cookies-from-browser', BROWSER]
    : [];
}

/**
 * Runs a quick yt-dlp --simulate to check if browser cookies give us YouTube access.
 * Resolves to true if authenticated, false otherwise.
 */
function checkAuth() {
  return new Promise((resolve) => {
    const proc = spawn('python3', [
      '-m', 'yt_dlp',
      '--cookies-from-browser', BROWSER,
      '--simulate', '--quiet', '--no-warnings',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]);
    let errOut = '';
    proc.stderr.on('data', d => { errOut += d.toString(); });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
    // Timeout after 20 s
    setTimeout(() => { proc.kill(); resolve(false); }, 20000);
  });
}

// Run auth check on startup
(async () => {
  console.log(`[auth] Checking ${BROWSER} cookies…`);
  const ok = await checkAuth();
  if (ok) {
    authState.status  = 'authenticated';
    authState.message = `Using ${BROWSER} cookies`;
    console.log(`[auth] ✓ Authenticated via ${BROWSER}`);
  } else {
    authState.status  = 'unauthenticated';
    authState.message = `Log into YouTube in ${BROWSER} on this Mac, then click Verify`;
    console.log(`[auth] ✗ Not authenticated — log into YouTube in ${BROWSER}`);
  }
})();

// GET /api/auth/status
app.get('/api/auth/status', (_req, res) => res.json(authState));

// POST /api/auth/verify — re-runs the cookie check
app.post('/api/auth/verify', async (_req, res) => {
  authState.status = 'checking';
  const ok = await checkAuth();
  authState.status  = ok ? 'authenticated' : 'unauthenticated';
  authState.message = ok
    ? `Using ${BROWSER} cookies`
    : `Log into YouTube in ${BROWSER} on this Mac, then click Verify`;
  res.json(authState);
});

// ─────────────────────────────────────────────────────────────────────────────
// Home Feed
// ─────────────────────────────────────────────────────────────────────────────

let homeCache   = null;
let homeCacheTs = 0;
const HOME_TTL  = 10 * 60 * 1000; // 10 minutes

app.get('/api/home', async (_req, res) => {
  const now = Date.now();
  if (homeCache && now - homeCacheTs < HOME_TTL) return res.json(homeCache);

  try {
    // If authenticated: show personal subscription feed
    // If not: show YouTube trending (no login needed)
    const url = authState.status === 'authenticated'
      ? 'https://www.youtube.com/feed/subscriptions'
      : 'https://www.youtube.com/feed/trending';

    const args = [
      ...cookieArgs(),
      '--flat-playlist', '--no-warnings', '--playlist-end', '24',
    ];

    const videos = await ytdlpJson([...args, url]);
    homeCache   = { videos, source: authState.status === 'authenticated' ? 'subscriptions' : 'trending' };
    homeCacheTs = now;
    res.json(homeCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const videos = await ytdlpJson([
      '--flat-playlist', '--no-warnings',
      `ytsearch20:${q}`,
    ]);
    res.json({ videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Download Jobs
// ─────────────────────────────────────────────────────────────────────────────

const jobs = new Map();

app.post('/api/download', (req, res) => {
  const { videoId, title, thumbnail, channel } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  for (const job of jobs.values()) {
    if (job.videoId === videoId && ['queued', 'downloading', 'processing'].includes(job.status)) {
      return res.json({ id: job.id, status: job.status, message: 'Already queued' });
    }
  }

  const id  = uuidv4();
  const job = {
    id, videoId,
    title:     title     || videoId,
    thumbnail: thumbnail || null,
    channel:   channel   || '',
    status:    'queued',
    progress:  0,
    speed:     '',
    eta:       '',
    filePath:  null,
    error:     null,
    createdAt: Date.now(),
  };

  jobs.set(id, job);
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  startDownload(job);
  res.json({ id });
});

app.get('/api/jobs',     (_req, res) => res.json([...jobs.values()]));
app.get('/api/jobs/:id', (req,  res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

function startDownload(job) {
  job.status = 'downloading';
  job.logs   = [];

  const args = [
    ...cookieArgs(),
    '--extractor-args', 'youtube:player_client=default,ios',
    '-f', 'bestvideo[vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--no-warnings', '--newline',
    '-o', path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s'),
    `https://www.youtube.com/watch?v=${job.videoId}`,
  ];

  log('download', `Starting: ${job.videoId} "${job.title}"`);
  log('download', `Command: python3 -m yt_dlp ${args.join(' ')}`);

  const proc = spawn('python3', ['-m', 'yt_dlp', ...args]);
  let buf = '';

  const onData = (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      log('yt-dlp', line);
      job.logs.push(line);
      if (job.logs.length > 100) job.logs.shift();

      const pm = line.match(/\[download\]\s+([\d.]+)%.*?at\s+([\d.]+\s*\w+\/s).*?ETA\s+([\d:]+)/i);
      if (pm) { job.progress = parseFloat(pm[1]); job.speed = pm[2]; job.eta = pm[3]; }

      const dm = line.match(/Destination:\s+(.+\.mp4)/i);
      if (dm) job.filePath = dm[1].trim();

      if (/Merging formats/i.test(line)) { job.status = 'processing'; job.progress = 99; }

      // Capture meaningful error lines for the job.error field
      const errMatch = line.match(/ERROR:\s+(.+)/i);
      if (errMatch) job._lastError = errMatch[1].trim();
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    if (code === 0) {
      job.status = 'done'; job.progress = 100; job.speed = ''; job.eta = '';
      log('download', `Done: ${job.videoId}`);
      if (job.filePath && fs.existsSync(job.filePath)) {
        const metaPath = job.filePath.replace(/\.mp4$/i, '.json');
        try {
          fs.writeFileSync(metaPath, JSON.stringify({
            videoId: job.videoId, title: job.title,
            thumbnail: job.thumbnail, channel: job.channel,
            downloadedAt: new Date().toISOString(),
          }), 'utf8');
        } catch { /* ignore */ }
      }
    } else {
      job.status = 'error';
      // Use the actual ERROR: line captured from yt-dlp output if available
      job.error = job._lastError || `yt-dlp exited with code ${code}`;
      log('download', `FAILED: ${job.videoId} — ${job.error}`);
    }
  });

  proc.on('error', (err) => {
    job.status = 'error';
    job.error  = err.message;
    log('download', `SPAWN ERROR: ${err.message}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs endpoint — returns last N server log lines
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/logs', (_req, res) => res.json(LOG_RING));

// ─────────────────────────────────────────────────────────────────────────────
// Library
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/library', (_req, res) => {
  if (!fs.existsSync(DOWNLOAD_DIR)) return res.json([]);

  const files = fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => /\.(mp4|mkv|m4a|webm)$/i.test(f))
    .map(f => {
      const full = path.join(DOWNLOAD_DIR, f);
      const stat = fs.statSync(full);
      const metaPath = full.replace(/\.[^.]+$/, '.json');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* none */ }
      return {
        filename:     f,
        title:        meta.title     || f.replace(/\.[^.]+$/, '').replace(/-/g, ' '),
        thumbnail:    meta.thumbnail || null,
        channel:      meta.channel   || '',
        videoId:      meta.videoId   || null,
        size:         stat.size,
        downloadedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.downloadedAt) - new Date(a.downloadedAt));

  res.json(files);
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/stream/:filename', (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  const stat = fs.statSync(filePath);
  const mime = { '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.m4a': 'audio/mp4', '.webm': 'video/webm' }
    [path.extname(filePath).toLowerCase()] || 'application/octet-stream';

  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start  = parseInt(s, 10);
    const end    = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ytdlpJson(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'yt_dlp', '--dump-json', ...args]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error((err || '').slice(0, 300) || `yt-dlp exit ${code}`));
      const videos = out.trim().split('\n').filter(Boolean).map(line => {
        try {
          const v = JSON.parse(line);
          const thumb = (v.thumbnails && v.thumbnails.at(-1)?.url) || v.thumbnail
            || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`;
          return {
            id:          v.id,
            title:       v.title || v.fulltitle || v.id,
            thumbnail:   thumb,
            duration:    v.duration    || 0,
            durationStr: formatDuration(v.duration),
            channel:     v.channel     || v.uploader || '',
            viewCount:   v.view_count  || 0,
            uploadDate:  v.upload_date || '',
          };
        } catch { return null; }
      }).filter(Boolean);
      resolve(videos);
    });
    proc.on('error', reject);
  });
}

function formatDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀  Server →  http://localhost:${PORT}`);
  console.log(`📁  Downloads: ${DOWNLOAD_DIR}`);
  console.log(`🌐  Browser:   ${BROWSER}`);
  console.log('');
  console.log('Open the app → http://localhost:' + PORT);
});
