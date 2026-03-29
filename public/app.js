/* ── PDF.js worker ── */
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ── ICE servers (STUN + free TURN relay) ── */
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',               username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',              username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 10,
};

/* ── State ── */
const S = {
  socket:       null,
  roomId:       null,
  pdfDoc:       null,
  currentPage:  1,
  totalPages:   0,
  rendering:    false,
  pendingPage:  null,
  zoom:         1.0,
  baseScale:    1.0,
  friendOnline: false,
  bookName:     null,
  bookPath:     null,
  // Voice — multi-peer mesh
  micOn:        false,
  localStream:  null,
  peers:        new Map(),  // peerId -> { pc, iceBuffer }
};

const $ = id => document.getElementById(id);

/* ── Screens ── */
const SCREENS = ['splash', 'waiting', 'reader'];
function show(name) {
  SCREENS.forEach(id => {
    const s = $(id);
    if (id === name) { s.style.display = 'flex'; requestAnimationFrame(() => s.classList.add('active')); }
    else { s.classList.remove('active'); s.style.display = 'none'; }
  });
}

/* ═══════════════════════════════
   SOCKET
═══════════════════════════════ */
function initSocket() {
  S.socket = io();

  S.socket.on('book-updated', ({ bookPath, bookName, currentPage }) => {
    S.bookName = bookName;
    S.bookPath = bookPath;
    $('book-title').textContent = bookName;
    const saved = getBookPage(bookName);
    loadPDF(bookPath, saved || currentPage);
    showToast('"' + bookName + '" loaded');
    if ($('waiting').classList.contains('active')) show('reader');
  });

  S.socket.on('page-synced', ({ page }) => {
    if (page !== S.currentPage) {
      S.currentPage = page;
      renderPage(page);
      updatePageInput(page);
      saveBookPage();
      flashPageChange();
    }
  });

  // A new peer joined — existing users initiate WebRTC to them
  S.socket.on('peer-joined', ({ peerId }) => {
    S.friendOnline = true;
    setFriendOnline(true);
    showToast('Someone joined the room!');
    if ($('waiting').classList.contains('active')) show('reader');
    if (S.micOn && S.localStream) {
      createPeerConnection(peerId, true);
    }
  });

  S.socket.on('peer-left', ({ peerId, userCount }) => {
    removePeer(peerId);
    if (userCount <= 1) { S.friendOnline = false; setFriendOnline(false); }
    showToast('Someone left the room');
  });

  // Legacy compat
  S.socket.on('friend-joined', () => {
    S.friendOnline = true; setFriendOnline(true);
    showToast('Your friend joined!');
    if ($('waiting').classList.contains('active')) show('reader');
  });
  S.socket.on('friend-left', ({ userCount }) => {
    if (userCount <= 1) { S.friendOnline = false; setFriendOnline(false); }
    showToast('Your friend disconnected');
  });

  S.socket.on('reaction', ({ emoji }) => spawnReaction(emoji, false));

  S.socket.on('book-switched', ({ bookPath, bookName, currentPage }) => {
    S.bookName = bookName; S.bookPath = bookPath;
    $('book-title').textContent = bookName;
    loadPDF(bookPath, currentPage);
    showToast('"' + bookName + '" opened');
  });

  // Mic presence
  S.socket.on('peer-mic-on',  () => showToast('Someone turned on mic 🎙️'));
  S.socket.on('peer-mic-off', () => showToast('Someone muted mic 🔇'));
  S.socket.on('friend-mic-on',  () => showToast('Friend turned on mic 🎙️'));
  S.socket.on('friend-mic-off', () => showToast('Friend muted mic 🔇'));

  // ── WebRTC signaling — targeted (from specific peer) ──
  S.socket.on('webrtc-offer', async ({ from, sdp }) => {
    let entry = S.peers.get(from);
    if (!entry) entry = createPeerConnection(from, false);
    const { pc } = entry;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushIceBuffer(from);
      if (S.localStream) {
        S.localStream.getTracks().forEach(t => { try { pc.addTrack(t, S.localStream); } catch(e) {} });
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      S.socket.emit('webrtc-answer', { to: from, sdp: pc.localDescription });
    } catch (e) { console.error('Offer rx error:', e); }
  });

  S.socket.on('webrtc-answer', async ({ from, sdp }) => {
    const entry = S.peers.get(from);
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushIceBuffer(from);
    } catch (e) { console.error('Answer-set error:', e); }
  });

  S.socket.on('webrtc-ice', async ({ from, candidate }) => {
    const entry = S.peers.get(from);
    if (!entry) return;
    if (!entry.pc.remoteDescription) {
      entry.iceBuffer.push(candidate);
    } else {
      try { await entry.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
  });
}

/* ═══════════════════════════════
   WEBRTC — MULTI-PEER MESH
═══════════════════════════════ */
function createPeerConnection(peerId, isOfferer) {
  removePeer(peerId);   // clean up any stale connection

  const pc = new RTCPeerConnection(ICE_CONFIG);
  const entry = { pc, iceBuffer: [] };
  S.peers.set(peerId, entry);

  // Add local audio tracks if mic is already on
  if (S.localStream) {
    S.localStream.getTracks().forEach(t => pc.addTrack(t, S.localStream));
  }

  // Create a dedicated <audio> element for each remote peer
  pc.ontrack = e => {
    let audio = document.getElementById('audio-peer-' + peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-peer-' + peerId;
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };

  pc.onicecandidate = e => {
    if (e.candidate) S.socket.emit('webrtc-ice', { to: peerId, candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected') showToast('🎙️ Voice connected!');
    if (st === 'failed')    pc.restartIce();
    if (st === 'closed')    removePeer(peerId);
  };

  if (isOfferer) {
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        S.socket.emit('webrtc-offer', { to: peerId, sdp: pc.localDescription });
      } catch (e) { console.error('Create offer error:', e); }
    })();
  }

  return entry;
}

function removePeer(peerId) {
  const entry = S.peers.get(peerId);
  if (entry) {
    entry.pc.ontrack = null;
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.close();
    S.peers.delete(peerId);
  }
  const audio = document.getElementById('audio-peer-' + peerId);
  if (audio) audio.remove();
}

function removeAllPeers() {
  for (const id of [...S.peers.keys()]) removePeer(id);
}

async function flushIceBuffer(peerId) {
  const entry = S.peers.get(peerId);
  if (!entry) return;
  for (const c of entry.iceBuffer) {
    try { await entry.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
  }
  entry.iceBuffer = [];
}

/* ── Mic toggle ── */
$('mic-btn').addEventListener('click', toggleMic);

async function toggleMic() {
  if (S.micOn) disableMic();
  else         await enableMic();
}

async function enableMic() {
  try {
    if (!S.localStream || S.localStream.getTracks()[0]?.readyState !== 'live') {
      S.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } else {
      S.localStream.getTracks().forEach(t => { t.enabled = true; });
    }
    S.micOn = true;
    updateMicBtn(true);
    S.socket.emit('mic-on');

    // Add tracks to all existing peer connections
    for (const { pc } of S.peers.values()) {
      S.localStream.getTracks().forEach(t => { try { pc.addTrack(t, S.localStream); } catch(e) {} });
    }
  } catch {
    showToast('Could not access microphone');
  }
}

function disableMic() {
  S.micOn = false;
  if (S.localStream) S.localStream.getTracks().forEach(t => { t.enabled = false; });
  updateMicBtn(false);
  S.socket.emit('mic-off');
}

function updateMicBtn(on) {
  const btn  = $('mic-btn');
  const icon = $('mic-icon');
  btn.classList.toggle('on', on);
  if (on) {
    icon.innerHTML = '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>'
      + '<path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>'
      + '<line x1="12" y1="19" x2="12" y2="23"></line>'
      + '<line x1="8" y1="23" x2="16" y2="23"></line>';
  } else {
    icon.innerHTML = '<line x1="1" y1="1" x2="23" y2="23"></line>'
      + '<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>'
      + '<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .87-.16 1.71-.46 2.49"></path>'
      + '<line x1="12" y1="19" x2="12" y2="23"></line>'
      + '<line x1="8" y1="23" x2="16" y2="23"></line>';
  }
}

/* ═══════════════════════════════
   ROOM – CREATE
═══════════════════════════════ */
$('create-room-btn').addEventListener('click', () => {
  S.socket.emit('create-room', ({ roomId }) => {
    S.roomId = roomId;
    localStorage.setItem('tr:roomId', roomId);
    history.pushState({}, '', '/room/' + roomId);
    $('room-code-display').textContent = roomId;
    $('room-tag-code').textContent = roomId;
    show('waiting');
  });
});

$('copy-code-btn').addEventListener('click', () => {
  const link = window.location.origin + '/room/' + S.roomId;
  navigator.clipboard.writeText(link).then(() => showToast('🔗 Shareable link copied!'));
});

/* ═══════════════════════════════
   ROOM – JOIN
═══════════════════════════════ */
$('join-room-btn').addEventListener('click', () => joinRoom());
$('room-code-input').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('room-code-input').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

function joinRoom(roomId) {
  const code = (roomId || $('room-code-input').value).trim().toUpperCase();
  $('join-error').textContent = '';
  if (code.length < 4) { $('join-error').textContent = 'Please enter the full room code.'; return; }

  S.socket.emit('join-room', { roomId: code }, ({ error, bookPath, bookName, currentPage, userCount, peers }) => {
    if (error) {
      localStorage.removeItem('tr:roomId');
      $('join-error').textContent = error;
      return;
    }
    S.roomId = code;
    localStorage.setItem('tr:roomId', code);
    history.pushState({}, '', '/room/' + code);
    $('room-tag-code').textContent = code;
    if (userCount > 1) { S.friendOnline = true; setFriendOnline(true); }
    show('reader');
    if (bookPath) {
      S.bookName = bookName; S.bookPath = bookPath;
      $('book-title').textContent = bookName;
      const saved = getBookPage(bookName);
      loadPDF(bookPath, saved || currentPage);
    }
    // Connect WebRTC to each existing peer if mic is already on
    if (peers && peers.length && S.micOn && S.localStream) {
      peers.forEach(peerId => createPeerConnection(peerId, true));
    }
  });
}

/* ═══════════════════════════════
   UPLOADS
═══════════════════════════════ */
['book-upload-waiting', 'book-upload-reader', 'book-upload-main'].forEach(id => {
  $(id)?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (file) await uploadBook(file);
    e.target.value = '';
  });
});

