import { SisFallAgent } from './core/agent.js';
import { RiskSmoother } from './core/risk.js';
import { DEFAULT_CONFIG } from './core/config.js';
import { poseObservation } from './sources/pose.js';
import { runScenario, interleave, SCENARIOS } from './sources/sim.js';
import { DevicemotionSource, requestMotionPermission } from './sources/devicemotion.js';
import { BleImuSource } from './sources/web-bluetooth.js';

const $ = (id) => document.getElementById(id);
const ui = {
  video: $('video'), canvas: $('canvas'), empty: $('emptyState'), live: $('liveBadge'),
  score: $('score'), gauge: $('gauge'), label: $('riskLabel'), signals: $('signals'),
  alert: $('alertBox'), advice: $('alertAdvice'), nudge: $('nudgeBox'), nudgeText: $('nudgeText'),
  toast: $('toast'), camera: $('cameraBtn'), demo: $('demoBtn'), scenario: $('scenario'),
  obstacle: $('obstacle'), sound: $('soundBtn'), stateChip: $('stateChip'),
  motion: $('motionBtn'), ble: $('bleBtn'),
  careLabel: $('careLabel'), careAdvice: $('careAdvice'), chips: $('checkinChips'),
};

let agent = null;
let smoother = new RiskSmoother();
let mode = 'idle'; // 'idle' | 'camera' | 'sim'
let running = false;
let demoTimer = null;
let poseLandmarker = null;
let lastVideoTime = -1;
let previousPose = null;
let previousAt = 0;
let sessionStart = 0;
let soundOn = true;
let lastAlarm = 0;
let simQueue = null;
let simIndex = 0;
let displayedStage = null;
let activeSource = null;
let lastRenderAt = 0;

// Latency/battery instrumentation for device modes: per-sample ingest cost
// (p95 budget in config.device) and the effective observation rate.
const perf = {
  ingests: [],
  sampleT: [],
  budgetWarned: false,
  markIngest(ms) {
    this.ingests.push(ms);
    if (this.ingests.length > 240) this.ingests.shift();
  },
  markSample(t) {
    this.sampleT.push(t);
    if (this.sampleT.length > 240) this.sampleT.shift();
  },
  stats() {
    const n = this.ingests.length;
    if (n === 0) return { hz: 0, avg: 0, p95: 0 };
    const sorted = [...this.ingests].sort((a, b) => a - b);
    const avg = this.ingests.reduce((sum, value) => sum + value, 0) / n;
    const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    const ts = this.sampleT;
    const hz = ts.length > 8 ? (ts.length - 1) / Math.max(1e-6, ts[ts.length - 1] - ts[0]) : 0;
    return { hz, avg, p95 };
  },
};

const SIM_EVENTS_PER_TICK = 4; // ~4x real time
const connections = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
const FEATURE_NAMES = { torsoLean: 'lean', lateralOffset: 'balance shift', hipDropSpeed: 'drop speed', kneeAsymmetry: 'knee loading' };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function startSession() {
  agent = new SisFallAgent();
  smoother = new RiskSmoother();
  displayedStage = null;
  previousPose = null;
  previousAt = 0;
  lastVideoTime = -1;
}

function showToast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => ui.toast.classList.remove('show'), 2800);
}

function alarm() {
  if (!soundOn || Date.now() - lastAlarm < 6000) return;
  lastAlarm = Date.now();
  const ctx = new AudioContext();
  [0, 0.18].forEach((delay, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = i ? 660 : 520;
    g.gain.setValueAtTime(0.08, ctx.currentTime + delay);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.13);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + delay);
    o.stop(ctx.currentTime + delay + 0.14);
  });
}

function runActions(actions) {
  for (const action of actions) {
    if (action.kind === 'audio') alarm();
    else if (action.kind === 'instruction' && action.urgency === 'high') {
      ui.alert.style.display = 'block';
      ui.advice.textContent = action.text;
    } else if (action.kind === 'instruction') {
      ui.nudge.style.display = 'block';
      ui.nudgeText.textContent = action.text;
    } else if (action.kind === 'visual') {
      showToast(action.text);
    }
  }
}

