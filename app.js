import { SisFallAgent } from './core/agent.js';
import { RiskSmoother } from './core/risk.js';
import { DEFAULT_CONFIG } from './core/config.js';
import { poseObservation } from './sources/pose.js';
import { runScenario, interleave, SCENARIOS } from './sources/sim.js';
import { DevicemotionSource, requestMotionPermission } from './sources/devicemotion.js';
import { BleImuSource } from './sources/web-bluetooth.js';
import { matchVoiceCommand, isScheduleDue, isDoseDue, dayKey } from './core/training.js';
import { DEFAULT_BPM, clampBpm, breathPhaseAt } from './core/music.js';

const $ = (id) => document.getElementById(id);
const ui = {
  video: $('video'), canvas: $('canvas'), empty: $('emptyState'), emptyText: $('emptyText'), live: $('liveBadge'),
  score: $('score'), gaugeBar: $('gaugeBar'), label: $('riskLabel'), signals: $('signals'),
  alert: $('alertBox'), advice: $('alertAdvice'), nudge: $('nudgeBox'), nudgeText: $('nudgeText'),
  toast: $('toast'), camera: $('cameraBtn'), demo: $('demoBtn'), scenario: $('scenario'),
  sound: $('soundBtn'), stateChip: $('stateChip'),
  motion: $('motionBtn'), ble: $('bleBtn'),
  askBar: $('askBar'), askText: $('askText'), askYes: $('askYes'), askNo: $('askNo'),
  trainBtn: $('trainBtn'), voiceBtn: $('voiceBtn'), trainingStatus: $('trainingStatus'),
  trainingNow: $('trainingNow'), trainExercise: $('trainExercise'), trainRemain: $('trainRemain'),
  trainProgress: $('trainProgress'), trainCue: $('trainCue'),
  scheduleOn: $('scheduleOn'), scheduleTime: $('scheduleTime'), scheduleState: $('scheduleState'),
  medOn: $('medOn'), medTime1: $('medTime1'), medTime2: $('medTime2'), medState: $('medState'),
  musicOn: $('musicOn'), musicMode: $('musicMode'), musicBpm: $('musicBpm'), musicState: $('musicState'),
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
const FEATURE_NAMES = { torsoLean: '前倾', lateralOffset: '重心偏移', hipDropSpeed: '下坠', kneeAsymmetry: '负重不均' };
const CARE_KINDS = { activity: '活动', environment: '环境', clinical: '就医', monitoring: '监测', care: '照护' };

// 环境行的展示：外部标记（测试/演示注入）优先，其次传感器推断的确认状态。
function environmentText(env = {}) {
  if (env.inferred?.active) return '已确认：湿滑/障碍 · 预警提前';
  if (env.obstacle || env.lowLight) return '外部标记 · 预警提前';
  if (env.pendingQuestion) return '待确认';
  return '正常';
}
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
    } else if (action.kind === 'question') {
      showAsk(action);
    }
  }
}

function renderCare(stage, force = false) {
  if (!force && displayedStage && displayedStage.stage === stage.stage && displayedStage.provisional === stage.provisional) return;
  const previous = displayedStage;
  displayedStage = stage;
  const plan = agent.carePlan();
  ui.careLabel.textContent = `${plan.label}${plan.provisional ? ' · 初步' : ''} — ${plan.headline}`;
  ui.careAdvice.innerHTML = plan.advice.map((a) => `<li><b>${CARE_KINDS[a.kind] ?? a.kind}</b>${escapeHtml(a.text)}</li>`).join('');
  if (previous && previous.stage !== stage.stage) showToast(`护理建议已更新：${plan.label}`);
}