async function uploadBook(file) {
  if (file.type !== 'application/pdf') { showToast('Please choose a PDF file'); return; }
  if (!S.roomId) { showToast('You need to be in a room first'); return; }
  showToast('Uploading…');
  const fd = new FormData();
  fd.append('book', file);
  try {
    const res  = await fetch(`/upload/${S.roomId}`, { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) showToast('Upload failed: ' + data.error);
  } catch { showToast('Upload failed. Try again.'); }
}

/* ═══════════════════════════════
   PDF RENDERING
═══════════════════════════════ */
async function loadPDF(path, startPage = 1) {
  $('no-book').classList.add('hidden');
  $('pdf-viewer').classList.remove('hidden');
  $('loading-ring').classList.remove('hidden');
  try {
    S.pdfDoc     = await pdfjsLib.getDocument(path).promise;
    S.totalPages = S.pdfDoc.numPages;
    $('total-pages').textContent = S.totalPages;
    $('page-input').max = S.totalPages;
    S.currentPage = Math.max(1, Math.min(startPage, S.totalPages));
    await renderPage(S.currentPage);
    updatePageInput(S.currentPage);
    saveBookPage();
    renderHistory();
  } catch (err) {
    console.error(err);
    showToast('Could not load the PDF');
  } finally {
    $('loading-ring').classList.add('hidden');
  }
}

async function renderPage(num) {
  if (!S.pdfDoc) return;
  if (S.rendering) { S.pendingPage = num; return; }
  S.rendering = true;
  try {
    const page   = await S.pdfDoc.getPage(num);
    const canvas = $('pdf-canvas');
    const ctx    = canvas.getContext('2d');
    const wrap   = $('canvas-wrap');
    const vp0    = page.getViewport({ scale: 1 });
    const fitW   = (wrap.clientWidth  - 48) / vp0.width;
    const fitH   = (wrap.clientHeight - 48) / vp0.height;
    S.baseScale  = Math.min(fitW, fitH, 1.8);
    const scale  = S.baseScale * S.zoom;
    const vp     = page.getViewport({ scale });
    const dpr    = window.devicePixelRatio || 1;
    canvas.width  = vp.width  * dpr;
    canvas.height = vp.height * dpr;
    canvas.style.width  = vp.width  + 'px';
    canvas.style.height = vp.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (S.zoom === 1.0) wrap.scrollTop = 0;
    $('prev-btn').disabled = num <= 1;
    $('next-btn').disabled = num >= S.totalPages;
    updateZoomDisplay();
  } catch (err) { console.error('Render error', err); }
  S.rendering = false;
  if (S.pendingPage !== null) { const p = S.pendingPage; S.pendingPage = null; renderPage(p); }
}

function updatePageInput(n) { $('page-input').value = n; }

/* ═══════════════════════════════
   PAGE CONTROLS
═══════════════════════════════ */
$('prev-btn').addEventListener('click', () => goToPage(S.currentPage - 1));
$('next-btn').addEventListener('click', () => goToPage(S.currentPage + 1));

$('page-input').addEventListener('change', e => {
  const n = parseInt(e.target.value);
  if (n >= 1 && n <= S.totalPages) goToPage(n);
  else e.target.value = S.currentPage;
});
$('page-input').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (!S.pdfDoc) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goToPage(S.currentPage + 1);
  if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   goToPage(S.currentPage - 1);
  if (e.key === '+' || e.key === '=') adjustZoom(+0.25);
  if (e.key === '-')                  adjustZoom(-0.25);
  if (e.key === '0')                  resetZoom();
});

