'use strict';

const STORAGE_KEY = 'sleepwatch.sessions';
const AUTO_STOP_KEY = 'sleepwatch.autoStopHours';
const THRESHOLD_DB = -30;
const DEBOUNCE_MS = 5000;
const BUCKET_MS = 30 * 60 * 1000;

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

// ---------- state ----------

const state = {
  currentSession: null, // { id, startTime: Date, events: [{timestamp: Date, level: number}] }
  autoStopHours: loadAutoStopHours(),
  mediaStream: null,
  audioContext: null,
  analyser: null,
  detectionTimer: null,
  autoStopTimer: null,
  wakeLockSentinel: null,
  lastEventAt: 0,
};

// ---------- DOM ----------

const el = {
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
  detailTimeline: document.getElementById('detail-timeline'),
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

function renderHistory() {
  const sessions = loadSessions().sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  el.historyList.innerHTML = '';
  el.historyEmpty.classList.toggle('hidden', sessions.length > 0);

  for (const session of sessions) {
    const li = document.createElement('li');
    const start = new Date(session.startTime);
    const end = new Date(session.endTime);
    const durationMs = end - start;

    li.innerHTML = `
      <div class="history-date">${formatDayTime(start)}</div>
      <div class="history-meta">
        <span>~ ${formatDayTime(end)}</span>
        <span>${formatDuration(durationMs)}</span>
        <span>· 이벤트 ${session.events.length}건</span>
      </div>
    `;
    li.addEventListener('click', () => showDetail(session));
    el.historyList.appendChild(li);
  }
}

function showDetail(session) {
  const start = new Date(session.startTime);
  const end = new Date(session.endTime);

  el.detailTitle.textContent = formatDayTime(start);
  el.detailStart.textContent = formatDayTime(start);
  el.detailEnd.textContent = formatDayTime(end);
  el.detailDuration.textContent = formatDuration(end - start);
  el.detailEvents.textContent = `${session.events.length}건`;

  el.detailTimeline.innerHTML = '';
  const sortedEvents = [...session.events].sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  let cursor = start.getTime();
  const endMs = end.getTime();
  while (cursor < endMs) {
    const bucketEnd = Math.min(cursor + BUCKET_MS, endMs);
    const eventsInBucket = sortedEvents.filter((e) => {
      const t = new Date(e.timestamp).getTime();
      return t >= cursor && t < bucketEnd;
    });

    const li = document.createElement('li');
    const rangeLabel = `${formatClock(new Date(cursor)).slice(0, 5)} ~ ${formatClock(new Date(bucketEnd)).slice(0, 5)}`;

    if (eventsInBucket.length === 0) {
      li.innerHTML = `<div class="timeline-range">${rangeLabel}</div><div class="timeline-empty">기록 없음</div>`;
    } else {
      const eventLines = eventsInBucket
        .map((e) => `<div class="timeline-event">${formatClock(new Date(e.timestamp))}</div>`)
        .join('');
      li.innerHTML = `<div class="timeline-range">${rangeLabel}</div>${eventLines}`;
    }
    el.detailTimeline.appendChild(li);
    cursor = bucketEnd;
  }

  showView(el.viewDetail);
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
showView(el.viewIdle);
tick();
setInterval(tick, 1000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}