function render(step) {
  const score = smoother.add(step.effective.score);
  const level = step.effective.level;
  const copy = {
    stable: ['平稳', '姿态平衡'],
    caution: ['注意', '放慢速度，稳住身体'],
    danger: ['高风险', '立即扶稳或坐下'],
  }[level];
  const color = level === 'danger' ? '#d33' : level === 'caution' ? '#d9822b' : '#2f9e6e';
  ui.score.textContent = score;
  ui.gaugeBar.style.width = `${score}%`;
  ui.gaugeBar.style.background = color;
  ui.label.className = `risk-label ${level}`;
  ui.label.textContent = `${copy[0]} · ${copy[1]}`;

  const stateText = {
    calibrating: '校准中',
    stable: '平稳',
    caution: '注意',
    imminent: '预警',
    danger: '危险',
    recovering: '恢复中',
  }[step.state] ?? step.state;
  ui.stateChip.textContent = stateText;
  ui.stateChip.className = `state-chip ${step.state}`;

  const f = step.features;
  const fc = step.forecast;
  const forecastText = fc.imminent && fc.timeToDangerSec != null
    ? `约 ${fc.timeToDangerSec.toFixed(1)} 秒后危险`
    : fc.projectedLevel === 'danger' ? '趋向危险'
      : fc.projectedLevel === 'caution' ? '风险上升'
        : fc.slope > 4 ? '留意' : '平稳';
  const dev = step.baseline.deviation;
  const fitText = !step.baseline.warm
    ? `正在学习您的基线（${Math.round(step.baseline.progress * 100)}%）`
    : dev.level === 'outside' ? `与平时不同：${FEATURE_NAMES[dev.top[0]] ?? '步态'}`
      : '与平时一致';
  const symptomText = step.symptoms.active.length
    ? step.symptoms.active.map((a) => `${a.label} ${Math.round(a.level * 100)}%`).join(' · ')
    : '无';

  const rows = [
    ['姿态', `${Math.round(f.torsoLean)}° 前倾`],
    ['重心', f.lateralOffset > 1 ? '移出支撑面' : '居中'],
    ['下降', f.hipDropSpeed > 0.35 ? '快速下坠' : '平稳'],
    ['预测', forecastText],
    ['个人基线', fitText],
    ['症状', symptomText],
    ['环境', environmentText(step.environment)],
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
      const step = agent.ingest(observation);
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
    ui.camera.textContent = '正在加载姿态模型…';
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
    ui.live.innerHTML = '<i></i> 实时';
    ui.camera.textContent = '相机分析已启用';
    requestAnimationFrame(predictLoop);
  } catch (e) {
    ui.camera.disabled = false;
    ui.camera.textContent = '重试相机';
    ui.emptyText.textContent = e.message?.includes('Permission')
      ? '请允许相机权限后继续。'
      : '相机或模型暂不可用，可先运行演示场景。';
  }
}

function stopCamera() {
  running = false;
  mode = 'idle';
  ui.video.srcObject?.getTracks().forEach((track) => track.stop());
  ui.video.srcObject = null;
  ui.live.style.display = 'none';
  ui.camera.disabled = false;
  ui.camera.textContent = '启动相机分析';
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
  ui.live.innerHTML = `<i></i> 模拟 · ${escapeHtml(SCENARIOS[name].label)}`;
  ui.demo.textContent = '停止场景';
  demoTimer = setInterval(simTick, 66);
}

