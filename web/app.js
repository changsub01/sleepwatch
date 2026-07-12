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
  currentSegment: null,
  audioObjectUrls: [],
  waveformAudioContext: null,
  currentPeaks: null,
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

    if (state.currentSegment) state.currentSegment.hasSound = true;

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

  // Captured by this closure (not read back off shared state later) so that
  // the *next* segment's reset can't clobber *this* segment's flag before
  // this recorder's async onstop gets a chance to read it.
  const segmentInfo = { hasSound: false };
  state.currentSegment = segmentInfo;

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
    if (segmentInfo.hasSound && chunks.length > 0) {
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
  state.currentSegment = null;
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
  el.detailPlayerStatus.textContent = '타임라인의 점이나 시각을 탭하면 그 지점부터 재생됩니다';
  el.detailWaveform.classList.add('hidden');
  state.currentPeaks = null;

  showView(el.viewDetail);

  const clips = await getAudioClips(session.id);

  // 소리가 감지되지 않은 구간은 단순한 기준선으로, 감지된 이벤트는 그 위의 점으로 표시.
  // 점이나 시각 칩을 탭하면 그 순간이 포함된 1분짜리 녹음 클립을 그 지점부터 재생한다.
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
    marker.addEventListener('click', () => selectEvent(index, eventTime, clips));
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
