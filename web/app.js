'use strict';

const STORAGE_KEY = 'sleepwatch.sessions';
const AUTO_STOP_KEY = 'sleepwatch.autoStopHours';
const BRIGHTNESS_KEY = 'sleepwatch.brightness';
const THRESHOLD_DB = -30;
const DEBOUNCE_MS = 5000;
const BRIGHTNESS_DRAG_RANGE_PX = 300; // full-width drag = full brightness range
const BRIGHTNESS_STEP = 0.05; // snap brightness to 5% increments
const BRIGHTNESS_HUD_HIDE_DELAY_MS = 900; // how long the % readout lingers after the last change
const MAX_DIM_OPACITY = 0.925; // never fully black, always keep the clock legible
const WAKE_LOCK_RECHECK_MS = 30 * 1000; // Safari's Wake Lock can silently drop over a long
                                         // night, so periodically verify it and re-acquire

const PIXEL_SHIFT_INTERVAL_MS = 2 * 60 * 1000; // nudge static content periodically to avoid
                                                // OLED burn-in over an 8-hour night
const PIXEL_SHIFT_OFFSETS = [-16, 0, 16];

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
const WAVEFORM_BARS = 120;

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

function formatBuildDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
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
  autoStopTimer: null,
  wakeLockSentinel: null,
  wakeLockTimer: null,
  recorder: null,
  recorderMimeType: null,
  segmentTimer: null,
  segmentStoppedPromise: null,
  audioObjectUrls: [],
  waveformAudioContext: null,
  currentPeaks: null,
  brightnessHudTimer: null,
  detailClips: null,
  detailStart: null,
  detailTotalMs: null,
};

// ---------- DOM ----------

const el = {
  brightnessOverlay: document.getElementById('brightness-overlay'),
  brightnessHud: document.getElementById('brightness-hud'),

  viewIdle: document.getElementById('view-idle'),
  viewMonitoring: document.getElementById('view-monitoring'),
  viewHistory: document.getElementById('view-history'),
  viewDetail: document.getElementById('view-detail'),

  idleContent: document.getElementById('idle-content'),
  monitorContent: document.getElementById('monitor-content'),

  idleClock: document.getElementById('idle-clock'),
  versionInfo: document.getElementById('version-info'),
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
  stopConfirmDiscard: document.getElementById('stop-confirm-discard'),
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
  detailPlayer: document.getElementById('detail-player'),
  detailPlayerStatus: document.getElementById('detail-player-status'),
  detailWaveform: document.getElementById('detail-waveform'),
};

// ---------- view switching ----------

function showView(view) {
  for (const v of [el.viewIdle, el.viewMonitoring, el.viewHistory, el.viewDetail]) {
    v.classList.add('hidden');
  }
  view.classList.remove('hidden');
  applyBrightness();
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
    state.wakeLockSentinel.addEventListener('release', () => {
      // Fires both when we release it ourselves and when the system drops it
      // out from under us — either way, forget the stale sentinel.
      state.wakeLockSentinel = null;
    });
  } catch {
    // ignore — not fatal, screen may just dim over time
  }
}

function releaseWakeLock() {
  state.wakeLockSentinel?.release().catch(() => {});
  state.wakeLockSentinel = null;
}

function startWakeLockWatchdog() {
  state.wakeLockTimer = setInterval(() => {
    if (!state.wakeLockSentinel) acquireWakeLock();
  }, WAKE_LOCK_RECHECK_MS);
}

function stopWakeLockWatchdog() {
  clearInterval(state.wakeLockTimer);
  state.wakeLockTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.currentSession) {
    acquireWakeLock();
  }
});

// ---------- brightness (dimming overlay — cannot control real backlight from a web page) ----------

function applyBrightness() {
  // 기록 목록/상세 화면을 볼 때는 내용을 읽어야 하므로 어둡게 하지 않고,
  // 시계가 보이는 시작 화면과 모니터링 화면에서만 밝기 조절을 적용한다.
  const onDimmableView = !el.viewIdle.classList.contains('hidden') || !el.viewMonitoring.classList.contains('hidden');
  const opacity = onDimmableView ? (1 - state.brightness) * MAX_DIM_OPACITY : 0;
  el.brightnessOverlay.style.opacity = String(opacity);
}

function setBrightness(value) {
  const clamped = Math.min(1, Math.max(0, value));
  state.brightness = Math.round(clamped / BRIGHTNESS_STEP) * BRIGHTNESS_STEP;
  saveBrightness(state.brightness);
  applyBrightness();
  showBrightnessHud();
}

