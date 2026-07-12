'use strict';

const STORAGE_KEY = 'sleepwatch.sessions';
const AUTO_STOP_KEY = 'sleepwatch.autoStopHours';
const BRIGHTNESS_KEY = 'sleepwatch.brightness';
const THRESHOLD_DB = -30;
const DEBOUNCE_MS = 5000;
const BRIGHTNESS_DRAG_RANGE_PX = 300; // full-width drag = full brightness range
const MAX_DIM_OPACITY = 0.85; // never fully black, always keep the clock legible

const RECORDING_SEGMENT_MS = 60 * 1000; // stop/restart the recorder every minute so each
                                         // chunk is an independently playable audio file
const RECORDING_BITRATE = 32000; // voice-quality bitrate keeps overnight storage manageable
const RECORDING_MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg',
];

const AUDIO_DB_NAME = 'sleepwatch-audio';
const AUDIO_STORE = 'clips';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// ---------- formatting ----------

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatClock(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatClockShort(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatDayTime(date) {
  return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAYS[date.getDay()]}) ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${pad2(h)}:${pad2(m)}`;
}

// ---------- storage ----------

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
}

function loadAutoStopHours() {
  const raw = localStorage.getItem(AUTO_STOP_KEY);
  const n = raw === null ? 8 : Number(raw);
  return Number.isFinite(n) ? n : 8;
}

function saveAutoStopHours(hours) {
  localStorage.setItem(AUTO_STOP_KEY, String(hours));
}

function loadBrightness() {
  const raw = localStorage.getItem(BRIGHTNESS_KEY);
  const n = raw === null ? 1 : Number(raw);
  return Number.isFinite(n) ? n : 1;
}

function saveBrightness(value) {
  localStorage.setItem(BRIGHTNESS_KEY, String(value));
}

// ---------- audio clip storage (IndexedDB — localStorage can't hold binary blobs) ----------

function openAudioDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(AUDIO_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        const store = db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function saveAudioClip(sessionId, start, end, blob) {
  try {
    const db = await openAudioDB();
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    tx.objectStore(AUDIO_STORE).put({
      id: `${sessionId}-${start.getTime()}`,
      sessionId,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      blob,
    });
    await txDone(tx);
  } catch {
    // storage full or unsupported — audio is a bonus on top of the event markers, not core
  }
}

async function getAudioClips(sessionId) {
  try {
    const db = await openAudioDB();
    const tx = db.transaction(AUDIO_STORE, 'readonly');
    const req = tx.objectStore(AUDIO_STORE).index('sessionId').getAll(sessionId);
    const clips = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return clips.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  } catch {
    return [];
  }
}

async function deleteAudioClips(sessionId) {
  try {
    const db = await openAudioDB();
    const tx = db.transaction(AUDIO_STORE, 'readwrite');
    const store = tx.objectStore(AUDIO_STORE);
    const req = store.index('sessionId').getAllKeys(sessionId);
    req.onsuccess = () => {
      for (const key of req.result) store.delete(key);
    };
    await txDone(tx);
  } catch {
    // ignore
  }
}

// ---------- state ----------

const state = {
  currentSession: null, // { id, startTime: Date, events: [{timestamp: Date, level: number}] }
  autoStopHours: loadAutoStopHours(),
  brightness: loadBrightness(),
  mediaStream: null,
  audioContext: null,
  analyser: null,
  detectionTimer: null,
  autoStopTimer: null,
  wakeLockSentinel: null,
  lastEventAt: 0,
  recorder: null,
  recorderMimeType: null,
  segmentTimer: null,
  segmentHasSound: false,
  audioObjectUrls: [],
};

// ---------- DOM ----------

const el = {
  brightnessOverlay: document.getElementById('brightness-overlay'),

  viewIdle: document.getElementById('view-idle'),
  viewMonitoring: document.getElementById('view-monitoring'),
  viewHistory: document.getElementById('view-history'),
  viewDetail: document.getElementById('view-detail'),

  idleClock: document.getElementById('idle-clock'),
  autoStopLabel: document.getElementById('auto-stop-label'),
  autoStopMinus: document.getElementById('auto-stop-minus'),
  autoStopPlus: document.getElementById('auto-stop-plus'),
  startBtn: document.getElementById('start-btn'),
  showHistoryBtn: document.getElementById('show-history-btn'),
  micError: document.getElementById('mic-error'),

  clock: document.getElementById('clock'),
  startTime: document.getElementById('start-time'),
  duration: document.getElementById('duration'),
  eventCount: document.getElementById('event-count'),
  stopBtn: document.getElementById('stop-btn'),

  stopConfirm: document.getElementById('stop-confirm'),
  stopConfirmCancel: document.getElementById('stop-confirm-cancel'),
  stopConfirmOk: document.getElementById('stop-confirm-ok'),

  historyCloseBtn: document.getElementById('history-close-btn'),
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),

  detailBackBtn: document.getElementById('detail-back-btn'),
  detailTitle: document.getElementById('detail-title'),
  detailStart: document.getElementById('detail-start'),
  detailEnd: document.getElementById('detail-end'),
  detailDuration: document.getElementById('detail-duration'),
  detailEvents: document.getElementById('detail-events'),
  timelineStartLabel: document.getElementById('timeline-start-label'),
  timelineEndLabel: document.getElementById('timeline-end-label'),
  timelineTrack: document.getElementById('timeline-track'),
  detailEventList: document.getElementById('detail-event-list'),
  detailAudioList: document.getElementById('detail-audio-list'),
};

// ---------- view switching ----------

function showView(view) {
  for (const v of [el.viewIdle, el.viewMonitoring, el.viewHistory, el.viewDetail]) {
    v.classList.add('hidden');
  }
  view.classList.remove('hidden');
}

function renderAutoStopLabel() {
  el.autoStopLabel.textContent =
    state.autoStopHours === 0 ? '자동 종료 없음 (수동 종료만)' : `${state.autoStopHours}시간 후 자동 종료`;
}

el.autoStopMinus.addEventListener('click', () => {
  state.autoStopHours = Math.max(0, state.autoStopHours - 1);
  saveAutoStopHours(state.autoStopHours);
  renderAutoStopLabel();
});

el.autoStopPlus.addEventListener('click', () => {
  state.autoStopHours = Math.min(12, state.autoStopHours + 1);
  saveAutoStopHours(state.autoStopHours);
  renderAutoStopLabel();
});

// ---------- wake lock ----------

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLockSentinel = await navigator.wakeLock.request('screen');
  } catch {
    // ignore — not fatal, screen may just dim over time
  }
}

function releaseWakeLock() {
  state.wakeLockSentinel?.release().catch(() => {});
  state.wakeLockSentinel = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.currentSession) {
    acquireWakeLock();
  }
});

// ---------- brightness (dimming overlay — cannot control real backlight from a web page) ----------

function applyBrightness() {
  el.brightnessOverlay.style.opacity = String((1 - state.brightness) * MAX_DIM_OPACITY);
}

function setBrightness(value) {
  state.brightness = Math.min(1, Math.max(0, value));
  saveBrightness(state.brightness);
  applyBrightness();
}

function attachBrightnessDrag(target) {
  let drag = null;

  target.addEventListener('pointerdown', (e) => {
    drag = { startX: e.clientX, startBrightness: state.brightness };
  });

  target.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const deltaX = e.clientX - drag.startX;
    setBrightness(drag.startBrightness + deltaX / BRIGHTNESS_DRAG_RANGE_PX);
  });

  const endDrag = () => {
    drag = null;
  };
  target.addEventListener('pointerup', endDrag);
  target.addEventListener('pointercancel', endDrag);
}

attachBrightnessDrag(el.clock);
attachBrightnessDrag(el.idleClock);

// ---------- fullscreen ----------

function toggleFullscreen() {
  const doc = document;
  const isFullscreen = doc.fullscreenElement || doc.webkitFullscreenElement;
  try {
    if (!isFullscreen) {
      const root = doc.documentElement;
      (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root);
    } else {
      (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
    }
  } catch {
    // Fullscreen API unsupported — ignore
  }
}

el.clock.addEventListener('dblclick', toggleFullscreen);
el.idleClock.addEventListener('dblclick', toggleFullscreen);

// ---------- sound detection ----------

function startDetection(stream) {
  state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 2048;
  source.connect(state.analyser);

  const buffer = new Float32Array(state.analyser.fftSize);

  state.detectionTimer = setInterval(() => {
    state.analyser.getFloatTimeDomainData(buffer);

    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      sumSquares += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    const decibels = 20 * Math.log10(Math.max(rms, 1e-7));

    if (decibels <= THRESHOLD_DB) return;

    state.segmentHasSound = true;

    const now = Date.now();
    if (now - state.lastEventAt < DEBOUNCE_MS) return;
    state.lastEventAt = now;

    state.currentSession.events.push({ timestamp: new Date(now).toISOString(), level: decibels });
    el.eventCount.textContent = `감지된 이벤트: ${state.currentSession.events.length}건`;
  }, 200);
}

function stopDetection() {
  if (state.detectionTimer) {
    clearInterval(state.detectionTimer);
    state.detectionTimer = null;
  }
  state.audioContext?.close().catch(() => {});
  state.audioContext = null;
  state.analyser = null;
}

// ---------- recording (1-minute chunks; segments with no detected sound are discarded) ----------

function pickRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return RECORDING_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

function startSegment(stream) {
  if (!state.recorderMimeType) return;

  const sessionId = state.currentSession.id;
  const segmentStart = new Date();
  const chunks = [];
  state.segmentHasSound = false;

  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: state.recorderMimeType,
      audioBitsPerSecond: RECORDING_BITRATE,
    });
  } catch {
    state.recorder = null;
    return;
  }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const segmentEnd = new Date();
    if (state.segmentHasSound && chunks.length > 0) {
      const blob = new Blob(chunks, { type: state.recorderMimeType });
      saveAudioClip(sessionId, segmentStart, segmentEnd, blob);
    }
  };

  recorder.start();
  state.recorder = recorder;
}

function rolloverSegment(stream) {
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
  startSegment(stream);
}

function startRecording(stream) {
  state.recorderMimeType = pickRecordingMimeType();
  if (!state.recorderMimeType) return; // recording unsupported on this browser — event markers still work

  startSegment(stream);
  state.segmentTimer = setInterval(() => rolloverSegment(stream), RECORDING_SEGMENT_MS);
}

function stopRecording() {
  clearInterval(state.segmentTimer);
  state.segmentTimer = null;
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
  state.recorder = null;
}

// ---------- session lifecycle ----------

async function startSession() {
  el.micError.classList.add('hidden');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch {
    el.micError.classList.remove('hidden');
    return;
  }

  state.mediaStream = stream;
  state.lastEventAt = 0;
  state.currentSession = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    startTime: new Date(),
    events: [],
  };

  startDetection(stream);
  startRecording(stream);
  acquireWakeLock();

  el.startTime.textContent = formatClockShort(state.currentSession.startTime);
  el.eventCount.textContent = '감지된 이벤트: 0건';
  tick();

  if (state.autoStopHours > 0) {
    state.autoStopTimer = setTimeout(() => stopSession(), state.autoStopHours * 3600 * 1000);
  }

  showView(el.viewMonitoring);
}

function tick() {
  const now = new Date();
  if (state.currentSession) {
    el.clock.textContent = formatClock(now);
    el.duration.textContent = formatDuration(now - state.currentSession.startTime);
  } else {
    el.idleClock.textContent = formatClock(now);
  }
}

function stopSession() {
  if (!state.currentSession) return;

  stopDetection();
  stopRecording();
  state.mediaStream?.getTracks().forEach((t) => t.stop());
  state.mediaStream = null;

  clearTimeout(state.autoStopTimer);
  state.autoStopTimer = null;
  releaseWakeLock();

  const session = state.currentSession;
  const endTime = new Date();

  const sessions = loadSessions();
  sessions.push({
    id: session.id,
    startTime: session.startTime.toISOString(),
    endTime: endTime.toISOString(),
    events: session.events,
  });
  saveSessions(sessions);

  state.currentSession = null;
  showView(el.viewIdle);
  tick();
}

// ---------- history / detail ----------

function deleteSession(id) {
  if (!confirm('이 기록을 삭제할까요?')) return;
  saveSessions(loadSessions().filter((s) => s.id !== id));
  deleteAudioClips(id);
  renderHistory();
}

function renderHistory() {
  const sessions = loadSessions().sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  el.historyList.innerHTML = '';
  el.historyEmpty.classList.toggle('hidden', sessions.length > 0);

  for (const session of sessions) {
    const li = document.createElement('li');
    li.className = 'history-item';
    const start = new Date(session.startTime);
    const end = new Date(session.endTime);
    const durationMs = end - start;

    const content = document.createElement('div');
    content.className = 'history-content';
    content.innerHTML = `
      <div class="history-date">${formatDayTime(start)}</div>
      <div class="history-meta">
        <span>~ ${formatDayTime(end)}</span>
        <span>${formatDuration(durationMs)}</span>
        <span>· 이벤트 ${session.events.length}건</span>
      </div>
    `;
    content.addEventListener('click', () => showDetail(session));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'history-delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.setAttribute('aria-label', '기록 삭제');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(session.id);
    });

    li.append(content, deleteBtn);
    el.historyList.appendChild(li);
  }
}

async function showDetail(session) {
  const start = new Date(session.startTime);
  const end = new Date(session.endTime);
  const totalMs = Math.max(1, end - start);

  el.detailTitle.textContent = formatDayTime(start);
  el.detailStart.textContent = formatDayTime(start);
  el.detailEnd.textContent = formatDayTime(end);
  el.detailDuration.textContent = formatDuration(end - start);
  el.detailEvents.textContent = `${session.events.length}건`;

  el.timelineStartLabel.textContent = formatClockShort(start);
  el.timelineEndLabel.textContent = formatClockShort(end);

  // 소리가 감지되지 않은 구간은 단순한 기준선으로, 감지된 이벤트는 그 위의 점으로 표시
  el.timelineTrack.innerHTML = '<div class="timeline-baseline"></div>';
  const sortedEvents = [...session.events].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  for (const event of sortedEvents) {
    const t = new Date(event.timestamp).getTime();
    const pct = Math.min(100, Math.max(0, ((t - start.getTime()) / totalMs) * 100));
    const marker = document.createElement('div');
    marker.className = 'timeline-marker';
    marker.style.left = `${pct}%`;
    marker.title = formatClock(new Date(event.timestamp));
    el.timelineTrack.appendChild(marker);
  }

  el.detailEventList.innerHTML = '';
  if (sortedEvents.length === 0) {
    const li = document.createElement('li');
    li.className = 'event-list-empty';
    li.textContent = '감지된 소리 없음';
    el.detailEventList.appendChild(li);
  } else {
    for (const event of sortedEvents) {
      const li = document.createElement('li');
      li.textContent = formatClock(new Date(event.timestamp));
      el.detailEventList.appendChild(li);
    }
  }

  showView(el.viewDetail);

  for (const url of state.audioObjectUrls) URL.revokeObjectURL(url);
  state.audioObjectUrls = [];

  el.detailAudioList.innerHTML = '';
  const clips = await getAudioClips(session.id);
  if (clips.length === 0) {
    const li = document.createElement('li');
    li.className = 'event-list-empty';
    li.textContent = '저장된 녹음 없음';
    el.detailAudioList.appendChild(li);
    return;
  }
  for (const clip of clips) {
    const url = URL.createObjectURL(clip.blob);
    state.audioObjectUrls.push(url);

    const li = document.createElement('li');
    li.className = 'audio-item';

    const label = document.createElement('span');
    label.className = 'audio-time';
    label.textContent = formatClockShort(new Date(clip.startTime));

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    audio.preload = 'none';

    li.append(label, audio);
    el.detailAudioList.appendChild(li);
  }
}

// ---------- wiring ----------

el.startBtn.addEventListener('click', startSession);

el.stopBtn.addEventListener('click', () => {
  el.stopConfirm.classList.remove('hidden');
});
el.stopConfirmCancel.addEventListener('click', () => {
  el.stopConfirm.classList.add('hidden');
});
el.stopConfirmOk.addEventListener('click', () => {
  el.stopConfirm.classList.add('hidden');
  stopSession();
});

el.showHistoryBtn.addEventListener('click', () => {
  renderHistory();
  showView(el.viewHistory);
});
el.historyCloseBtn.addEventListener('click', () => showView(el.viewIdle));
el.detailBackBtn.addEventListener('click', () => {
  renderHistory();
  showView(el.viewHistory);
});

// ---------- init ----------

renderAutoStopLabel();
applyBrightness();
showView(el.viewIdle);
tick();
setInterval(tick, 1000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