function renderCare(stage, force = false) {
  if (!force && displayedStage && displayedStage.stage === stage.stage && displayedStage.provisional === stage.provisional) return;
  const previous = displayedStage;
  displayedStage = stage;
  const plan = agent.carePlan();
  ui.careLabel.textContent = `${plan.label}${plan.provisional ? ' · provisional' : ''} — ${plan.headline}`;
  ui.careAdvice.innerHTML = plan.advice.map((a) => `<li><b>${a.kind}</b>${escapeHtml(a.text)}</li>`).join('');
  if (previous && previous.stage !== stage.stage) showToast(`Care plan updated: ${plan.label}`);
}

function render(step) {
  const score = smoother.add(step.effective.score);
  const level = step.effective.level;
  const copy = {
    stable: ['Stable', 'Posture looks balanced'],
    caution: ['Caution', 'Slow down and steady yourself'],
    danger: ['High risk', 'Move to support now'],
  }[level];
  ui.score.textContent = score;
  ui.gauge.style.setProperty('--score', score);
  const color = level === 'danger' ? '#f16a55' : level === 'caution' ? '#e6a736' : '#70e0b7';
  ui.gauge.style.background = `conic-gradient(${color} ${score}%, #e2e8e4 0)`;
  ui.label.className = `risk-label ${level}`;
  ui.label.querySelector('b').textContent = copy[0];
  ui.label.querySelector('small').textContent = copy[1];

  ui.stateChip.textContent = step.state.toUpperCase();
  ui.stateChip.className = `state-chip ${step.state}`;

  const f = step.features;
  const fc = step.forecast;
  const forecastText = fc.imminent && fc.timeToDangerSec != null
    ? `Danger in ~${fc.timeToDangerSec.toFixed(1)} s`
    : fc.projectedLevel === 'danger' ? 'Rising toward danger'
      : fc.projectedLevel === 'caution' ? 'Trend rising'
        : fc.slope > 4 ? 'Watchful' : 'Steady';
  const dev = step.baseline.deviation;
  const fitText = !step.baseline.warm
    ? `Learning you (${Math.round(step.baseline.progress * 100)}%)`
    : dev.level === 'outside' ? `Unusual: ${FEATURE_NAMES[dev.top[0]] ?? 'movement pattern'}`
      : 'Matches your usual pattern';
  const symptomText = step.symptoms.active.length
    ? step.symptoms.active.map((a) => `${a.label} ${Math.round(a.level * 100)}%`).join(' · ')
    : 'None reported';

  const rows = [
    ['Body alignment', `${Math.round(f.torsoLean)}° lean`],
    ['Balance shift', f.lateralOffset > 1 ? 'Outside stance' : 'Centered'],
    ['Movement speed', f.hipDropSpeed > 0.35 ? 'Rapid drop' : 'Controlled'],
    ['Prediction', forecastText],
    ['Personal fit', fitText],
    ['Symptoms', symptomText],
  ];
  ui.signals.innerHTML = rows.map(([a, b]) => `<li><span>${a}</span><b>${escapeHtml(String(b))}</b></li>`).join('');

  if (!['caution', 'danger', 'imminent'].includes(step.state)) {
    ui.alert.style.display = 'none';
    ui.nudge.style.display = 'none';
  }
  renderCare(step.stage);
}

// Actions are never throttled (they are edge-triggered and sparse — alarms
// must not drop); only the DOM refresh is capped for high-rate sensor modes.
function handleStep(step, { throttled = false } = {}) {
  runActions(step.actions);
  const now = performance.now();
  if (!throttled || now - lastRenderAt >= DEFAULT_CONFIG.device.renderThrottleMs) {
    lastRenderAt = now;
    render(step);
  }
}

async function loadPoseModel() {
  if (poseLandmarker) return;
  const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/+esm');
  const fileset = await vision.FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm');
  poseLandmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });
}