function showBrightnessHud() {
  el.brightnessHud.textContent = `${Math.round(state.brightness * 100)}%`;
  el.brightnessHud.classList.remove('hidden');
  clearTimeout(state.brightnessHudTimer);
  state.brightnessHudTimer = setTimeout(() => {
    el.brightnessHud.classList.add('hidden');
  }, BRIGHTNESS_HUD_HIDE_DELAY_MS);
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

// ---------- pixel shift (burn-in mitigation for OLED screens) ----------

function applyRandomPixelShift() {
  const dx = PIXEL_SHIFT_OFFSETS[Math.floor(Math.random() * PIXEL_SHIFT_OFFSETS.length)];
  const dy = PIXEL_SHIFT_OFFSETS[Math.floor(Math.random() * PIXEL_SHIFT_OFFSETS.length)];
  const transform = `translate(${dx}px, ${dy}px)`;
  el.idleContent.style.transform = transform;
  el.monitorContent.style.transform = transform;
}

setInterval(applyRandomPixelShift, PIXEL_SHIFT_INTERVAL_MS);

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

// ---------- recording (1-minute chunks, analyzed after the fact for sound events) ----------

function findSoundEvents(audioBuffer, segmentStart) {
  const data = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.05)); // ~50ms analysis window
  const debounceSamples = Math.round((DEBOUNCE_MS / 1000) * sampleRate);

  const events = [];
  let lastEventSample = -Infinity;

  for (let i = 0; i < data.length; i += windowSamples) {
    const end = Math.min(data.length, i + windowSamples);
    let sumSquares = 0;
    for (let j = i; j < end; j++) sumSquares += data[j] * data[j];
    const rms = Math.sqrt(sumSquares / (end - i));
    const decibels = 20 * Math.log10(Math.max(rms, 1e-7));

    if (decibels <= THRESHOLD_DB) continue;
    if (i - lastEventSample < debounceSamples) continue;

    lastEventSample = i;
    const offsetMs = (i / sampleRate) * 1000;
    events.push({
      timestamp: new Date(segmentStart.getTime() + offsetMs).toISOString(),
      level: decibels,
    });
  }

  return events;
}

async function analyzeSegment(sessionId, segmentStart, segmentEnd, blob) {
  let audioBuffer;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    audioBuffer = await getWaveformAudioContext().decodeAudioData(arrayBuffer);
  } catch {
    return; // couldn't decode — nothing to keep
  }

  const detectedEvents = findSoundEvents(audioBuffer, segmentStart);
  const hasSound = detectedEvents.length > 0;

  const session = state.currentSession;
  const isCurrentSession = session && session.id === sessionId;

  // 직전 1분에 이미 소리가 있었다면 지금도 같은 소리가 이어지는 것으로 보고
  // 새 이벤트는 만들지 않는다 (녹음 자체는 계속 저장해서 이어들을 수 있게 한다).
  const suppressNewEvents = isCurrentSession && session.previousSegmentHadSound;
  if (isCurrentSession) session.previousSegmentHadSound = hasSound;

  if (!hasSound) return; // silent minute — discard the clip entirely

  if (!suppressNewEvents && isCurrentSession) {
    session.events.push(...detectedEvents);
    el.eventCount.textContent = `감지된 이벤트: ${session.events.length}건`;
  }

  await saveAudioClip(sessionId, segmentStart, segmentEnd, blob);
}

function pickRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return RECORDING_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

function startSegment(stream) {
  if (!state.recorderMimeType) return;

  const sessionId = state.currentSession.id;
  const segmentStart = new Date();
  const chunks = [];

  // Resolves once this segment's onstop has finished analyzing/saving, so
  // stopRecording() can await the *last* segment instead of losing it.
  let resolveStopped;
  state.segmentStoppedPromise = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: state.recorderMimeType,
      audioBitsPerSecond: RECORDING_BITRATE,
    });
  } catch {
    state.recorder = null;
    resolveStopped();
    return;
  }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    const segmentEnd = new Date();
    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: state.recorderMimeType });
      await analyzeSegment(sessionId, segmentStart, segmentEnd, blob);
    }
    resolveStopped();
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

async function stopRecording() {
  clearInterval(state.segmentTimer);
  state.segmentTimer = null;

  const stopped = state.segmentStoppedPromise;
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
  state.recorder = null;

  if (stopped) await stopped;
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
  state.currentSession = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    startTime: new Date(),
    events: [],
    previousSegmentHadSound: false, // in-memory bookkeeping only, not persisted with the session
  };

  startRecording(stream);
  acquireWakeLock();
  startWakeLockWatchdog();

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