function simTick() {
  if (!simQueue) return;
  for (let i = 0; i < SIM_EVENTS_PER_TICK && simIndex < simQueue.length; i += 1) {
    const event = simQueue[simIndex];
    simIndex += 1;
    if (event.kind === 'checkin') {
      const result = agent.ingestCheckin(event.checkin);
      showToast(`${result.label}: ${result.advice}`);
    } else {
      const step = agent.ingest(event.observation);
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
  ui.demo.textContent = '运行场景';
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
  ui.motion.textContent = '使用手机传感器';
  ui.ble.textContent = '连接蓝牙手环';
}

function ingestDeviceObservation(observation) {
  const t0 = performance.now();
  const step = agent.ingest(observation);
  perf.markIngest(performance.now() - t0);
  perf.markSample(observation.t);
  handleStep(step, { throttled: true });
  if (mode !== 'motion' && mode !== 'ble') return;
  const stats = perf.stats();
  const label = mode === 'motion' ? '手机' : '蓝牙';
  ui.live.innerHTML = `<i></i> ${label} · ${stats.hz.toFixed(0)} Hz · ${stats.p95.toFixed(1)} ms`;
  if (!perf.budgetWarned && perf.ingests.length >= 120 && stats.p95 > DEFAULT_CONFIG.device.maxIngestP95Ms) {
    perf.budgetWarned = true;
    showToast(`处理延迟 p95 ${stats.p95.toFixed(1)} ms 超出 ${DEFAULT_CONFIG.device.maxIngestP95Ms} ms 预算——请降低界面刷新率或采样率。`);
  }
}

async function startMotion() {
  stopSim();
  stopSensor();
  if (mode === 'camera') stopCamera();
  const permission = await requestMotionPermission();
  if (permission !== 'granted') {
    showToast('未获得运动传感器权限——请在浏览器设置中允许后重试。');
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
  ui.live.innerHTML = '<i></i> 手机 · 正在预热';
  ui.motion.textContent = '手机传感器已启用';
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
    ui.ble.textContent = '连接中…';
    await source.connect();
    activeSource = source;
    mode = 'ble';
    running = true;
    ui.empty.style.display = 'none';
    ui.live.style.display = 'block';
    ui.live.innerHTML = '<i></i> 蓝牙 · 已连接';
    ui.ble.textContent = '蓝牙手环已连接';
  } catch (e) {
    showToast(`蓝牙连接失败：${e.message}`);
    ui.ble.textContent = '连接蓝牙手环';
  } finally {
    ui.ble.disabled = false;
  }
}

// --- 环境询问：传感器推断触发的主动询问；用户回答才是环境的真实来源 ------
function showAsk(action) {
  ui.askText.textContent = action.detail ? `${action.text}（${action.detail}）` : action.text;
  ui.askBar.classList.add('open');
  if (speechOn) speak(action.text);
}

function answerEnvironment(yes) {
  ui.askBar.classList.remove('open');
  if (!agent) return;
  const result = agent.ingestEnvironmentAnswer({ t: agent.lastT, yes });
  showToast(result.advice);
}

ui.askYes.onclick = () => answerEnvironment(true);
ui.askNo.onclick = () => answerEnvironment(false);

// --- 康复训练：手动 / 语音唤出 / 定时 -------------------------------------
// 训练按“真实秒”推进（与仿真 4x 时间域解耦）：起点记在 source 时钟上，
// 之后用墙钟推进。仿真加速下 note 里的动作名可能滞后一帧，无碍安全。
let trainTicker = null;
let trainClock = null;
let speechOn = true;
let schedule = null;
let medication = null;
let lastScheduleFired = null;
let doseFired = {};

const SCHEDULE_KEY = 'sisfall.trainingSchedule';
const FIRED_KEY = 'sisfall.trainingFiredDay';
const MED_KEY = 'sisfall.medicationSchedule';
const DOSE_FIRED_KEY = 'sisfall.doseFired';

function speak(text) {
  if (!speechOn || typeof speechSynthesis === 'undefined') return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  } catch {
    /* 语音输出失败不影响安全路径 */
  }
}

function renderTraining(current) {
  if (!current) return;
  const active = !['idle', 'done'].includes(current.phase);
  ui.trainingNow.style.display = active ? 'grid' : 'none';
  if (current.phase === 'exercise') {
    ui.trainExercise.textContent = `${current.index + 1}/${current.total} · ${current.exercise.name}`;
    ui.trainCue.textContent = `${current.exercise.cue} 注意：${current.exercise.safety}`;
  } else {
    const titles = { intro: '准备', rest: '休息', outro: '完成' };
    ui.trainExercise.textContent = titles[current.phase] ?? '';
    ui.trainCue.textContent = current.cue ?? '';
  }
  ui.trainRemain.textContent = active ? `剩余 ${Math.ceil(current.remaining)} 秒` : '';
  ui.trainProgress.style.width = `${Math.round((current.progress ?? 0) * 100)}%`;
}

function startTraining(source = 'manual') {
  if (!agent || !running) {
    showToast('请先启动监测（相机/演示/传感器任一），训练时需要智能体观察姿态。');
    return;
  }
  const result = agent.startTraining(agent.lastT, { source });
  if (!result.ok) {
    showToast(result.reason);
    return;
  }
  const sourceStart = agent.lastT;
  const wallStart = performance.now() / 1000;
  trainClock = () => sourceStart + (performance.now() / 1000 - wallStart);
  ui.trainBtn.textContent = '结束训练';
  renderTraining(result.current);
  speak(`开始康复训练，共 ${result.plan.length} 个动作。${result.plan[0].cue}`);
  let lastExercise = -1;
  clearInterval(trainTicker);
  trainTicker = setInterval(() => {
    const current = agent ? agent.trainingProgress(trainClock()) : null;
    if (!current || current.phase === 'done') {
      endTraining({ completed: true });
      return;
    }
    renderTraining(current);
    if (current.phase === 'exercise' && current.index !== lastExercise) {
      lastExercise = current.index;
      speak(`${current.exercise.name}。${current.exercise.cue} 注意：${current.exercise.safety}`);
      // 音乐疗愈联动：节拍模式跟随当前动作的推荐 BPM（如节拍行走 100）
      if (music.on && music.mode === 'metronome') {
        music.bpm = clampBpm(current.exercise.bpm ?? music.baseBpm);
      }
    }
  }, 1000);
}

function endTraining({ completed }) {
  clearInterval(trainTicker);
  trainTicker = null;
  if (music.on) music.bpm = music.baseBpm; // 训练结束，节拍恢复面板设置
  if (!agent?.training.active) return;
  const t = trainClock ? trainClock() : agent.lastT;
  trainClock = null;
  const summary = agent.finishTraining(t, { completed });
  ui.trainBtn.textContent = '开始训练';
  ui.trainingNow.style.display = 'none';
  if (summary) {
    const minutes = Math.floor(summary.durationSec / 60);
    ui.trainingStatus.textContent = `上次：完成 ${summary.doneExercises}/${summary.totalExercises} · ${minutes} 分 ${summary.durationSec % 60} 秒 · 训练中峰值 ${summary.maxScore}`;
    speak(completed ? '训练完成，很好！' : '训练已结束。');
    if (summary.maxScore >= 72) {
      showToast('训练中出现过高风险姿态，请放慢动作并保持扶稳。');
    }
  }
}

ui.trainBtn.onclick = () => {
  if (agent?.training.active) endTraining({ completed: false });
  else startTraining('manual');
};

// 语音唤出（Web Speech API 识别 + 关键词匹配；不支持时自动降级为按钮）。
const SpeechRecognitionImpl = window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
let recognition = null;
let voiceOn = false;

function setVoice(on) {
  if (on && !SpeechRecognitionImpl) {
    showToast('此浏览器不支持语音识别（可用桌面版 Chrome/Edge）。');
    return;
  }
  voiceOn = on;
  ui.voiceBtn.textContent = voiceOn ? '语音唤出：监听中' : '语音唤出：关';
  if (!voiceOn) {
    recognition?.stop?.();
    recognition = null;
    return;
  }
  recognition = new SpeechRecognitionImpl();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const command = matchVoiceCommand(event.results[i][0].transcript);
      if (command === 'start' && !agent?.training.active) startTraining('voice');
      if (command === 'stop' && agent?.training.active) endTraining({ completed: false });
    }
  };
  recognition.onend = () => {
    if (voiceOn && recognition) {
      try {
        recognition.start();
      } catch {
        /* 重启失败则等待下一次点击 */
      }
    }
  };
  recognition.onerror = () => {};
  try {
    recognition.start();
  } catch {
    showToast('语音识别启动失败，可改用按钮或定时提醒。');
    setVoice(false);
  }
}

