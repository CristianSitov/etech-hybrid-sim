'use strict';

/*
 * E-Tech hybrid simulator.
 * Every number in CFG is illustrative, not Renault calibration data.
 * Speeds in km/h, accelerations in km/h per second, engine speed in rpm.
 */
const CFG = {
  engineRatios: [0, 70, 47, 34, 26], // rpm per km/h, engine gears 1..4 (index 0 = neutral)
  regenByLevel: [0, 0.8, 1.8, 3],    // one-pedal decel for paddle levels 0..3
  maxSpeed: 180,

  gearMaxRpm: 5200,      // never pick a gear that would put the engine above this
  overRevRpm: 5600,      // force an upshift if locked in gear above this
  seriesRpm: 2000,       // engine speed while it only drives the HSG generator

  evMaxSpeed: 20,        // below this the car always pulls away on the e-motor
  seriesMaxSpeed: 30,    // low battery below this speed: series hybrid
  cruiseSpeed: 80,       // above this, light load is handled by the engine
  eGearUp: 72,           // e-motor 1 -> 2
  eGearDown: 62,         // e-motor 2 -> 1

  socStart: 60,
  socLowOn: 28,          // battery-protect mode starts below this
  socLowOff: 40,         // ...and ends above this
  socFull: 97,           // no regen above this
  socMin: 5,

  modeHold: 0.3,         // s a new drive mode must persist before switching
  gearHold: 0.5,         // s a new engine gear must persist before shifting
  brakeDecel: 9,         // total decel with the brake held (regen + friction)
  slowMotion: 0.15,      // time scale during shifts when slow motion is on

  sync: {                // HSG speed controller (spring-damper with jitter)
    stiffness: 900,
    damping: 27,
    jitter: 80000,
    tolerance: 25,       // rpm difference at which the dog may engage
    timeout: 1.5,
  },
  releaseTime: 0.06,     // s for the dog to pull out
  engageTime: 0.05,      // s for the dog to slide in
};

const MODE_NAMES = {
  stopped: 'Stopped',
  ev: 'EV',
  series: 'Series hybrid',
  parallel: 'Parallel hybrid',
  charge: 'Engine + recharge',
  regen: 'Regen',
  brake: 'Regen + brakes',
  coast: 'Coasting',
};

/* ---------- Simple performance model ---------- */
const accelElectric = (v) => Math.min(5, 200 / Math.max(v, 40));
const accelEngine = (v) => Math.min(6, 480 / Math.max(v, 50));
const regenAvailable = (v, soc) =>
  soc >= CFG.socFull ? 0 : Math.min(4, 200 / Math.max(v, 40)) * Math.min(1, v / 8);
const drag = (v) => (v > 0.1 ? 0.15 + 0.00009 * v * v : 0);

/* ---------- State ---------- */
const S = {
  speed: 0,
  soc: CFG.socStart,
  pedal: 0,
  brake: false,
  regenLevel: 1,
  lowBattery: false,

  mode: 'stopped',
  pendingMode: null,
  pendingModeT: 0,

  eGear: 1,              // e-motor gear (1 or 2)
  engineGear: 1,         // engine gear the dog is in (or was last in)
  shiftTarget: 1,        // gear being synced to
  gearWanted: 1,         // gear the strategy wants (after hysteresis)
  gearPending: 1,
  gearPendingT: 0,
  wasCoupled: false,

  phase: 'idle',         // idle | release | sync | engage | out
  phaseT: 0,
  engagement: 0,         // 0 = dog out, 1 = dog fully in
  rpm: 0,
  rpmVel: 0,
  dogOffset: 31,         // sleeve tooth position in the close-up

  dash: 0,
  pistonPhase: 0,
  gearAngles: [],
  lastTs: 0,
  lastDesc: '',
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const svg = $('sv');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const gearEls = [...svg.querySelectorAll('.gr')];
const pistonEls = [...svg.querySelectorAll('.pis')];
const sleeveTeeth = [];
S.gearAngles = gearEls.map(() => 0);

(function buildDogTeeth() {
  const NS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 10; i++) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('width', 18);
    r.setAttribute('height', 26);
    r.setAttribute('rx', 2);
    r.setAttribute('fill', '#D85A30');
    $('sT').appendChild(r);
    sleeveTeeth.push(r);
  }
  for (let i = -1; i < 8; i++) {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', 370 + i * 40 + 11);
    r.setAttribute('y', 500);
    r.setAttribute('width', 18);
    r.setAttribute('height', 24);
    r.setAttribute('rx', 2);
    r.setAttribute('fill', '#888780');
    $('gTe').appendChild(r);
  }
})();