function drawPose(points) {
  const c = ui.canvas;
  const ctx = c.getContext('2d');
  c.width = ui.video.videoWidth;
  c.height = ui.video.videoHeight;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#70e0b7';
  ctx.lineWidth = 4;
  ctx.shadowBlur = 10;
  ctx.shadowColor = '#70e0b7';
  connections.forEach(([a, b]) => {
    ctx.beginPath();
    ctx.moveTo(points[a].x * c.width, points[a].y * c.height);
    ctx.lineTo(points[b].x * c.width, points[b].y * c.height);
    ctx.stroke();
  });
  ctx.fillStyle = '#effff8';
  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x * c.width, p.y * c.height, 4, 0, Math.PI * 2);
    ctx.fill();
  });
}

function predictLoop() {
  if (mode !== 'camera' || !running) return;
  if (ui.video.currentTime !== lastVideoTime && ui.video.readyState >= 2) {
    lastVideoTime = ui.video.currentTime;
    const now = performance.now();
    const result = poseLandmarker.detectForVideo(ui.video, now);
    if (result.landmarks?.[0]) {
      const points = result.landmarks[0];
      drawPose(points);
      const t = (now - sessionStart) / 1000;
      const dt = previousAt ? (now - previousAt) / 1000 : 1 / 15;
      const observation = poseObservation(points, previousPose, dt, t);
      previousPose = observation.debug;
      previousAt = now;
      const step = agent.ingest({ ...observation, context: { obstacle: ui.obstacle.checked } });
      handleStep(step);
    }
  }
  requestAnimationFrame(predictLoop);
}

async function startCamera() {
  stopSim();
  stopSensor();
  try {
    ui.camera.disabled = true;
    ui.camera.textContent = 'Loading pose model…';
    await loadPoseModel();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    ui.video.srcObject = stream;
    await ui.video.play();
    startSession();
    mode = 'camera';
    running = true;
    sessionStart = performance.now();
    ui.empty.style.display = 'none';
    ui.live.style.display = 'block';
    ui.live.innerHTML = '<i></i> LIVE';
    ui.camera.textContent = 'Camera analysis active';
    requestAnimationFrame(predictLoop);
  } catch (e) {
    ui.camera.disabled = false;
    ui.camera.textContent = 'Try camera again';
    ui.empty.querySelector('h2').textContent = 'Camera unavailable';
    ui.empty.querySelector('p').textContent = e.message?.includes('Permission')
      ? 'Allow camera access to continue.'
      : 'Use a demo scenario while the model or camera is unavailable.';
  }
}

function stopCamera() {
  running = false;
  mode = 'idle';
  ui.video.srcObject?.getTracks().forEach((track) => track.stop());
  ui.video.srcObject = null;
  ui.live.style.display = 'none';
  ui.camera.disabled = false;
  ui.camera.textContent = 'Start camera analysis';
}

function startSim() {
  if (mode === 'camera') stopCamera();
  stopSensor();
  const name = ui.scenario.value;
  const { observations, checkins } = runScenario(name);
  simQueue = interleave(observations, checkins);
  simIndex = 0;
  startSession();
  mode = 'sim';
  running = true;
  ui.live.style.display = 'block';
  ui.live.innerHTML = `<i></i> SIM · ${escapeHtml(SCENARIOS[name].label.toUpperCase())}`;
  ui.demo.textContent = 'Stop scenario';
  demoTimer = setInterval(simTick, 66);
}

function simTick() {
  if (!simQueue) return;
  const obstacle = ui.obstacle.checked;
  for (let i = 0; i < SIM_EVENTS_PER_TICK && simIndex < simQueue.length; i += 1) {
    const event = simQueue[simIndex];
    simIndex += 1;
    if (event.kind === 'checkin') {
      const result = agent.ingestCheckin(event.checkin);
      showToast(`${result.label}: ${result.advice}`);
    } else {
      const step = agent.ingest({ ...event.observation, context: { obstacle } });
      handleStep(step);
    }
  }
  if (simIndex >= simQueue.length) stopSim();
}

