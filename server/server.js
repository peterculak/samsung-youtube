'use strict';

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');
const https     = require('https');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const os        = require('os');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Auto-update config.js with current local IP ─────────────────────────────
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();
const configJsPath = path.join(__dirname, '../js/config.js');
if (fs.existsSync(configJsPath)) {
  let content = fs.readFileSync(configJsPath, 'utf8');
  content = content.replace(
    /SERVER_URL:\s*.*?,/g,
    `SERVER_URL: (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) ? '' : 'http://${localIp}:${PORT}',`
  );
  fs.writeFileSync(configJsPath, content, 'utf8');
  console.log(`[config] Auto-updated config.js with local IP: ${localIp}`);
}

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
    const proc = spawn('yt-dlp', [
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

  // Use the exact yt-dlp arguments that work reliably in the CLI
  const args = [
    // ...cookieArgs(), // Disabled: cookies often trigger 403 Forbidden throttling on YouTube
    '-f', 'bestvideo+bestaudio/best',
    '--merge-output-format', 'mkv',
    '--no-warnings', '--newline',
    '-o', path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s'),
    `https://www.youtube.com/watch?v=${job.videoId}`,
  ];

  log('download', `Starting: ${job.videoId} "${job.title}"`);
  log('download', `Command: yt-dlp ${args.join(' ')}`);

  const proc = spawn('yt-dlp', args);
  let buf = '';

  const onData = (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      // Filter out known benign noise to keep logs readable
      const isNoise = /NotOpenSSLWarning|urllib3 v2|LibreSSL|Deprecated Feature.*Python/i.test(line);
      if (!isNoise) log('yt-dlp', line);
      job.logs.push(line);
      if (job.logs.length > 200) job.logs.shift();

      const pm = line.match(/\[download\]\s+([\d.]+)%/i);
      if (pm) { 
        job.progress = parseFloat(pm[1]); 
        const speedMatch = line.match(/at\s+([~\d.]+\s*[a-zA-Z]+\/s|Unknown\s*B\/s)/i);
        const etaMatch = line.match(/ETA\s+([\d:]+|Unknown)/i);
        if (speedMatch) job.speed = speedMatch[1].trim();
        if (etaMatch) job.eta = etaMatch[1].trim();
      }

      // yt-dlp might download video and audio separately, capture the final merged output
      const mergeMatch = line.match(/Merging formats into "(.+?)"/i);
      if (mergeMatch) {
        job.filePath = mergeMatch[1].trim();
        job.status = 'processing'; 
        job.progress = 99;
      } else {
        // Fallback for single-file downloads
        const dm = line.match(/Destination:\s+(.+?\.(?:mp4|mkv|webm|m4a))/i);
        if (dm && !job.filePath) {
          job.filePath = dm[1].trim();
        }
      }

      // Capture meaningful error lines — keep ALL of them, not just last
      const errMatch = line.match(/ERROR:\s+(.+)/i);
      if (errMatch) {
        job._lastError = errMatch[1].trim();
        log('download', `[ERROR captured] ${job._lastError}`);
      }

      // Warn specifically on 403 so it's easy to spot
      if (/HTTP Error 403/i.test(line)) {
        log('download', `[403 THROTTLE] Video ${job.videoId} — YouTube is throttling this format. Consider using Stream instead.`);
      }
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code) => {
    if (code === 0) {
      job.status = 'done'; job.progress = 100; job.speed = ''; job.eta = '';
      log('download', `Done: ${job.videoId}`);
      if (job.filePath && fs.existsSync(job.filePath)) {
        // Replace whatever extension we ended up with (.mkv, .webm, .mp4) with .json
        const metaPath = job.filePath.replace(/\.[^.]+$/, '.json');
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
      job.error = job._lastError || `yt-dlp exited with code ${code}`;
      log('download', `FAILED: ${job.videoId} — ${job.error}`);
      log('download', `Last 5 log lines for ${job.videoId}:`);
      job.logs.slice(-5).forEach(l => log('download', `  | ${l}`));
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

app.delete('/api/library/:filename', (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

  try {
    fs.unlinkSync(filePath);
    const metaPath = filePath.replace(/\.[^.]+$/, '.json');
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream — local downloaded files
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
// Stream-YT — ad-free YouTube streaming via youtubei.js (InnerTube API)
//
// How it works (same approach as the ta3-android app's NewPipeExtractor):
//   1. Use youtubei.js to call YouTube's internal InnerTube API and get stream info
//   2. Properly decipher the n-token (the thing yt-dlp was failing to do reliably)
//      using Node's vm module to evaluate YouTube's own player JS
//   3. Proxy the deciphered CDN URL bytes to the client, forwarding Range headers
//      so the <video> element can seek.
// ─────────────────────────────────────────────────────────────────────────────

// Lazy-initialised youtubei.js Innertube instance (ESM-only, so use dynamic import)
let _ytClient = null;

async function getYtClient() {
  if (_ytClient) return _ytClient;

  // youtubei.js is ESM-only; use dynamic import from CJS
  const { Innertube, Platform } = await import('youtubei.js');
  const { default: vm } = await import('node:vm');

  // Patch the platform's JS evaluator to use Node's built-in vm module.
  // This is required to decipher YouTube's n-token (anti-throttle parameter).
  // The code generated by youtubei.js ends with a bare `return process(...)`,
  // which is only valid inside a function — so we wrap it.
  Platform.shim.eval = (data) => {
    const code = data.output;
    const wrapped = `(function() { ${code} })()`;
    const ctx = vm.createContext({
      globalThis: {}, window: {}, document: {}, console,
      setTimeout, clearTimeout, URL, URLSearchParams,
    });
    ctx.globalThis = ctx; // __jsExtractorGlobal references globalThis
    return new vm.Script(wrapped).runInContext(ctx);
  };

  _ytClient = await Innertube.create({ retrieve_player: true });
  log('stream-yt', '[youtubei.js] Innertube client initialised');
  return _ytClient;
}

/**
 * Resolve the best video+audio stream URL for a YouTube video.
 * Uses youtubei.js (InnerTube API) — same approach as NewPipeExtractor in the
 * ta3-android app. Properly deciphers the n-token so CDN URLs don't 403.
 *
 * Format priority:
 *   1. video+audio MP4 (H.264) — itag=18, progressive, single file, seekable ✓
 *   2. video+audio best available (any container)
 */
async function resolveYtUrl(videoId) {
  const yt = await getYtClient();
  log('stream-yt', `[resolveYtUrl] Calling InnerTube for ${videoId}…`);

  const info = await yt.getInfo(videoId);

  // Try combined video+audio first (itag 18 = 360p H.264+AAC, most compatible)
  let fmt = info.chooseFormat({ type: 'video+audio', quality: 'best', format: 'mp4' });
  if (!fmt) {
    // Fallback: any video+audio format
    fmt = info.chooseFormat({ type: 'video+audio', quality: 'best' });
  }
  if (!fmt) throw new Error('No compatible stream format found');

  log('stream-yt', `[resolveYtUrl] Selected format: itag=${fmt.itag} quality=${fmt.quality_label} mime=${fmt.mime_type}`);

  const url = await fmt.decipher(yt.session.player);
  if (!url || !url.startsWith('http')) throw new Error('decipher() returned invalid URL');

  log('stream-yt', `[resolveYtUrl] Deciphered URL (first 100): ${url.slice(0, 100)}…`);
  return url;
}

/**
 * GET /api/stream-yt/:videoId
 *
 * Resolves the direct CDN stream URL via youtubei.js InnerTube API (n-token
 * properly deciphered — no 403), then proxies bytes to the client.
 * Forwards Range headers so the <video> player can seek.
 */
app.get('/api/stream-yt/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }

  log('stream-yt', `Resolving CDN URL for ${videoId}…`);

  let streamUrl;
  try {
    streamUrl = await resolveYtUrl(videoId);
  } catch (err) {
    log('stream-yt', `[FAIL] URL resolve for ${videoId}: ${err.message}`);
    return res.status(502).json({ error: 'Could not resolve stream URL', detail: err.message });
  }

  log('stream-yt', `[OK] Proxying stream for ${videoId}`);

  // ── Proxy CDN bytes to the client ─────────────────────────────────────────
  const forwardHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Referer': 'https://www.youtube.com/',
    'Origin': 'https://www.youtube.com',
    'Connection': 'keep-alive',
  };
  if (req.headers.range) {
    forwardHeaders['Range'] = req.headers.range;
    log('stream-yt', `Range: ${req.headers.range}`);
  }

  try {
    const upRes = await fetch(streamUrl, {
      method: 'GET',
      headers: forwardHeaders,
      redirect: 'follow',
      // AbortController to cancel upstream fetch if client disconnects
      signal: req.signal 
    });

    log('stream-yt', `CDN HTTP ${upRes.status} for ${videoId}`);

    if (upRes.status === 403) {
      log('stream-yt', `[403] CDN refused ${videoId} — URL may have expired; try again`);
      if (!res.headersSent) res.status(502).json({ error: 'YouTube CDN returned 403 — please try again' });
      return;
    }

    const pass = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const val = upRes.headers.get(h);
      if (val) pass[h] = val;
    }
    pass['Access-Control-Allow-Origin'] = '*';

    res.writeHead(upRes.status, pass);
    
    // Node.js 18+ can pipe Web Streams via stream.Readable.fromWeb
    if (upRes.body) {
      const { Readable } = require('stream');
      Readable.fromWeb(upRes.body).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      log('stream-yt', `Client disconnected ${videoId}`);
    } else {
      log('stream-yt', `[ERROR] Connect failed for ${videoId}: ${e.message}`);
      if (!res.headersSent) res.status(502).json({ error: 'Upstream request failed', detail: e.message });
    }
  }
});

/**
 * GET /api/stream-yt/:videoId/info — debug endpoint: returns all available formats
 */
app.get('/api/stream-yt/:videoId/info', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }
  log('stream-yt', `[INFO] Format list for ${videoId}`);
  try {
    const yt = await getYtClient();
    const info = await yt.getInfo(videoId);
    const formats = info.streaming_data?.formats?.map(f => ({
      itag: f.itag, mime: f.mime_type, quality: f.quality_label,
      bitrate: f.bitrate, fps: f.fps, width: f.width, height: f.height,
    })) || [];
    const adaptive = info.streaming_data?.adaptive_formats?.map(f => ({
      itag: f.itag, mime: f.mime_type, quality: f.quality_label,
      bitrate: f.bitrate, fps: f.fps, width: f.width, height: f.height,
    })) || [];
    res.json({ videoId, formats, adaptive_formats: adaptive });
  } catch (err) {
    log('stream-yt', `[INFO FAIL] ${videoId}: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ytdlpJson(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', ['--dump-json', ...args]);
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