/* ---------- Energy management strategy ---------- */
function chooseMode() {
  const v = S.speed;
  const p = S.pedal;
  if (S.brake) return v > 0.3 ? 'brake' : 'stopped';
  if (p <= 0.01) {
    if (v < 0.3) return 'stopped';
    return S.regenLevel > 0 ? 'regen' : 'coast';
  }
  const demand = p * (accelElectric(v) + accelEngine(v));
  if (S.lowBattery && v < CFG.seriesMaxSpeed) return 'series';
  if (v < CFG.evMaxSpeed) return 'ev';
  if (S.lowBattery) return demand > accelEngine(v) * 0.85 ? 'parallel' : 'charge';
  if (v >= CFG.cruiseSpeed) return demand > accelEngine(v) * 0.8 ? 'parallel' : 'charge';
  return demand > accelElectric(v) * 0.85 ? 'parallel' : 'ev';
}

// Tallest gear that keeps the engine between a pedal-dependent floor and the rpm ceiling.
function chooseEngineGear() {
  const R = CFG.engineRatios;
  const minRpm = 1400 + 2400 * S.pedal;
  for (let k = 4; k >= 1; k--) {
    const rpm = S.speed * R[k];
    if (rpm >= minRpm && rpm <= CFG.gearMaxRpm) return k;
  }
  for (let k = 1; k <= 4; k++) if (S.speed * R[k] <= CFG.gearMaxRpm) return k;
  return 4;
}

const isCoupledMode = (m) => m === 'parallel' || m === 'charge';
const isShifting = () => S.phase === 'release' || S.phase === 'sync' || S.phase === 'engage';
const isLocked = () => isCoupledMode(S.mode) && S.phase === 'idle' && S.engagement >= 1;

function updateMode(dt) {
  const wanted = chooseMode();
  if (wanted === S.mode) {
    S.pendingMode = null;
    return;
  }
  const immediate = ['brake', 'regen', 'coast', 'stopped'].includes(wanted) || S.mode === 'stopped';
  if (immediate) {
    S.mode = wanted;
    S.pendingMode = null;
    return;
  }
  if (S.pendingMode !== wanted) {
    S.pendingMode = wanted;
    S.pendingModeT = 0;
  }
  S.pendingModeT += dt;
  if (S.pendingModeT > CFG.modeHold) {
    S.mode = wanted;
    S.pendingMode = null;
  }
}

function updateGearWanted(dt) {
  const coupled = isCoupledMode(S.mode);
  const best = chooseEngineGear();
  if (coupled) {
    if (!S.wasCoupled) {
      S.gearWanted = best;
      S.gearPending = best;
    } else if (best !== S.gearWanted) {
      if (S.gearPending !== best) {
        S.gearPending = best;
        S.gearPendingT = 0;
      }
      S.gearPendingT += dt;
      if (S.gearPendingT > CFG.gearHold) S.gearWanted = best;
    } else {
      S.gearPending = S.gearWanted;
    }
    const lockedNow = S.phase === 'idle' && S.engagement >= 1;
    if (lockedNow && S.speed * CFG.engineRatios[S.engineGear] > CFG.overRevRpm) {
      S.gearWanted = Math.min(4, S.engineGear + 1);
    }
  }
  S.wasCoupled = coupled;
}