function goToPage(n) {
  if (!S.pdfDoc || n < 1 || n > S.totalPages) return;
  S.currentPage = n;
  renderPage(n);
  updatePageInput(n);
  saveBookPage();
  S.socket?.emit('page-change', { page: n });
}

function flashPageChange() {
  const f = $('page-flash');
  f.classList.add('active');
  setTimeout(() => f.classList.remove('active'), 600);
}

/* ═══════════════════════════════
   ZOOM
═══════════════════════════════ */
$('zoom-in-btn').addEventListener('click',  () => adjustZoom(+0.25));
$('zoom-out-btn').addEventListener('click', () => adjustZoom(-0.25));

$('canvas-wrap').addEventListener('wheel', e => {
  if (!S.pdfDoc) return;
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); adjustZoom(e.deltaY < 0 ? +0.15 : -0.15); }
}, { passive: false });

let lastPinchDist = null;
$('canvas-wrap').addEventListener('touchmove', e => {
  if (e.touches.length !== 2) return;
  e.preventDefault();
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  const dist = Math.hypot(dx, dy);
  if (lastPinchDist !== null) adjustZoom((dist - lastPinchDist) / 200);
  lastPinchDist = dist;
}, { passive: false });
$('canvas-wrap').addEventListener('touchend', () => { lastPinchDist = null; });

