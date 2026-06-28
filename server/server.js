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

// Background cache refresh interval (default 30 min). Override with CACHE_REFRESH_MS env var.
const CACHE_REFRESH_MS = parseInt(process.env.CACHE_REFRESH_MS) || 30 * 60 * 1000;

// Number of pages to pre-cache per topic
const CACHE_PAGES = 10;

// Max concurrent yt-dlp processes during cache warm. Override with CACHE_CONCURRENCY env var.
const CACHE_CONCURRENCY = parseInt(process.env.CACHE_CONCURRENCY) || 4;

// Topics to cache (chip categories + home)
const CHIP_TOPICS = ['Music', 'Gaming', 'News', 'Comedy', 'Podcasts', 'Programming'];

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
  userId:  null,       // Stable ID derived from the YouTube account (e.g. channel handle)
  displayName: null,   // Human-readable account name shown in the UI
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
 * Derive a stable userId from the current browser session.
 * We run yt-dlp on a known YouTube URL that returns the uploader/channel
 * of the logged-in user. Falls back to 'anonymous'.
 */
async function detectUserId() {
  return new Promise((resolve) => {
    // Use the YouTube homepage's channel_url as user identity signal.
    // --flat-playlist --playlist-items 1 exits quickly after the first item.
    const proc = spawn('yt-dlp', [
      '--cookies-from-browser', BROWSER,
      '--flat-playlist', '--playlist-items', '1',
      '--print', 'uploader_id',
      '--no-warnings', '--quiet',
      'https://www.youtube.com/',
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      const id = out.trim().split('\n')[0]?.trim();
      resolve(id && id.length > 0 ? `yt_${id}` : 'authenticated_user');
    });
    proc.on('error', () => resolve('authenticated_user'));
    setTimeout(() => { proc.kill(); resolve('authenticated_user'); }, 15000);
  });
}

/**
 * Checks if browser cookies give us authenticated YouTube access.
 * Uses ytdlpJson() directly — the exact same code path as real home feed fetches.
 * If fetching one video from the homepage works, auth is confirmed.
 */
async function checkAuth() {
  try {
    const videos = await ytdlpJson([
      '--cookies-from-browser', BROWSER,
      '--flat-playlist', '--no-warnings',
      '--playlist-items', '1',
      'https://www.youtube.com/',
    ]);
    return videos.length > 0;
  } catch (err) {
    log('auth', `checkAuth failed: ${err.message.slice(0, 120)}`);
    return false;
  }
}

// Run auth check on startup
(async () => {
  console.log(`[auth] Checking ${BROWSER} cookies…`);
  const ok = await checkAuth();
  if (ok) {
    authState.status  = 'authenticated';
    authState.message = `Using ${BROWSER} cookies`;
    console.log(`[auth] ✓ Authenticated via ${BROWSER}`);
    // Detect user identity in background (non-blocking)
    detectUserId().then(userId => {
      authState.userId = userId;
      authState.displayName = userId.replace(/^yt_@?/, '');
      log('auth', `User ID: ${userId}`);
      // Start cache warming for this user
      scheduleWarmCache(userId);
    });
  } else {
    authState.status  = 'unauthenticated';
    authState.userId  = 'anonymous';
    authState.message = `Log into YouTube in ${BROWSER} on this Mac, then click Verify`;
    console.log(`[auth] ✗ Not authenticated — log into YouTube in ${BROWSER}`);
    // Still warm the anonymous/trending cache
    scheduleWarmCache('anonymous');
  }
})();

// GET /api/auth/status
app.get('/api/auth/status', (_req, res) => res.json(authState));