/* ---------- Dogbox and HSG synchronisation ---------- */
function updateDogbox(dt) {
  const coupled = isCoupledMode(S.mode);
  const R = CFG.engineRatios;

  // Decide whether a shift (or a decouple) has to start.
  if (coupled) {
    if (S.phase === 'idle' || S.phase === 'out') {
      const alreadyInGear = S.phase === 'idle' && S.engagement >= 1 && S.engineGear === S.gearWanted;
      if (!alreadyInGear) {
        S.phase = S.engagement > 0 ? 'release' : 'sync';
        S.shiftTarget = S.gearWanted;
        S.phaseT = 0;
      }
    } else if (S.phase === 'sync') {
      S.shiftTarget = S.gearWanted;
    }
  } else if (S.phase !== 'idle' || S.engagement > 0) {
    S.phase = 'out';
  }

  // Advance the current phase.
  if (S.phase === 'release') {
    S.phaseT += dt;
    S.engagement = Math.max(0, S.engagement - dt / CFG.releaseTime);
    if (S.engagement <= 0 && S.phaseT > 0.08) {
      S.phase = 'sync';
      S.phaseT = 0;
      S.rpmVel = 0;
    }
  } else if (S.phase === 'sync') {
    S.phaseT += dt;
    const target = S.speed * R[S.shiftTarget];
    const c = CFG.sync;
    let rem = dt;
    while (rem > 0) {
      const h = Math.min(rem, 0.002);
      const acc = c.stiffness * (target - S.rpm) - c.damping * S.rpmVel + Math.sin(S.phaseT * 90) * c.jitter;
      S.rpmVel += acc * h;
      S.rpm += S.rpmVel * h;
      rem -= h;
    }
    const settled = Math.abs(S.rpm - target) < c.tolerance && Math.abs(S.rpmVel) < 600 && S.phaseT > 0.05;
    if (settled || S.phaseT > c.timeout) {
      S.phase = 'engage';
      S.phaseT = 0;
    }
  } else if (S.phase === 'engage') {
    S.phaseT += dt;
    const target = S.speed * R[S.shiftTarget];
    S.rpm += (target - S.rpm) * Math.min(1, dt * 40);
    let d = (((31 - S.dogOffset) % 40) + 40) % 40;
    if (d > 20) d -= 40;
    S.dogOffset += d * Math.min(1, dt * 60);
    S.engagement = Math.min(1, S.engagement + dt / CFG.engageTime);
    if (S.engagement >= 1) {
      S.engineGear = S.shiftTarget;
      S.phase = 'idle';
      S.rpm = target;
      S.rpmVel = 0;
      S.dogOffset = 31;
      clack();
    }
  } else if (S.phase === 'out') {
    S.engagement = Math.max(0, S.engagement - dt / CFG.releaseTime);
    if (S.engagement <= 0) S.phase = 'idle';
  }

  // Engine speed when not being synced.
  if (isLocked()) {
    S.rpm = S.speed * R[S.engineGear];
  } else if (S.phase === 'idle' || S.phase === 'out') {
    const target = S.mode === 'series' ? CFG.seriesRpm : 0;
    S.rpm += (target - S.rpm) * Math.min(1, dt * (target ? 4 : 2.5));
    if (S.rpm < 30 && !target) S.rpm = 0;
  }
}