function adjustZoom(delta) {
  S.zoom = Math.min(4.0, Math.max(0.4, S.zoom + delta));
  renderPage(S.currentPage);
}
function resetZoom() { S.zoom = 1.0; renderPage(S.currentPage); }
function updateZoomDisplay() { $('zoom-level').textContent = Math.round(S.zoom * 100) + '%'; }
$('pdf-canvas').addEventListener('dblclick', resetZoom);

/* ═══════════════════════════════
   REACTIONS
═══════════════════════════════ */
document.querySelectorAll('.react-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    spawnReaction(emoji, true);
    S.socket?.emit('reaction', { emoji });
  });
});

function spawnReaction(emoji, isSelf) {
  const stage = $('reaction-stage');
  const el    = document.createElement('div');
  el.className = 'floating-reaction' + (isSelf ? ' self' : ' friend');
  el.textContent = emoji;
  el.style.left = (20 + Math.random() * 60) + '%';
  stage.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ═══════════════════════════════
   FRIEND STATUS
═══════════════════════════════ */
function setFriendOnline(online) {
  $('friend-badge').classList.toggle('online', online);
  $('friend-dot').classList.toggle('online', online);
  $('friend-label').textContent = online ? 'Friend is here' : 'Friend offline';
}

/* ═══════════════════════════════
   BOOK HISTORY (localStorage)
═══════════════════════════════ */
function getHistory() {
  try { return JSON.parse(localStorage.getItem('tr:history') || '[]'); } catch { return []; }
}
function saveHistory(list) { localStorage.setItem('tr:history', JSON.stringify(list)); }

function saveBookPage() {
  if (!S.bookName) return;
  const history = getHistory();
  const existing = history.find(h => h.name === S.bookName);
  if (existing) {
    existing.page = S.currentPage; existing.total = S.totalPages;
    existing.path = S.bookPath || existing.path;
    existing.lastRead = new Date().toISOString();
  } else {
    history.unshift({ name: S.bookName, path: S.bookPath, page: S.currentPage, total: S.totalPages, lastRead: new Date().toISOString() });
  }
  saveHistory(history.slice(0, 50));
}

function getBookPage(bookName) {
  const entry = getHistory().find(h => h.name === bookName);
  return entry ? entry.page : null;
}

$('history-btn').addEventListener('click', () => {
  const panel = $('history-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderHistory();
});
$('history-close').addEventListener('click', () => { $('history-panel').classList.add('hidden'); });

function renderHistory() {
  const list    = $('history-list');
  const history = getHistory();
  if (!history.length) { list.innerHTML = '<p class="history-empty">No books read yet</p>'; return; }
  list.innerHTML = history.map((h, i) => {
    const ago = timeAgo(new Date(h.lastRead));
    const pct = h.total ? Math.round((h.page / h.total) * 100) : 0;
    return `<div class="history-item" data-idx="${i}" role="button" tabindex="0">
      <div class="history-book-icon">📕</div>
      <div class="history-info">
        <div class="history-name">${escapeHtml(h.name)}</div>
        <div class="history-meta">Page ${h.page}${h.total ? ' / ' + h.total : ''} · ${pct}% · ${ago}</div>
        <div class="history-bar"><div class="history-fill" style="width:${pct}%"></div></div>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => openFromHistory(history[parseInt(el.dataset.idx)]));
  });
}

function openFromHistory(entry) {
  if (!entry.path) { showToast('Book path not available — please re-upload'); return; }
  S.bookName = entry.name; S.bookPath = entry.path;
  $('book-title').textContent = entry.name;
  $('history-panel').classList.add('hidden');
  loadPDF(entry.path, entry.page).catch(() => showToast('Book file not found — please re-upload'));
  S.socket?.emit('switch-book', { bookPath: entry.path, bookName: entry.name, currentPage: entry.page });
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ═══════════════════════════════
   TOAST
═══════════════════════════════ */
let toastTimer;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

/* ═══════════════════════════════
   LEAVE ROOM
═══════════════════════════════ */
function leaveRoom() {
  localStorage.removeItem('tr:roomId');
  removeAllPeers();
  if (S.localStream) { S.localStream.getTracks().forEach(t => t.stop()); S.localStream = null; }
  history.pushState({}, '', '/');
  location.reload();
}
$('leave-room-btn')?.addEventListener('click', leaveRoom);

/* ═══════════════════════════════
   INIT — URL-based auto-join
═══════════════════════════════ */
function getRoomFromUrl() {
  const pathMatch = window.location.pathname.match(/\/room\/([A-Z0-9]{3,8})/i);
  if (pathMatch) return pathMatch[1].toUpperCase();
  const params = new URLSearchParams(window.location.search);
  if (params.get('room')) return params.get('room').toUpperCase();
  return null;
}

function init() {
  initSocket();
  const targetRoom = getRoomFromUrl() || localStorage.getItem('tr:roomId');
  if (targetRoom) {
    showToast('Joining room ' + targetRoom + '…');
    S.socket.once('connect', () => joinRoom(targetRoom));
    show('splash');
  } else {
    show('splash');
  }
}

init();