ui.voiceBtn.onclick = () => setVoice(!voiceOn);

// --- 音乐疗愈：Web Audio 合成的节拍/呼吸提示（零音频文件、离线可用）--------
// 节拍用于步态节律提示（RAS 方向）；呼吸引导（4-4-6）为放松辅助。
// 训练中若当前动作带 bpm（如节拍行走 100），节拍自动采用动作节奏。
let audioCtx = null;
const music = { on: false, mode: 'metronome', bpm: DEFAULT_BPM, baseBpm: DEFAULT_BPM, startedAt: 0, nextBeat: 0, lastStageKey: '', ticker: null, render: null };
const BREATH_STAGE_TEXT = { inhale: '吸气', hold: '屏息', exhale: '呼气' };

function ensureAudio() {
  if (!audioCtx) {
    const Impl = window.AudioContext ?? window.webkitAudioContext;
    if (!Impl) return null;
    audioCtx = new Impl();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function beatSound(accent = false) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = accent ? 1040 : 880;
  gain.gain.setValueAtTime(accent ? 0.09 : 0.06, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.07);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.08);
}

function chime(rising) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(rising ? 392 : 660, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(rising ? 660 : 392, ctx.currentTime + 0.6);
  gain.gain.setValueAtTime(0.05, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.7);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.75);
}