// Stops the recorder/wake lock/timers shared by both a normal stop and a
// discard. Waits for the in-flight final segment's decode/analysis so its
// events (and clip, if any) are settled before the caller decides what to
// do with them.
async function finalizeRecording() {
  await stopRecording();
  state.mediaStream?.getTracks().forEach((t) => t.stop());
  state.mediaStream = null;

  clearTimeout(state.autoStopTimer);
  state.autoStopTimer = null;
  stopWakeLockWatchdog();
  releaseWakeLock();
}

async function stopSession() {
  if (!state.currentSession) return;

  const session = state.currentSession;
  const endTime = new Date();

  await finalizeRecording();

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

async function discardSession() {
  if (!state.currentSession) return;

  const session = state.currentSession;
  await finalizeRecording();
  deleteAudioClips(session.id); // clean up any clips already saved mid-session

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

// ---------- waveform (rough amplitude preview of the currently-loaded clip) ----------

function getWaveformAudioContext() {
  if (!state.waveformAudioContext) {
    state.waveformAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return state.waveformAudioContext;
}

function computePeaks(audioBuffer, bars) {
  const data = audioBuffer.getChannelData(0);
  const samplesPerBar = Math.max(1, Math.floor(data.length / bars));
  const peaks = [];
  for (let i = 0; i < bars; i++) {
    const start = i * samplesPerBar;
    const end = Math.min(data.length, start + samplesPerBar);
    let max = 0;
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}

async function decodePeaks(blob) {
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await getWaveformAudioContext().decodeAudioData(arrayBuffer);
    return computePeaks(audioBuffer, WAVEFORM_BARS);
  } catch {
    return null; // decoding unsupported for this format/blob — waveform is a bonus, not core
  }
}

function drawWaveform(peaks, progress) {
  const canvas = el.detailWaveform;
  const ctx2d = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 60;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, width, height);

  if (!peaks) {
    ctx2d.strokeStyle = '#333';
    ctx2d.beginPath();
    ctx2d.moveTo(0, height / 2);
    ctx2d.lineTo(width, height / 2);
    ctx2d.stroke();
    return;
  }

  const peakMax = Math.max(...peaks, 0.01); // normalize so quiet clips still show visible bars
  const barWidth = width / peaks.length;
  ctx2d.fillStyle = '#0a84ff';
  peaks.forEach((peak, i) => {
    const barHeight = Math.max(2, (peak / peakMax) * height);
    const x = i * barWidth;
    ctx2d.fillRect(x, (height - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
  });

  if (progress != null) {
    const x = Math.min(width, Math.max(0, progress * width));
    ctx2d.strokeStyle = '#fff';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(x, 0);
    ctx2d.lineTo(x, height);
    ctx2d.stroke();
  }
}

el.detailPlayer.addEventListener('timeupdate', () => {
  const duration = el.detailPlayer.duration;
  if (!state.currentPeaks || !isFinite(duration) || duration <= 0) return;
  drawWaveform(state.currentPeaks, el.detailPlayer.currentTime / duration);
});

el.detailWaveform.addEventListener('click', (e) => {
  const duration = el.detailPlayer.duration;
  if (!isFinite(duration) || duration <= 0) return;
  const rect = el.detailWaveform.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  el.detailPlayer.currentTime = frac * duration;
  el.detailPlayer.play().catch(() => {});
});

// Tapping anywhere on the timeline baseline (not just a marker) plays whatever
// clip covers that moment — this is the only way to reach a "continuation"
// minute that has a saved clip but no marker of its own (see selectEvent).
el.timelineTrack.addEventListener('click', (e) => {
  if (!state.detailClips || !state.detailStart || !state.detailTotalMs) return;
  const rect = el.timelineTrack.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const time = new Date(state.detailStart.getTime() + frac * state.detailTotalMs);

  for (const activeEl of document.querySelectorAll('.timeline-marker.active, .event-list li.active')) {
    activeEl.classList.remove('active');
  }

  playClipAt(state.detailClips, time);
});

function findClipAt(clips, time) {
  const t = time.getTime();
  return clips.find((c) => t >= new Date(c.startTime).getTime() && t < new Date(c.endTime).getTime());
}

function playClipAt(clips, eventTime) {
  const clip = findClipAt(clips, eventTime);
  if (!clip) {
    el.detailPlayerStatus.textContent = `${formatClock(eventTime)} — 저장된 녹음이 없습니다`;
    el.detailPlayer.classList.add('hidden');
    el.detailPlayer.removeAttribute('src');
    el.detailWaveform.classList.add('hidden');
    state.currentPeaks = null;
    return;
  }

  const url = URL.createObjectURL(clip.blob);
  state.audioObjectUrls.push(url);

  const offsetSec = Math.max(0, (eventTime.getTime() - new Date(clip.startTime).getTime()) / 1000);
  el.detailPlayer.onloadedmetadata = () => {
    el.detailPlayer.currentTime = offsetSec;
    el.detailPlayer.play().catch(() => {});
  };
  el.detailPlayer.src = url;
  el.detailPlayer.classList.remove('hidden');
  el.detailPlayerStatus.textContent = `${formatClock(eventTime)} 부근 재생 중`;

  state.currentPeaks = null;
  el.detailWaveform.classList.remove('hidden');
  drawWaveform(null, 0); // flat placeholder while decoding
  decodePeaks(clip.blob).then((peaks) => {
    state.currentPeaks = peaks;
    const duration = el.detailPlayer.duration;
    const progress = isFinite(duration) && duration > 0 ? el.detailPlayer.currentTime / duration : 0;
    drawWaveform(peaks, progress);
  });
}

// 타임라인의 점과 이벤트 시각 칩은 같은 이벤트를 가리키므로, 하나를 선택하면
// data-index로 서로를 찾아 둘 다 강조 표시해 시각적으로 짝지어 준다.
function selectEvent(index, eventTime, clips) {
  for (const activeEl of document.querySelectorAll('.timeline-marker.active, .event-list li.active')) {
    activeEl.classList.remove('active');
  }
  el.timelineTrack.querySelector(`.timeline-marker[data-index="${index}"]`)?.classList.add('active');
  el.detailEventList.querySelector(`li[data-index="${index}"]`)?.classList.add('active');

  playClipAt(clips, eventTime);
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

  for (const url of state.audioObjectUrls) URL.revokeObjectURL(url);
  state.audioObjectUrls = [];
  el.detailPlayer.classList.add('hidden');
  el.detailPlayer.removeAttribute('src');
  el.detailPlayerStatus.textContent = '타임라인을 탭하면 그 지점부터 재생됩니다';
  el.detailWaveform.classList.add('hidden');
  state.currentPeaks = null;

  showView(el.viewDetail);

  const clips = await getAudioClips(session.id);
  state.detailClips = clips;
  state.detailStart = start;
  state.detailTotalMs = totalMs;

  // 소리가 감지되지 않은 구간은 단순한 기준선으로, 감지된 이벤트는 그 위의 점으로 표시.
  // 점이나 시각 칩을 탭하면 그 순간이 포함된 1분짜리 녹음 클립을 그 지점부터 재생하고,
  // 점이 없는 구간(연속된 소리로 새 이벤트가 억제된 구간 포함)도 선을 직접 탭하면 재생된다.
  el.timelineTrack.innerHTML = '<div class="timeline-baseline"></div>';
  const sortedEvents = [...session.events].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  el.detailEventList.innerHTML = '';
  if (sortedEvents.length === 0) {
    const li = document.createElement('li');
    li.className = 'event-list-empty';
    li.textContent = '감지된 소리 없음';
    el.detailEventList.appendChild(li);
  }

  sortedEvents.forEach((event, index) => {
    const eventTime = new Date(event.timestamp);
    const pct = Math.min(100, Math.max(0, ((eventTime.getTime() - start.getTime()) / totalMs) * 100));

    const marker = document.createElement('div');
    marker.className = 'timeline-marker';
    marker.dataset.index = String(index);
    marker.style.left = `${pct}%`;
    marker.title = formatClock(eventTime);
    marker.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the baseline's generic tap-to-play handler
      selectEvent(index, eventTime, clips);
    });
    el.timelineTrack.appendChild(marker);

    const chip = document.createElement('li');
    chip.dataset.index = String(index);
    chip.textContent = formatClock(eventTime);
    chip.addEventListener('click', () => selectEvent(index, eventTime, clips));
    el.detailEventList.appendChild(chip);
  });
}

// ---------- wiring ----------

el.startBtn.addEventListener('click', startSession);

el.stopBtn.addEventListener('click', () => {
  el.stopConfirm.classList.remove('hidden');
});
el.stopConfirmCancel.addEventListener('click', () => {
  el.stopConfirm.classList.add('hidden');
});
el.stopConfirmDiscard.addEventListener('click', () => {
  el.stopConfirm.classList.add('hidden');
  discardSession();
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
showView(el.viewIdle);
tick();
setInterval(tick, 1000);

fetch('version.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    if (!data) return;
    el.versionInfo.textContent = `v${data.version} · ${formatBuildDate(data.builtAt)} 업데이트`;
  })
  .catch(() => {});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