/* ---------- Vehicle and battery ---------- */
function updateVehicle(dt) {
  const v = S.speed;
  const locked = isLocked();
  const demand = S.pedal * (accelElectric(v) + accelEngine(v));
  let drive = 0;
  let regen = 0;
  let friction = 0;

  switch (S.mode) {
    case 'ev':
      drive = S.soc > CFG.socMin ? Math.min(demand, accelElectric(v)) : 0;
      break;
    case 'series':
      drive = Math.min(demand, accelElectric(v));
      break;
    case 'parallel':
      drive = locked ? Math.min(demand, accelElectric(v) + accelEngine(v)) : Math.min(demand, accelElectric(v));
      break;
    case 'charge':
      drive = locked ? Math.min(demand, accelEngine(v) * 0.9) : Math.min(demand, accelElectric(v));
      break;
    case 'regen':
      regen = Math.min(CFG.regenByLevel[S.regenLevel], regenAvailable(v, S.soc));
      drive = -regen;
      break;
    case 'brake':
      regen = regenAvailable(v, S.soc);
      friction = Math.max(0, CFG.brakeDecel - regen);
      drive = -(regen + friction);
      break;
  }

  S.speed = Math.min(CFG.maxSpeed, Math.max(0, v + (drive - drag(v)) * dt));
  if (S.mode === 'brake' && S.speed < 0.3) S.speed = 0;

  const eDrive = drive > 0 &&
    (S.mode === 'ev' || S.mode === 'series' || S.mode === 'parallel' || (S.mode === 'charge' && !locked));
  const eState = eDrive ? 'Drive' : regen > 0 ? 'Generator' : 'Idle';
  const hsgGenerating = S.mode === 'series' || (S.mode === 'charge' && locked);

  // Battery state of charge, in % per second.
  let dSoc = 0;
  if (eDrive) dSoc -= drive * Math.max(S.speed, 10) * 0.012 * (S.mode === 'parallel' && locked ? 0.5 : 1);
  if (regen > 0) dSoc += regen * S.speed * 0.008;
  if (S.mode === 'charge' && locked) dSoc += 0.6;
  if (S.mode === 'series') dSoc += 0.7;
  S.soc = Math.max(CFG.socMin, Math.min(100, S.soc + dSoc * dt));
  if (S.soc < CFG.socLowOn) S.lowBattery = true;
  if (S.soc > CFG.socLowOff) S.lowBattery = false;

  // E-motor two-speed with hysteresis.
  const nextEGear = S.speed > CFG.eGearUp ? 2 : S.speed < CFG.eGearDown ? 1 : S.eGear;
  if (nextEGear !== S.eGear) {
    S.eGear = nextEGear;
    $('sE').style.transform = 'translateX(' + (S.eGear === 1 ? -20 : 20) + 'px)';
  }

  return { eDrive, eState, hsgGenerating, regen, friction };
}

/* ---------- Rendering ---------- */
function setFlow(el, dir) {
  el.classList.toggle('off', !dir);
  el.classList.toggle('rev', dir < 0);
}

function clack() {
  const g = $('main');
  g.classList.remove('clk');
  g.getBoundingClientRect();
  g.classList.add('clk');
}

function needle(el, cx, cy, frac, r0, r1) {
  const a = Math.PI - frac * Math.PI;
  el.setAttribute('x1', cx + r0 * Math.cos(a));
  el.setAttribute('y1', cy - r0 * Math.sin(a));
  el.setAttribute('x2', cx + r1 * Math.cos(a));
  el.setAttribute('y2', cy - r1 * Math.sin(a));
}

function describe() {
  const g = S.gearWanted;
  switch (S.mode) {
    case 'stopped': return 'Stopped. Press the accelerator: the car always pulls away on the e-motor.';
    case 'ev': return 'EV: light load, the e-motor drives alone. The engine is off and its dog sits in neutral.';
    case 'series': return 'Series hybrid: the battery is low at low speed, so the engine spins the HSG as a generator for the e-motor.';
    case 'parallel': return 'Parallel hybrid: you are asking for more than the e-motor can give, so the engine joins in gear ' + g + '.';
    case 'charge': return S.lowBattery
      ? 'Battery low: the engine drives the wheels in gear ' + g + ' while the HSG recharges.'
      : 'Cruising: the engine drives in gear ' + g + ' and spare torque turns the HSG to top up the battery.';
    case 'regen': return S.soc >= CFG.socFull
      ? 'Battery full: no regen available, so the car just coasts.'
      : 'One-pedal regen level ' + S.regenLevel + ': the e-motor works as a generator and slows the car.';
    case 'brake': return S.soc >= CFG.socFull
      ? 'Battery full: friction brakes do all the work.'
      : 'Braking: the e-motor regenerates as much as it can and the friction brakes add the rest.';
    case 'coast': return 'Regen 0 and foot off: the engine is off and decoupled, so the car coasts freely.';
  }
  return '';
}