function musicTick() {
  const now = performance.now() / 1000;
  if (music.mode === 'metronome') {
    const interval = 60 / music.bpm;
    let guard = 8;
    while (music.nextBeat <= now + 0.05 && guard > 0) {
      const index = Math.round((music.nextBeat - music.startedAt) / interval);
      beatSound(index % 4 === 0);
      music.nextBeat += interval;
      guard -= 1;
    }
  } else {
    const phase = breathPhaseAt(now, { startedAt: music.startedAt });
    const key = `${phase.cycleIndex}:${phase.stageIndex}`;
    if (key !== music.lastStageKey) {
      music.lastStageKey = key;
      if (phase.stage === 'inhale') chime(true);
      if (phase.stage === 'exhale') chime(false);
    }
  }
}

function renderMusicState() {
  if (!music.on) {
    ui.musicState.textContent = '未开启——节拍用于步态节律提示，呼吸用于放松。';
    return;
  }
  if (music.mode === 'metronome') {
    ui.musicState.textContent = `节拍提示 · ${music.bpm} BPM（跟随迈步）`;
  } else {
    const phase = breathPhaseAt(performance.now() / 1000, { startedAt: music.startedAt });
    ui.musicState.textContent = `呼吸引导 · ${BREATH_STAGE_TEXT[phase.stage]} ${Math.ceil(phase.remaining)} 秒`;
  }
}

function applyMusicSettings() {
  music.mode = ui.musicMode.value === 'breath' ? 'breath' : 'metronome';
  music.baseBpm = clampBpm(Number(ui.musicBpm.value));
  music.bpm = music.baseBpm;
  ui.musicBpm.disabled = music.mode !== 'metronome';
  music.startedAt = performance.now() / 1000;
  music.nextBeat = music.startedAt;
  music.lastStageKey = '';
  renderMusicState();
}

function startMusic() {
  if (!ensureAudio()) {
    showToast('此浏览器不支持音频合成（Web Audio），音乐疗愈不可用。');
    ui.musicOn.checked = false;
    return;
  }
  music.on = true;
  clearInterval(music.ticker);
  clearInterval(music.render);
  music.ticker = setInterval(musicTick, 40);
  music.render = setInterval(renderMusicState, 500);
  renderMusicState();
}

function stopMusic() {
  music.on = false;
  clearInterval(music.ticker);
  clearInterval(music.render);
  music.ticker = null;
  music.render = null;
  renderMusicState();
}

ui.musicOn.onchange = () => {
  if (ui.musicOn.checked) {
    applyMusicSettings();
    startMusic();
  } else {
    stopMusic();
  }
};
ui.musicMode.onchange = applyMusicSettings;
ui.musicBpm.onchange = applyMusicSettings;