// POST /api/auth/verify — re-runs the cookie check
app.post('/api/auth/verify', async (_req, res) => {
  authState.status = 'checking';
  const ok = await checkAuth();
  if (ok) {
    authState.status  = 'authenticated';
    authState.message = `Using ${BROWSER} cookies`;
    // Detect user ID and warm their cache
    const userId = await detectUserId();
    authState.userId = userId;
    authState.displayName = userId.replace(/^yt_@?/, '');
    log('auth', `Verified as userId: ${userId}`);
    // Start warming this user's cache if not already done
    scheduleWarmCache(userId);
  } else {
    authState.status  = 'unauthenticated';
    authState.userId  = 'anonymous';
    authState.displayName = null;
    authState.message = `Log into YouTube in ${BROWSER} on this Mac, then click Verify`;
  }
  res.json(authState);
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-User Content Cache
//
// Structure:
//   contentCache[userId][topic][page] = {
//     videos:    [...],
//     fetchedAt: <timestamp ms>,
//     ready:     true,
//   }
//
// 'topic' is either 'home' or a chip label like 'Music', 'Gaming', etc.
// userId is derived from the YouTube account handle (or 'anonymous').
// Cache is NEVER evicted on logout — switching users re-uses the existing cache.
// ─────────────────────────────────────────────────────────────────────────────

const contentCache = {};        // userId → topic → page → entry
const warmingLock  = {};        // userId → boolean (prevents concurrent warm runs)
const refreshTimers = {};       // userId → timer handle

function getUserCache(userId) {
  if (!contentCache[userId]) {
    contentCache[userId] = {};
  }
  return contentCache[userId];
}

function getCacheEntry(userId, topic, page) {
  const uc = getUserCache(userId);
  if (!uc[topic]) uc[topic] = {};
  return uc[topic][page] || null;
}

function setCacheEntry(userId, topic, page, videos) {
  const uc = getUserCache(userId);
  if (!uc[topic]) uc[topic] = {};
  uc[topic][page] = { videos, fetchedAt: Date.now(), ready: true };
}

/**
 * Fetch videos for a given topic+page using yt-dlp.
 * Always uses cookies — userId is only used as a cache key, not an auth gate.
 * Home always uses https://www.youtube.com/ (works for both authed + unauthed;
 * the trending URL is broken in recent yt-dlp versions).
 */
async function fetchVideosForTopic(userId, topic, page) {
  const pageSize = 24;
  const start = (page - 1) * pageSize + 1;
  const end   = page * pageSize;

  // Always try cookies — if the user is logged in, content is personalised;
  // if not, YouTube just ignores the cookies and returns generic content.
  const cookies = ['--cookies-from-browser', BROWSER];

  if (topic === 'home') {
    // https://www.youtube.com/ works for both logged-in (personalised) and
    // logged-out (generic) users. feed/trending is broken in recent yt-dlp.
    return ytdlpJson([
      ...cookies,
      '--flat-playlist', '--no-warnings',
      '--playlist-start', String(start),
      '--playlist-end',   String(end),
      'https://www.youtube.com/',
    ]);
  } else {
    return ytdlpJson([
      ...cookies,
      '--flat-playlist', '--no-warnings',
      '--playlist-start', String(start),
      '--playlist-end',   String(end),
      `ytsearchall:${topic}`,
    ]);
  }
}

/**
 * Warm the cache for a given user — fetches CACHE_PAGES pages for every topic.
 * Pages are fetched sequentially to avoid hammering yt-dlp.
 * Already-cached entries that are still fresh (< CACHE_REFRESH_MS) are skipped.
 */
async function warmCache(userId) {
  if (warmingLock[userId]) {
    log('cache', `[${userId}] Warm already in progress — skipping`);
    return;
  }
  warmingLock[userId] = true;

  const topics = ['home', ...CHIP_TOPICS];

  // Build a flat queue of all (topic, page) pairs that need fetching
  const queue = [];
  for (const topic of topics) {
    for (let page = 1; page <= CACHE_PAGES; page++) {
      const existing = getCacheEntry(userId, topic, page);
      if (existing && (Date.now() - existing.fetchedAt) < CACHE_REFRESH_MS) continue;
      queue.push({ topic, page });
    }
  }

  if (queue.length === 0) {
    log('cache', `[${userId}] All ${topics.length * CACHE_PAGES} pages are fresh — skipping warm`);
    warmingLock[userId] = false;
    return;
  }

  log('cache', `[${userId}] Warming ${queue.length} pages with concurrency=${CACHE_CONCURRENCY}`);
  const t0 = Date.now();

  // Concurrency-limited parallel fetcher
  // Each worker drains the shared queue independently
  let idx = 0;
  async function worker() {
    while (true) {
      const item = queue[idx++];
      if (!item) break;
      const { topic, page } = item;
      try {
        const videos = await fetchVideosForTopic(userId, topic, page);
        setCacheEntry(userId, topic, page, videos);
        log('cache', `[${userId}] ✓ ${topic} p${page} — ${videos.length} videos`);
      } catch (err) {
        log('cache', `[${userId}] ✗ ${topic} p${page} — ${err.message.slice(0, 80)}`);
        // Don't abort — other workers continue
      }
    }
  }

  // Launch CACHE_CONCURRENCY workers and wait for all to drain the queue
  await Promise.allSettled(
    Array.from({ length: Math.min(CACHE_CONCURRENCY, queue.length) }, worker)
  );

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log('cache', `[${userId}] Cache warm complete in ${elapsed}s`);
  warmingLock[userId] = false;
}

/**
 * Schedule periodic cache refresh for a user.
 * On first call, immediately starts warming; subsequent runs repeat every CACHE_REFRESH_MS.
 */
function scheduleWarmCache(userId) {
  // Avoid duplicate timers for the same user
  if (refreshTimers[userId]) return;

  // Warm immediately (non-blocking)
  warmCache(userId).catch(err => log('cache', `[${userId}] Warm error: ${err.message}`));

  // Then refresh on a schedule
  refreshTimers[userId] = setInterval(() => {
    log('cache', `[${userId}] Scheduled refresh triggered`);
    warmCache(userId).catch(err => log('cache', `[${userId}] Refresh error: ${err.message}`));
  }, CACHE_REFRESH_MS);
}



// ─────────────────────────────────────────────────────────────────────────────
// Cache Status endpoint — useful for debugging
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/cache/status', (_req, res) => {
  const summary = {};
  for (const [userId, topicMap] of Object.entries(contentCache)) {
    summary[userId] = {};
    for (const [topic, pages] of Object.entries(topicMap)) {
      summary[userId][topic] = {
        pagesReady: Object.values(pages).filter(e => e.ready).length,
        pages: Object.fromEntries(
          Object.entries(pages).map(([page, e]) => [
            page,
            {
              ready:     e.ready,
              count:     e.videos?.length ?? 0,
              fetchedAt: e.fetchedAt ? new Date(e.fetchedAt).toISOString() : null,
              ageMs:     e.fetchedAt ? Date.now() - e.fetchedAt : null,
            }
          ])
        )
      };
    }
  }
  res.json({
    currentUserId:  authState.userId,
    refreshIntervalMs: CACHE_REFRESH_MS,
    cachePages: CACHE_PAGES,
    warmingNow: Object.entries(warmingLock)
      .filter(([, v]) => v)
      .map(([k]) => k),
    users: summary,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Home Feed — served from cache; falls back to live fetch on cache miss
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/home', async (req, res) => {
  const page   = parseInt(req.query.page) || 1;
  const userId = authState.userId || 'anonymous';

  // Serve from cache if available
  const cached = getCacheEntry(userId, 'home', page);
  if (cached?.ready) {
    return res.json({
      videos:   cached.videos,
      source:   authState.status === 'authenticated' ? 'homepage' : 'trending',
      page,
      cached:   true,
      cachedAt: cached.fetchedAt,
    });
  }

  // Cache miss — fetch live and populate cache
  log('cache', `[${userId}] home p${page} cache miss — fetching live`);
  try {
    const videos = await fetchVideosForTopic(userId, 'home', page);
    setCacheEntry(userId, 'home', page, videos);
    res.json({
      videos,
      source:  authState.status === 'authenticated' ? 'homepage' : 'trending',
      page,
      cached:  false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Chip Categories — served from cache; falls back to live fetch on cache miss
// Client should use this endpoint for chip tabs (Music, Gaming, etc.)
// NOT for user-typed search (use /api/search for that).
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/chips', async (req, res) => {
  const topic  = (req.query.topic || '').trim();
  const page   = parseInt(req.query.page) || 1;
  const userId = authState.userId || 'anonymous';

  if (!topic) return res.status(400).json({ error: 'topic is required' });

  // Serve from cache if available
  const cached = getCacheEntry(userId, topic, page);
  if (cached?.ready) {
    return res.json({
      videos:   cached.videos,
      topic,
      page,
      cached:   true,
      cachedAt: cached.fetchedAt,
    });
  }

  // Cache miss — fetch live
  log('cache', `[${userId}] chips/${topic} p${page} cache miss — fetching live`);
  try {
    const videos = await fetchVideosForTopic(userId, topic, page);
    setCacheEntry(userId, topic, page, videos);
    res.json({ videos, topic, page, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Search — always live, no persistent cache
// ─────────────────────────────────────────────────────────────────────────────

let searchCache   = {};
let searchCacheTs = {};
const SEARCH_TTL  = 10 * 60 * 1000; // 10 min short TTL for search dedup

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });

  const page     = parseInt(req.query.page) || 1;
  const pageSize = 24;
  const start    = (page - 1) * pageSize + 1;
  const end      = page * pageSize;

  const cacheKey = `${q}_${page}`;
  const now      = Date.now();
  if (searchCache[cacheKey] && now - (searchCacheTs[cacheKey] || 0) < SEARCH_TTL) {
    return res.json({ videos: searchCache[cacheKey], cached: true });
  }

  try {
    const videos = await ytdlpJson([
      ...cookieArgs(),
      '--flat-playlist', '--no-warnings',
      '--playlist-start', String(start),
      '--playlist-end',   String(end),
      `ytsearchall:${q}`,
    ]);
    searchCache[cacheKey]   = videos;
    searchCacheTs[cacheKey] = now;
    res.json({ videos, cached: false });
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
      
      let parsedObjects = [];
      const lines = out.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj._type === 'playlist' && Array.isArray(obj.entries)) {
            parsedObjects.push(...obj.entries);
          } else {
            parsedObjects.push(obj);
          }
        } catch { /* ignore */ }
      }

      const videos = parsedObjects.map(v => {
        if (!v || !v.id) return null;
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
  console.log(`⚡  Cache:     ${CACHE_PAGES} pages × ${['home', ...CHIP_TOPICS].length} topics, refresh every ${CACHE_REFRESH_MS / 60000}min`);
  console.log('');
  console.log('Open the app → http://localhost:' + PORT);
});