function render(dt, out) {
  const mv = reducedMotion ? 0 : 1;
  const R = CFG.engineRatios;
  const locked = isLocked();
  const syncing = S.phase === 'sync' || S.phase === 'engage';
  const coupled = isCoupledMode(S.mode);

  // Dog clutch close-up.
  const shownGear = S.phase === 'idle' || S.phase === 'out' ? S.engineGear : S.shiftTarget;
  const gearRpm = S.speed * R[shownGear];
  const diff = S.rpm - gearRpm;
  if (!locked && S.phase !== 'engage') S.dogOffset += diff * 4 * dt;
  const pm = ((S.dogOffset % 40) + 40) % 40;
  const sleeveY = 456 + S.engagement * 30;
  sleeveTeeth.forEach((r, i) => {
    r.setAttribute('x', 330 + i * 40 + pm);
    r.setAttribute('y', sleeveY);
  });
  $('sBody').setAttribute('y', sleeveY - 10);

  const matched = Math.abs(diff) < CFG.sync.tolerance;
  $('win').setAttribute('stroke', locked || matched ? '#639922' : Math.abs(diff) > 300 ? '#D85A30' : 'var(--b)');
  let status;
  if (locked) status = 'Locked: sleeve and gear turn together';
  else if (S.phase === 'engage') status = 'Matched: teeth slide into the gaps';
  else if (S.phase === 'sync') status = S.rpm < 700 ? 'HSG cranking the engine' : 'HSG matching speed, ' + Math.round(Math.abs(diff)) + ' rpm to go';
  else if (S.phase === 'release') status = 'Dog releasing, e-motor fills the gap';
  else status = 'Neutral: gear spins freely past the sleeve';
  $('st').textContent = status;
  $('dTxt').textContent = 'Δ ' + Math.round(Math.abs(diff) / 10) * 10 + ' rpm';

  // Gauges.
  needle($('ndl'), 255, 520, Math.min(S.rpm, 6200) / 6000, 0, 54);
  needle($('tgt'), 255, 520, Math.min(gearRpm, 6200) / 6000, 44, 66);
  needle($('sN'), 85, 520, S.speed / CFG.maxSpeed, 0, 54);
  $('sTx').textContent = Math.round(S.speed) + ' km/h';

  // Engine-side sleeve in the main schematic.
  const side = shownGear % 2 ? -1 : 1;
  $('sI').setAttribute('transform', 'translate(' + side * 20 * S.engagement + ' 0)');
  $('sI').setAttribute('fill', S.engagement >= 1 ? '#D85A30' : 'var(--bg2)');

  // Power flows.
  S.dash -= S.rpm * 0.03 * dt * mv;
  $('fI').style.strokeDashoffset = S.dash;
  $('fI').setAttribute('opacity', S.rpm > 50 ? 1 : 0);
  $('fOc').classList.toggle('off', !locked);
  const eDir = out.eState === 'Drive' ? 1 : out.eState === 'Generator' ? -1 : 0;
  setFlow($('fE'), eDir);
  setFlow($('fOt'), eDir);
  setFlow($('fBE'), eDir);
  $('fOt').setAttribute('stroke-width', out.eDrive && coupled && !locked ? 5 : 2.5);
  setFlow($('fBH'), syncing ? 1 : out.hsgGenerating && S.rpm > 500 ? -1 : 0);
  $('hsgG').setAttribute('class', syncing ? 'c-amber' : 'c-teal');
  $('cal').setAttribute('fill', out.friction > 0 ? '#E24B4A' : 'var(--t)');
  $('cal').setAttribute('opacity', out.friction > 0 ? 1 : 0.6);

  // Moving parts.
  S.pistonPhase += S.rpm * 0.01 * dt * mv;
  pistonEls.forEach((r, i) => {
    const y = S.rpm > 50 ? Math.sin(S.pistonPhase + (i % 2) * Math.PI) * 3 : 0;
    r.setAttribute('transform', 'translate(0 ' + y + ')');
  });
  const spin = { a: S.speed * R[1] * 0.06, b: S.speed * R[2] * 0.06, o: -S.speed * 1.6, w: S.speed * 5, h: S.rpm * 0.15 };
  gearEls.forEach((g, i) => {
    S.gearAngles[i] = (S.gearAngles[i] + spin[g.dataset.k] * dt * mv) % 360;
    g.setAttribute('transform', 'rotate(' + S.gearAngles[i] + ' ' + g.dataset.cx + ' ' + g.dataset.cy + ')');
  });

  // Battery.
  $('socT').textContent = Math.round(S.soc) + '%';
  $('socB').setAttribute('width', 92 * S.soc / 100);
  $('socB').setAttribute('fill', S.soc < CFG.socLowOn ? '#BA7517' : '#1D9E75');

  // Readouts.
  $('rM').textContent = MODE_NAMES[S.mode];
  $('rI').textContent = S.rpm > 50 ? Math.round(S.rpm / 10) * 10 + ' rpm' : 'Off';
  $('rH').textContent = syncing
    ? (S.rpm < 700 ? 'Starting engine' : 'Matching speed')
    : out.hsgGenerating && S.rpm > 500 ? 'Generator' : S.rpm > 50 ? 'Idle' : 'Off';
  $('rE').textContent = out.eState;
  const engGear = locked ? S.engineGear : syncing || S.phase === 'release' ? S.engineGear + '→' + S.shiftTarget : 'N';
  $('rG').textContent = engGear + ' / ' + S.eGear;
  $('rB').textContent = out.friction > 0 ? 'Friction + regen' : out.regen > 0 ? 'Regen only' : 'Off';

  const d = describe();
  if (d !== S.lastDesc) {
    $('desc').textContent = d;
    S.lastDesc = d;
  }
}