// 定时提醒（页面需保持打开；系统级提醒属后续里程碑——见 README）。
function loadSchedule() {
  try {
    schedule = JSON.parse(localStorage.getItem(SCHEDULE_KEY) ?? 'null') ?? { ...DEFAULT_CONFIG.training.schedule };
    lastScheduleFired = localStorage.getItem(FIRED_KEY);
    medication = JSON.parse(localStorage.getItem(MED_KEY) ?? 'null') ?? { ...DEFAULT_CONFIG.training.medication };
    doseFired = JSON.parse(localStorage.getItem(DOSE_FIRED_KEY) ?? 'null') ?? {};
  } catch {
    schedule = { ...DEFAULT_CONFIG.training.schedule };
    medication = { ...DEFAULT_CONFIG.training.medication };
    doseFired = {};
  }
  ui.scheduleOn.checked = Boolean(schedule.enabled);
  ui.scheduleTime.value = schedule.time ?? '09:00';
  ui.medOn.checked = Boolean(medication.enabled);
  ui.medTime1.value = medication.times?.[0] ?? '08:00';
  ui.medTime2.value = medication.times?.[1] ?? '20:00';
  renderScheduleState();
}

function saveSchedule() {
  schedule = { enabled: ui.scheduleOn.checked, time: ui.scheduleTime.value || '09:00' };
  medication = {
    enabled: ui.medOn.checked,
    times: [ui.medTime1.value || '08:00', ui.medTime2.value || '20:00'],
  };
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(schedule));
    localStorage.setItem(MED_KEY, JSON.stringify(medication));
  } catch {
    /* 隐私模式下可能不可用，内存态照常工作 */
  }
  renderScheduleState();
}

function renderScheduleState() {
  ui.scheduleState.textContent = schedule?.enabled
    ? `每天 ${schedule.time}${agent ? '' : '（需先启动监测）'}`
    : '未启用';
  ui.medState.textContent = medication?.enabled ? `每天 ${medication.times.join(' / ')}` : '未启用';
}

function scheduleWatch() {
  if (schedule?.enabled && !agent?.training.active && isScheduleDue(schedule, new Date(), lastScheduleFired)) {
    lastScheduleFired = dayKey(new Date());
    try {
      localStorage.setItem(FIRED_KEY, lastScheduleFired);
    } catch {
      /* 同上 */
    }
    showToast(`该做康复训练了（每天 ${schedule.time}）。点击“开始训练”。`);
    speak('该做康复训练了。请点击开始训练。');
  }
  if (medication?.enabled) {
    const dueTime = isDoseDue(medication.times, new Date(), doseFired);
    if (dueTime) {
      doseFired[`${dayKey(new Date())}:${dueTime}`] = true;
      try {
        localStorage.setItem(DOSE_FIRED_KEY, JSON.stringify(doseFired));
      } catch {
        /* 同上 */
      }
      showToast(`服药时间提醒（${dueTime}）——请遵医嘱服用。`);
      speak('服药时间到了，请遵医嘱。');
    }
  }
}

ui.scheduleOn.onchange = saveSchedule;
ui.scheduleTime.onchange = saveSchedule;
ui.medOn.onchange = saveSchedule;
ui.medTime1.onchange = saveSchedule;
ui.medTime2.onchange = saveSchedule;
setInterval(scheduleWatch, 30000);

loadSchedule();

ui.camera.onclick = () => { if (mode !== 'camera') startCamera(); };
ui.demo.onclick = () => { if (mode === 'sim') stopSim(); else startSim(); };
ui.motion.onclick = () => { if (mode !== 'motion') startMotion(); };
ui.ble.onclick = () => { if (mode !== 'ble') startBle(); };
ui.sound.onclick = () => { soundOn = !soundOn; ui.sound.textContent = soundOn ? '声音：开' : '声音：关'; };
ui.chips.addEventListener('click', (event) => {
  const button = event.target.closest('[data-symptom]');
  if (!button) return;
  if (!agent || !running) {
    showToast('请先开始监测——症状签到仅对当前会话生效。');
    return;
  }
  const result = agent.ingestCheckin({ t: agent.lastT, symptom: button.dataset.symptom, severity: 0.7 });
  showToast(`${result.label}: ${result.advice}`);
  button.classList.add('reported');
  setTimeout(() => button.classList.remove('reported'), 1600);
});