function stopSim() {
  clearInterval(demoTimer);
  demoTimer = null;
  simQueue = null;
  simIndex = 0;
  if (mode === 'sim') {
    mode = 'idle';
    running = false;
  }
  ui.demo.textContent = 'Run scenario';
  ui.live.style.display = 'none';
  if (agent) renderCare(agent.stage(), true); // final, established classification
}

function stopSensor() {
  activeSource?.stop?.();
  activeSource = null;
  if (mode === 'motion' || mode === 'ble') {
    mode = 'idle';
    running = false;
    ui.live.style.display = 'none';
  }
  ui.motion.textContent = 'Use phone motion sensor';
  ui.ble.textContent = 'Connect BLE band';
}

function ingestDeviceObservation(observation) {
  const t0 = performance.now();
  const step = agent.ingest({ ...observation, context: { obstacle: ui.obstacle.checked } });
  perf.markIngest(performance.now() - t0);
  perf.markSample(observation.t);
  handleStep(step, { throttled: true });
  if (mode !== 'motion' && mode !== 'ble') return;
  const stats = perf.stats();
  const label = mode === 'motion' ? 'PHONE' : 'BLE';
  ui.live.innerHTML = `<i></i> ${label} · ${stats.hz.toFixed(0)} Hz · ${stats.p95.toFixed(1)} ms`;
  if (!perf.budgetWarned && perf.ingests.length >= 120 && stats.p95 > DEFAULT_CONFIG.device.maxIngestP95Ms) {
    perf.budgetWarned = true;
    showToast(`Processing p95 ${stats.p95.toFixed(1)} ms exceeds the ${DEFAULT_CONFIG.device.maxIngestP95Ms} ms budget — reduce UI refresh or sample rate.`);
  }
}

async function startMotion() {
  stopSim();
  stopSensor();
  if (mode === 'camera') stopCamera();
  const permission = await requestMotionPermission();
  if (permission !== 'granted') {
    showToast('Motion permission denied — allow Motion & Orientation Access and retry.');
    return;
  }
  startSession();
  const source = new DevicemotionSource({ onObservation: ingestDeviceObservation });
  source.start(window);
  activeSource = source;
  mode = 'motion';
  running = true;
  ui.empty.style.display = 'none';
  ui.live.style.display = 'block';
  ui.live.innerHTML = '<i></i> PHONE · warming up';
  ui.motion.textContent = 'Phone sensor active';
}

async function startBle() {
  stopSim();
  stopSensor();
  if (mode === 'camera') stopCamera();
  startSession();
  const source = new BleImuSource({
    onObservation: ingestDeviceObservation,
    onStatus: (status) => showToast(status),
  });
  try {
    ui.ble.disabled = true;
    ui.ble.textContent = 'Connecting…';
    await source.connect();
    activeSource = source;
    mode = 'ble';
    running = true;
    ui.empty.style.display = 'none';
    ui.live.style.display = 'block';
    ui.live.innerHTML = '<i></i> BLE · connected';
    ui.ble.textContent = 'BLE band streaming';
  } catch (e) {
    showToast(`BLE connection failed: ${e.message}`);
    ui.ble.textContent = 'Connect BLE band';
  } finally {
    ui.ble.disabled = false;
  }
}

ui.camera.onclick = () => { if (mode !== 'camera') startCamera(); };
ui.demo.onclick = () => { if (mode === 'sim') stopSim(); else startSim(); };
ui.motion.onclick = () => { if (mode !== 'motion') startMotion(); };
ui.ble.onclick = () => { if (mode !== 'ble') startBle(); };
ui.sound.onclick = () => { soundOn = !soundOn; ui.sound.textContent = soundOn ? 'Sound on' : 'Sound off'; };
ui.chips.addEventListener('click', (event) => {
  const button = event.target.closest('[data-symptom]');
  if (!button) return;
  if (!agent || !running) {
    showToast('Start monitoring first — check-ins apply to the live session.');
    return;
  }
  const result = agent.ingestCheckin({ t: agent.lastT, symptom: button.dataset.symptom, severity: 0.7 });
  showToast(`${result.label}: ${result.advice}`);
  button.classList.add('reported');
  setTimeout(() => button.classList.remove('reported'), 1600);
});
