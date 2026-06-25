'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   YouTube TV Downloader — Main Application
   Handles: screen routing, D-pad navigation, API calls, rendering
   ═══════════════════════════════════════════════════════════════════════════ */

const SERVER = CONFIG.SERVER_URL;

// ─── Tiny helpers ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function fmtSize(bytes) {
  if (!bytes) return '';
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

// ─── API client ──────────────────────────────────────────────────────────────
const api = {
  async get(path) {
    const r = await fetch(`${SERVER}${path}`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(`${SERVER}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
};

// ─── App State ───────────────────────────────────────────────────────────────
const State = {
  screen:       'login',   // login | main | player
  section:      'home',    // home | search | library | downloads

  homeVideos:   [],
  searchVideos: [],
  libraryFiles: [],
  jobs:         [],
  selectedVideo: null,     // for modal
  playerFile:    null,

  authPollTimer: null,
  jobPollTimer:  null,
  playerUITimer: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION  (D-pad / keyboard focus manager)
// ─────────────────────────────────────────────────────────────────────────────
const Nav = {
  zone: 'login',   // login | sidebar | content | searchbar | modal | player
  idx:  0,

  // Return visible focusable elements for a given zone
  els(zone) {
    zone = zone || this.zone;
    const fz = zone === 'content'
      ? `#section-${State.section} .video-card`
      : `[data-focuszone="${zone}"]`;
    return [...document.querySelectorAll(fz)]
      .filter(el => !el.classList.contains('hidden') && el.offsetParent !== null)
      .sort((a, b) => {
        const ai = parseInt(a.dataset.focusidx || 0);
        const bi = parseInt(b.dataset.focusidx || 0);
        return ai - bi;
      });
  },

  // Move focus to a specific zone + index
  set(zone, idx = 0) {
    // Blur any natively focused input so the TV keyboard doesn't pop up
    if (document.activeElement && document.activeElement.tagName === 'INPUT') {
      document.activeElement.blur();
    }

    // Remove previous focus
    document.querySelectorAll('.focused').forEach(el => el.classList.remove('focused'));

    this.zone = zone;
    const list = this.els(zone);
    if (!list.length) { this.idx = 0; return; }

    this.idx = Math.max(0, Math.min(idx, list.length - 1));
    const el = list[this.idx];
    el.classList.add('focused');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // Move by delta within zone (clamp)
  move(delta) { this.set(this.zone, this.idx + delta); },

  // Number of visible grid columns for current content section
  gridCols() {
    const grid = document.querySelector(`#section-${State.section} .video-grid`);
    if (!grid) return 4;
    const cards = [...grid.querySelectorAll('.video-card')];
    if (cards.length < 2) return 1;
    const refTop = cards[0].getBoundingClientRect().top;
    let cols = 1;
    for (let i = 1; i < Math.min(cards.length, 10); i++) {
      if (Math.abs(cards[i].getBoundingClientRect().top - refTop) > 5) break;
      cols++;
    }
    return cols;
  },

  // Sidebar index for current section
  sidebarIdx() {
    return ['home', 'search', 'library', 'downloads'].indexOf(State.section);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// KEY HANDLER
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const key = e.key;

  // Universal back actions
  if (key === 'Backspace' || key === 'BrowserBack' || key === 'Escape') {
    if (State.screen === 'player') { closePlayer(); e.preventDefault(); return; }
    if (!$('modal-video').classList.contains('hidden')) { closeModal(); e.preventDefault(); return; }
    if (Nav.zone === 'content' || Nav.zone === 'searchbar') {
      Nav.set('sidebar', Nav.sidebarIdx()); e.preventDefault(); return;
    }
  }

  switch (Nav.zone) {
    case 'login':     handleLoginKey(key);     break;
    case 'sidebar':   handleSidebarKey(key);   break;
    case 'content':   handleContentKey(key);   break;
    case 'searchbar': handleSearchbarKey(key); break;
    case 'modal':     handleModalKey(key);     break;
    case 'player':    handlePlayerKey(key);    break;
  }

  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter'].includes(key)) {
    e.preventDefault();
  }
});

function handleLoginKey(key) {
  if (key === 'ArrowDown') Nav.move(1);
  else if (key === 'ArrowUp') Nav.move(-1);
  else if (key === 'Enter') Nav.els()[Nav.idx]?.click();
}

function handleSidebarKey(key) {
  if      (key === 'ArrowDown')  Nav.move(1);
  else if (key === 'ArrowUp')    Nav.move(-1);
  else if (key === 'ArrowRight') {
    if (State.section === 'search') Nav.set('searchbar', 0);
    else Nav.set('content', 0);
  }
  else if (key === 'Enter') Nav.els()[Nav.idx]?.click();
}

function handleContentKey(key) {
  const cols = Nav.gridCols();
  const total = Nav.els('content').length;

  if (key === 'ArrowRight') {
    if (Nav.idx + 1 < total) Nav.move(1);
  } else if (key === 'ArrowLeft') {
    if (Nav.idx % cols === 0) Nav.set('sidebar', Nav.sidebarIdx());
    else Nav.move(-1);
  } else if (key === 'ArrowDown') {
    Nav.set('content', Math.min(Nav.idx + cols, total - 1));
  } else if (key === 'ArrowUp') {
    const next = Nav.idx - cols;
    if (next < 0) Nav.set('sidebar', Nav.sidebarIdx());
    else Nav.set('content', next);
  } else if (key === 'Enter') {
    Nav.els('content')[Nav.idx]?.click();
  }
}

function handleSearchbarKey(key) {
  const els = Nav.els('searchbar');
  if      (key === 'ArrowRight') Nav.move(1);
  else if (key === 'ArrowLeft') {
    if (Nav.idx === 0) Nav.set('sidebar', Nav.sidebarIdx());
    else Nav.move(-1);
  }
  else if (key === 'ArrowDown') Nav.set('content', 0);
  else if (key === 'Enter') {
    const el = els[Nav.idx];
    if (el?.tagName === 'INPUT') el.focus();
    else el?.click();
  }
}

function handleModalKey(key) {
  if      (key === 'ArrowRight') Nav.move(1);
  else if (key === 'ArrowLeft')  Nav.move(-1);
  else if (key === 'Enter')      Nav.els()[Nav.idx]?.click();
}

function handlePlayerKey(key) {
  showPlayerUI();
  if      (key === 'ArrowLeft')  Nav.move(-1);
  else if (key === 'ArrowRight') Nav.move(1);
  else if (key === 'Enter')      Nav.els()[Nav.idx]?.click();
  else if (key === ' ')          togglePlayPause();
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN & SECTION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  State.screen = name;
}

function showSection(name) {
  document.querySelectorAll('.content-section').forEach(s => s.classList.add('hidden'));
  document.getElementById(`section-${name}`).classList.remove('hidden');
  State.section = name;

  // Update sidebar active state
  document.querySelectorAll('.nav-item[data-target]').forEach(el => {
    el.classList.toggle('active', el.dataset.target === name);
  });

  // Load data for the section
  if      (name === 'home')      loadHome();
  else if (name === 'library')   loadLibrary();
  else if (name === 'downloads') loadJobs();
  else if (name === 'search') {
    Nav.set('searchbar', 0);
    $('search-input').focus();
    return;
  }

  Nav.set('content', 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
async function checkAuthStatus() {
  try {
    const data = await api.get('/api/auth/status');
    return data;
  } catch {
    return null;
  }
}

async function verifyAuth() {
  const msgEl = $('auth-status-msg');
  const errEl = $('auth-error');
  const btn   = $('btn-verify');

  msgEl.textContent = 'Checking…';
  errEl.classList.add('hidden');
  btn.disabled = true;

  try {
    const data = await api.post('/api/auth/verify', {});
    if (data.status === 'authenticated') {
      showToast('✓ Connected!');
      transitionToMain(data);
    } else {
      msgEl.textContent = data.message || 'Not logged in to YouTube in Chrome';
      $('auth-error-msg').textContent = data.message || 'Log into YouTube in Chrome first';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    msgEl.textContent = 'Cannot reach server';
    $('auth-error-msg').textContent = 'Cannot reach server at ' + SERVER;
    errEl.classList.remove('hidden');
    showToast('Cannot reach server. Is it running?');
  } finally {
    btn.disabled = false;
  }
}

function transitionToMain(authData) {
  // Update home title based on whether we have auth
  const isAuthed = authData && authData.status === 'authenticated';
  const homeTitle = $('home-title');
  if (homeTitle) homeTitle.textContent = isAuthed ? 'Subscriptions' : 'Trending';

  showScreen('main');
  showSection('home');
  Nav.set('sidebar', 0);
  startJobPolling();
  api.get('/api/library').then(files => { State.libraryFiles = files; }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// HOME FEED
// ─────────────────────────────────────────────────────────────────────────────
async function loadHome() {
  const grid = $('grid-home');
  grid.innerHTML = renderSkeletons(12);

  try {
    const data = await api.get('/api/home');
    State.homeVideos = data.videos || [];
    renderVideoGrid(grid, State.homeVideos);
    Nav.set('content', 0);
  } catch (err) {
    grid.innerHTML = renderEmpty('⊞', 'Could not load subscriptions', err.message.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────────────────────────
async function doSearch() {
  const q = $('search-input').value.trim();
  if (!q) return;

  const grid = $('grid-search');
  grid.innerHTML = renderSkeletons(12);
  Nav.set('content', 0);

  try {
    const data = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    State.searchVideos = data.videos || [];
    renderVideoGrid(grid, State.searchVideos);
    Nav.set('content', 0);
  } catch (err) {
    grid.innerHTML = renderEmpty('⌕', 'Search failed', err.message.slice(0, 100));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIBRARY
// ─────────────────────────────────────────────────────────────────────────────
async function loadLibrary() {
  const grid = $('grid-library');
  grid.innerHTML = renderSkeletons(6);

  try {
    State.libraryFiles = await api.get('/api/library');
    renderLibraryGrid(grid);
    Nav.set('content', 0);
  } catch (err) {
    grid.innerHTML = renderEmpty('▤', 'Library error', err.message.slice(0, 100));
  }
}

function renderLibraryGrid(grid) {
  if (!State.libraryFiles.length) {
    grid.innerHTML = renderEmpty('▤', 'No downloads yet', 'Browse Home or Search to find videos to download');
    return;
  }
  grid.innerHTML = '';
  State.libraryFiles.forEach((f, i) => {
    const card = makeCard({
      idx:       i,
      title:     f.title,
      channel:   f.channel,
      thumbnail: f.thumbnail,
      badge:     '<div class="card-badge badge-downloaded">▶ Play</div>',
    });
    card.addEventListener('click', () => playFile(f));
    grid.appendChild(card);
  });
  lazyLoadImages(grid);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD JOBS
// ─────────────────────────────────────────────────────────────────────────────
async function loadJobs() { await refreshJobs(); }

async function refreshJobs() {
  try {
    State.jobs = await api.get('/api/jobs');
    if (State.section === 'downloads') renderJobs();
  } catch { /* ignore */ }
}

function renderJobs() {
  const list = $('jobs-list');
  if (!State.jobs.length) {
    list.innerHTML = renderEmpty('⬇', 'No downloads yet', 'Select a video and press Download');
    return;
  }

  list.innerHTML = State.jobs.map(job => {
    const pct = job.progress || 0;
    const fillCls = job.status === 'done' ? 'success' : job.status === 'error' ? 'error' : '';
    const statusColor = {
      done: 'var(--success)', error: 'var(--danger)',
      downloading: 'var(--warning)', processing: 'var(--info)', queued: 'var(--text-3)',
    }[job.status] || 'var(--text-2)';

    const thumbEl = job.thumbnail
      ? `<img class="job-thumb" src="${esc(job.thumbnail)}" loading="lazy" alt="">`
      : `<div class="job-thumb-icon">▶</div>`;

    return `
      <div class="job-item">
        ${thumbEl}
        <div class="job-info">
          <div class="job-title">${esc(job.title)}</div>
          <div class="job-progress-bar">
            <div class="job-progress-fill ${fillCls}" style="width:${pct}%"></div>
          </div>
          <div class="job-meta">
            ${job.speed ? `<span>${esc(job.speed)}</span>` : ''}
            ${job.eta   ? `<span>ETA ${esc(job.eta)}</span>` : ''}
          </div>
        </div>
        <div class="job-status" style="color:${statusColor}">
          ${job.status === 'downloading' ? `${Math.round(pct)}%` : capitalize(job.status)}
        </div>
      </div>`;
  }).join('');
}

function startJobPolling() {
  if (State.jobPollTimer) return;
  State.jobPollTimer = setInterval(refreshJobs, 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO GRID (home + search)
// ─────────────────────────────────────────────────────────────────────────────
function renderVideoGrid(grid, videos) {
  if (!videos.length) {
    grid.innerHTML = renderEmpty('⊞', 'No videos found', '');
    return;
  }
  grid.innerHTML = '';

  // Build lookup sets for badge display
  const downloadedIds  = new Set(State.libraryFiles.map(f => f.videoId).filter(Boolean));
  const downloadingIds = new Set(
    State.jobs.filter(j => ['queued', 'downloading', 'processing'].includes(j.status)).map(j => j.videoId)
  );

  videos.forEach((v, i) => {
    const isDownloaded  = downloadedIds.has(v.id);
    const isDownloading = downloadingIds.has(v.id);

    let badge = '';
    if (isDownloaded)  badge = '<div class="card-badge badge-downloaded">▶ Downloaded</div>';
    else if (isDownloading) badge = '<div class="card-badge badge-downloading">⬇ Downloading</div>';

    const card = makeCard({
      idx:       i,
      title:     v.title,
      channel:   v.channel,
      thumbnail: v.thumbnail || `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
      duration:  v.durationStr,
      badge,
    });

    card.addEventListener('click', () => openModal(v, isDownloaded, isDownloading));
    grid.appendChild(card);
  });

  lazyLoadImages(grid);
}

function makeCard({ idx, title, channel, thumbnail, duration, badge }) {
  const card = document.createElement('div');
  card.className = 'video-card';
  card.dataset.focuszone = 'content';
  card.dataset.focusidx  = String(idx);

  const thumbHtml = thumbnail
    ? `<img class="card-thumb" src="${esc(thumbnail)}" loading="lazy" alt="">`
    : `<div class="card-thumb-icon">▶</div>`;

  card.innerHTML = `
    <div class="card-thumb-wrap">
      ${thumbHtml}
      ${badge || ''}
      ${duration ? `<div class="card-duration">${esc(duration)}</div>` : ''}
    </div>
    <div class="card-body">
      <div class="card-title">${esc(title)}</div>
      <div class="card-channel">${esc(channel || '')}</div>
    </div>`;

  return card;
}

function lazyLoadImages(container) {
  container.querySelectorAll('.card-thumb').forEach(img => {
    if (img.complete && img.naturalWidth) {
      img.classList.add('loaded');
    } else {
      img.addEventListener('load',  () => img.classList.add('loaded'),   { once: true });
      img.addEventListener('error', () => img.style.display = 'none',    { once: true });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MODAL
// ─────────────────────────────────────────────────────────────────────────────
function openModal(video, isDownloaded, isDownloading) {
  State.selectedVideo = video;

  $('modal-thumb').src       = video.thumbnail || `https://img.youtube.com/vi/${video.id}/mqdefault.jpg`;
  $('modal-title').textContent    = video.title;
  $('modal-channel').textContent  = video.channel || '';
  $('modal-duration').textContent = video.durationStr ? `Duration: ${video.durationStr}` : '';

  const btnDownload = $('modal-btn-download');
  const btnPlay     = $('modal-btn-play');

  if (isDownloaded) {
    btnDownload.classList.add('hidden');
    btnPlay.classList.remove('hidden');
    Nav.set('modal', 0); // play is idx=1 but download is hidden so play becomes first visible
  } else if (isDownloading) {
    btnDownload.textContent = '⬇ Downloading…';
    btnDownload.disabled    = true;
    btnPlay.classList.add('hidden');
    Nav.set('modal', 0);
  } else {
    btnDownload.textContent = '⬇ Download';
    btnDownload.disabled    = false;
    btnPlay.classList.add('hidden');
    Nav.set('modal', 0);
  }

  $('modal-video').classList.remove('hidden');
}

function closeModal() {
  $('modal-video').classList.add('hidden');
  Nav.set('content', Nav.idx);
}

async function downloadSelected() {
  const v = State.selectedVideo;
  if (!v) return;

  try {
    await api.post('/api/download', {
      videoId:   v.id,
      title:     v.title,
      thumbnail: v.thumbnail,
      channel:   v.channel,
    });
    showToast(`⬇ Queued: "${v.title.slice(0, 40)}…"`);
    closeModal();
    showSection('downloads');
    Nav.set('sidebar', 3);
  } catch (err) {
    showToast('Download failed: ' + err.message.slice(0, 60));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER
// ─────────────────────────────────────────────────────────────────────────────
function playFile(file) {
  State.playerFile = file;
  const video = $('video-player');

  video.src = `${SERVER}/api/stream/${encodeURIComponent(file.filename)}`;
  $('player-title-text').textContent = file.title || file.filename;

  showScreen('player');
  Nav.set('player', 1);

  video.play().catch(() => {});
  showPlayerUI();
}

function setupPlayerUI() {
  const video = $('video-player');
  const fill  = $('player-progress-fill');
  const thumb = $('player-progress-thumb');
  const cur   = $('player-time-current');
  const tot   = $('player-time-total');
  const btn   = $('btn-play-pause');

  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    fill.style.width  = pct + '%';
    thumb.style.right = `${100 - pct}%`;
    cur.textContent   = fmtTime(video.currentTime);
  });
  video.addEventListener('loadedmetadata', () => { tot.textContent = fmtTime(video.duration); });
  video.addEventListener('play',  () => { btn.textContent = '⏸'; });
  video.addEventListener('pause', () => { btn.textContent = '▶'; });
  video.addEventListener('ended', () => { showPlayerUI(); });
  video.addEventListener('click', () => { showPlayerUI(); togglePlayPause(); });

  // Click on progress bar to seek
  $('player-progress-track').addEventListener('click', (e) => {
    if (!video.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    video.currentTime = ((e.clientX - rect.left) / rect.width) * video.duration;
  });
}

function togglePlayPause() {
  const v = $('video-player');
  v.paused ? v.play() : v.pause();
}

function closePlayer() {
  const v = $('video-player');
  v.pause(); v.src = '';
  if (State.playerUITimer) clearTimeout(State.playerUITimer);
  showScreen('main');
  Nav.set('content', 0);
}

function showPlayerUI() {
  $('player-ui').classList.remove('hide-ui');
  if (State.playerUITimer) clearTimeout(State.playerUITimer);
  State.playerUITimer = setTimeout(() => {
    if (!$('video-player').paused) $('player-ui').classList.add('hide-ui');
  }, 4000);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON & EMPTY HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function renderSkeletons(n) {
  return Array.from({ length: n }, () => `
    <div class="skel-card">
      <div class="skel-thumb skeleton"></div>
      <div class="skel-body">
        <div class="skel-title skeleton"></div>
        <div class="skel-sub skeleton"></div>
      </div>
    </div>`).join('');
}

function renderEmpty(icon, title, sub) {
  return `<div class="empty-state">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">${esc(title)}</div>
    ${sub ? `<div class="empty-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
async function init() {
  // ── Login screen ──
  $('btn-verify').addEventListener('click', verifyAuth);
  $('btn-retry').addEventListener('click',  verifyAuth);

  // ── Sidebar nav items ──
  document.querySelectorAll('.nav-item[data-target]').forEach(el => {
    el.addEventListener('click', () => {
      showSection(el.dataset.target);
      const idx = ['home', 'search', 'library', 'downloads'].indexOf(el.dataset.target);
      Nav.set('sidebar', idx);
    });
  });

  // ── Sign out ──
  document.querySelector('[data-action="signout"]').addEventListener('click', async () => {
    try { await api.post('/api/auth/logout', {}); } catch { /* ignore */ }
    if (State.jobPollTimer)  clearInterval(State.jobPollTimer);
    if (State.authPollTimer) clearInterval(State.authPollTimer);
    State.jobPollTimer  = null;
    State.authPollTimer = null;
    $('auth-code-box').classList.add('hidden');
    $('auth-error').classList.add('hidden');
    showScreen('login');
    Nav.set('login', 0);
  });

  // ── Section refresh buttons ──
  $('btn-refresh-home').addEventListener('click',    loadHome);
  $('btn-refresh-library').addEventListener('click', loadLibrary);
  $('btn-refresh-jobs').addEventListener('click',    loadJobs);

  // ── Search ──
  $('btn-search').addEventListener('click', doSearch);
  $('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
  // Return focus to Nav when input loses focus via Escape
  $('search-input').addEventListener('blur', () => {
    if (Nav.zone === 'searchbar') Nav.set('searchbar', 0);
  });

  // ── Modal ──
  $('modal-btn-download').addEventListener('click', downloadSelected);
  $('modal-btn-close').addEventListener('click',    closeModal);
  $('modal-backdrop').addEventListener('click',     closeModal);
  $('modal-btn-play').addEventListener('click', () => {
    const v = State.selectedVideo;
    if (!v) return;
    const file = State.libraryFiles.find(f => f.videoId === v.id);
    if (file) { closeModal(); playFile(file); }
    else showToast('File not found in library');
  });

  // ── Player ──
  $('btn-player-back').addEventListener('click', closePlayer);
  $('btn-play-pause').addEventListener('click',  togglePlayPause);
  setupPlayerUI();

  // ── Check auth on load ──
  try {
    const msgEl = $('auth-status-msg');
    const status = await api.get('/api/auth/status');

    if (status.status === 'authenticated') {
      transitionToMain(status);
    } else if (status.status === 'checking') {
      // Server is still doing the initial cookie check — poll until done
      msgEl.textContent = 'Checking Chrome cookies…';
      const poll = setInterval(async () => {
        try {
          const s = await api.get('/api/auth/status');
          if (s.status !== 'checking') {
            clearInterval(poll);
            if (s.status === 'authenticated') {
              transitionToMain(s);
            } else {
              msgEl.textContent = s.message || 'Log into YouTube in Chrome, then click Verify';
              Nav.set('login', 0);
            }
          }
        } catch { clearInterval(poll); }
      }, 1000);
    } else {
      msgEl.textContent = status.message || 'Log into YouTube in Chrome, then click Verify';
      Nav.set('login', 0);
    }
  } catch {
    $('auth-status-msg').textContent = 'Cannot reach server';
    showToast('⚠ Cannot reach server at ' + SERVER);
    Nav.set('login', 0);
  }
}

document.addEventListener('DOMContentLoaded', init);