/* ---------- Main loop ---------- */
function frame(ts) {
  const realDt = S.lastTs ? Math.min(0.05, (ts - S.lastTs) / 1000) : 0;
  S.lastTs = ts;
  const dt = realDt * (isShifting() && $('slow').checked ? CFG.slowMotion : 1);

  updateMode(dt);
  updateGearWanted(dt);
  updateDogbox(dt);
  const out = updateVehicle(dt);
  render(dt, out);

  requestAnimationFrame(frame);
}

/* ---------- Controls ---------- */
function setRegenLevel(n) {
  S.regenLevel = Math.max(0, Math.min(3, n));
  document.querySelectorAll('.pip').forEach((x, i) => x.classList.toggle('on', i < S.regenLevel));
  $('rl').textContent = 'Level ' + S.regenLevel;
}

function setPedal(pct) {
  S.pedal = pct / 100;
  $('acc').value = pct;
  $('accO').textContent = pct + '%';
}

$('acc').addEventListener('input', (e) => setPedal(Number(e.target.value)));
$('lift').addEventListener('click', () => setPedal(0));

const brakeBtn = $('brk');
const brakeOn = () => { S.brake = true; brakeBtn.classList.add('on'); };
const brakeOff = () => { S.brake = false; brakeBtn.classList.remove('on'); };
brakeBtn.addEventListener('pointerdown', (e) => {
  brakeOn();
  try { brakeBtn.setPointerCapture(e.pointerId); } catch (_) { /* not supported */ }
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((n) => brakeBtn.addEventListener(n, brakeOff));
brakeBtn.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); brakeOn(); }
});
brakeBtn.addEventListener('keyup', (e) => {
  if (e.key === ' ' || e.key === 'Enter') brakeOff();
});
brakeBtn.addEventListener('contextmenu', (e) => e.preventDefault());

$('rm').addEventListener('click', () => setRegenLevel(S.regenLevel - 1));
$('rp').addEventListener('click', () => setRegenLevel(S.regenLevel + 1));

setRegenLevel(1);
requestAnimationFrame(frame);

// Exposed for debugging and tests in the browser console.
window.etech = { CFG, S, setPedal, setRegenLevel, brakeOn, brakeOff };
