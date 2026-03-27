// =============================================================================
//  DEPTH-PROBE — Vector Edition
//  game.js — all game logic, rendering, audio
// =============================================================================

// ─── Perlin Noise (1D fBm) ────────────────────────────────────────────────────
const _perm = (() => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  let seed = 0x4454;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [p[i], p[j]] = [p[j], p[i]];
  }
  return Uint8Array.from([...p, ...p]);
})();

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function lerp(a, b, t) {
  return a + t * (b - a);
}
function grad1(h, x) {
  return h & 1 ? x : -x;
}

function perlin1(x) {
  const X = Math.floor(x) & 255;
  const xf = x - Math.floor(x);
  return lerp(grad1(_perm[X], xf), grad1(_perm[X + 1], xf - 1), fade(xf));
}

function fbm(x, octaves = 5) {
  let v = 0,
    amp = 0.6,
    freq = 1,
    max = 0;
  for (let i = 0; i < octaves; i++) {
    v += perlin1(x * freq) * amp;
    max += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return v / max; // normalised [-1, 1]
}

// ─── Canvas ───────────────────────────────────────────────────────────────────
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

// ─── Constants ────────────────────────────────────────────────────────────────
const BUOYANCY = 0.012; // upward force per frame
const THRUST = 0.28; // thrust force per frame
const ROT_SPEED = 0.055; // radians per frame
const DRAG = 0.988; // velocity damping
const BATTERY_DRAIN = 0.007; // % per frame idle (base)
const THRUST_DRAIN = 0.038; // % per frame thrusting (base)
const VENT_CHARGE = 40; // battery restored per bio-node
const WALL_MARGIN = 38; // min clear pixels from each wall
const TRENCH_BASE = 220; // half-width at surface (px)
const TRENCH_NARROW = 60; // minimum half-width at depth (px)
const VENT_INTERVAL_BASE = 380; // world-Y gap between nodes at surface
const VENT_RADIUS = 14; // collection radius (px)
const PROBE_SIZE = 9; // probe hitbox radius (px)
const HULL_MAX = 100; // max hull integrity
const HULL_DAMAGE_SCALE = 3; // damage = impactSpeed * this
const HULL_IMPACT_COOLDOWN = 700; // ms between hull damage events

// ─── State ────────────────────────────────────────────────────────────────────
let state = "title"; // "title" | "play" | "dead"

let probe,
  worldY = 0,
  battery = 100,
  hull = HULL_MAX,
  ventsFound = 0,
  particles = [],
  vents = [],
  lastTime;

let deathMessage = "";
let _lastImpactTime = 0;

// ─── Canyon geometry ──────────────────────────────────────────────────────────

// Vent spacing grows with depth: ~380 m near surface, ~1600 m at 3000 m
function ventInterval(wy) {
  return VENT_INTERVAL_BASE + wy * 0.42;
}

function trenchHalfWidth(wy) {
  const depth = wy / 100;
  const base = TRENCH_BASE * Math.max(0.3, 1 - depth * 0.004);
  return Math.max(TRENCH_NARROW, base);
}

// Meandering centerline: two overlaid Perlin frequencies, amplitude grows with depth
function trenchCenterX(wy) {
  const amp = Math.min(200, 10 + wy * 0.065);
  const slow = perlin1(wy * 0.00028) * amp;
  const mid = perlin1((wy + 7300) * 0.0009) * amp * 0.45;
  return W / 2 + slow + mid;
}

function wallLeft(wy) {
  const cx = trenchCenterX(wy);
  const roughness = fbm((wy + 9000) * 0.0025) * 30;
  return cx - trenchHalfWidth(wy) + roughness;
}

function wallRight(wy) {
  const cx = trenchCenterX(wy);
  const roughness = fbm(wy * 0.0025) * 30;
  return cx + trenchHalfWidth(wy) + roughness;
}

// ─── Bio-node builder ─────────────────────────────────────────────────────────
function buildVent(wy) {
  const cx = trenchCenterX(wy);
  const hw = trenchHalfWidth(wy);
  const wallL = cx - hw + WALL_MARGIN + VENT_RADIUS + 4;
  const wallR = cx + hw - WALL_MARGIN - VENT_RADIUS - 4;
  const x = wallL + Math.random() * (wallR - wallL);

  const armCount = 5 + Math.floor(Math.random() * 4);
  const arms = Array.from({ length: armCount }, () => ({
    a: Math.random() * Math.PI * 2,
    len: VENT_RADIUS * (0.9 + Math.random() * 1.1),
    curve: (Math.random() - 0.5) * 0.9,
  }));

  return { wy, x, charge: VENT_CHARGE, collected: false, arms };
}

// ─── Audio Engine (Web Audio API — no files, all synthesised) ─────────────────

let _ac = null;
function getAC() {
  if (!_ac) _ac = new (window.AudioContext || window.webkitAudioContext)();
  return _ac;
}

// Shared pink-ish noise buffer reused by ambient + thruster
let _noiseBuf = null;
function getNoiseBuf() {
  if (_noiseBuf) return _noiseBuf;
  const ac = getAC();
  const len = ac.sampleRate * 2;
  _noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
  const d = _noiseBuf.getChannelData(0);
  let b0 = 0,
    b1 = 0,
    b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    d[i] = (b0 + b1 + b2 + w * 0.0782232) * 0.11;
  }
  return _noiseBuf;
}

// Ambient ocean drone — four layered sources
let _ambientGain = null;
function initAmbientSound() {
  const ac = getAC();
  if (_ambientGain) return;

  _ambientGain = ac.createGain();
  _ambientGain.gain.value = 0;
  _ambientGain.connect(ac.destination);

  // Layer 1: deep filtered noise rumble
  const ns = ac.createBufferSource();
  ns.buffer = getNoiseBuf();
  ns.loop = true;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 160;
  lp.Q.value = 0.6;
  const ng = ac.createGain();
  ng.gain.value = 0.55;
  ns.connect(lp);
  lp.connect(ng);
  ng.connect(_ambientGain);
  ns.start();

  // Layer 2: sub-bass throb (32 Hz, LFO tremolo at 0.07 Hz)
  const sub = ac.createOscillator();
  sub.type = "sine";
  sub.frequency.value = 32;
  const subG = ac.createGain();
  subG.gain.value = 0.35;
  const lfo1 = ac.createOscillator();
  lfo1.type = "sine";
  lfo1.frequency.value = 0.07;
  const lfoG1 = ac.createGain();
  lfoG1.gain.value = 0.18;
  lfo1.connect(lfoG1);
  lfoG1.connect(subG.gain);
  sub.connect(subG);
  subG.connect(_ambientGain);
  sub.start();
  lfo1.start();

  // Layer 3: mid shimmer (220 Hz, LFO tremolo at 0.13 Hz, very quiet)
  const mid = ac.createOscillator();
  mid.type = "sine";
  mid.frequency.value = 220;
  const midG = ac.createGain();
  midG.gain.value = 0.04;
  const lfo2 = ac.createOscillator();
  lfo2.type = "sine";
  lfo2.frequency.value = 0.13;
  const lfoG2 = ac.createGain();
  lfoG2.gain.value = 0.03;
  lfo2.connect(lfoG2);
  lfoG2.connect(midG.gain);
  mid.connect(midG);
  midG.connect(_ambientGain);
  mid.start();
  lfo2.start();

  // Layer 4: random structural creak every 5–12 s
  function scheduleCreak() {
    if (!_ambientGain) return;
    setTimeout(
      () => {
        if (state !== "play") {
          scheduleCreak();
          return;
        }
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.type = "triangle";
        o.frequency.setValueAtTime(55 + Math.random() * 30, ac.currentTime);
        o.frequency.exponentialRampToValueAtTime(28, ac.currentTime + 0.18);
        g.gain.setValueAtTime(0, ac.currentTime);
        g.gain.linearRampToValueAtTime(0.1, ac.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.22);
        o.connect(g);
        g.connect(_ambientGain);
        o.start();
        o.stop(ac.currentTime + 0.25);
        scheduleCreak();
      },
      5000 + Math.random() * 7000,
    );
  }
  scheduleCreak();
}

function setAmbient(on) {
  if (!_ambientGain) return;
  const ac = getAC();
  _ambientGain.gain.cancelScheduledValues(ac.currentTime);
  _ambientGain.gain.setTargetAtTime(
    on ? 0.38 : 0,
    ac.currentTime,
    on ? 1.5 : 1.0,
  );
}

function updateAmbientDepth(wy) {
  if (!_ambientGain) return;
  const extra = Math.min(0.18, wy / 8000);
  _ambientGain.gain.setTargetAtTime(0.38 + extra, getAC().currentTime, 4.0);
}

// Thruster: bandpass noise rumble + pitched impeller sawtooth with spin-up/down
let _thrusterMaster = null,
  _thrusterOsc = null;
let _thrusterOn = false;

function initThrusterSound() {
  const ac = getAC();
  if (_thrusterMaster) return;

  _thrusterMaster = ac.createGain();
  _thrusterMaster.gain.value = 0;
  _thrusterMaster.connect(ac.destination);

  // Noise rumble layer
  const ns = ac.createBufferSource();
  ns.buffer = getNoiseBuf();
  ns.loop = true;
  const bp = ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 110;
  bp.Q.value = 1.1;
  const ng = ac.createGain();
  ng.gain.value = 0.65;
  ns.connect(bp);
  bp.connect(ng);
  ng.connect(_thrusterMaster);
  ns.start();

  // Impeller whine layer
  _thrusterOsc = ac.createOscillator();
  _thrusterOsc.type = "sawtooth";
  _thrusterOsc.frequency.value = 68;
  const shaper = ac.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i * 2) / 256 - 1;
    curve[i] = ((Math.PI + 80) * x) / (Math.PI + 80 * Math.abs(x));
  }
  shaper.curve = curve;
  const oscLp = ac.createBiquadFilter();
  oscLp.type = "lowpass";
  oscLp.frequency.value = 320;
  const oscG = ac.createGain();
  oscG.gain.value = 0.28;
  _thrusterOsc.connect(shaper);
  shaper.connect(oscLp);
  oscLp.connect(oscG);
  oscG.connect(_thrusterMaster);
  _thrusterOsc.start();
}

function setThruster(on) {
  if (!_thrusterMaster || on === _thrusterOn) return;
  _thrusterOn = on;
  const ac = getAC();
  const t = ac.currentTime;
  _thrusterMaster.gain.cancelScheduledValues(t);
  _thrusterOsc.frequency.cancelScheduledValues(t);
  _thrusterOsc.frequency.setValueAtTime(_thrusterOsc.frequency.value, t);
  if (on) {
    _thrusterMaster.gain.setTargetAtTime(0.3, t, 0.05);
    _thrusterOsc.frequency.linearRampToValueAtTime(95, t + 0.35);
  } else {
    _thrusterMaster.gain.setTargetAtTime(0, t, 0.18);
    _thrusterOsc.frequency.linearRampToValueAtTime(58, t + 0.55);
  }
}

// One-shot sound effects
function playSound(type) {
  const ac = getAC();

  if (type === "collect") {
    // Ethereal rising chime
    [320, 540, 820].forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(
        freq * 1.7,
        ac.currentTime + 0.4,
      );
      gain.gain.setValueAtTime(0, ac.currentTime);
      gain.gain.linearRampToValueAtTime(
        0.16 - i * 0.04,
        ac.currentTime + 0.04 + i * 0.06,
      );
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        ac.currentTime + 0.8 + i * 0.15,
      );
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(ac.currentTime + i * 0.06);
      osc.stop(ac.currentTime + 1.1);
    });
  }

  if (type === "death") {
    // Descending sawtooth thud
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(130, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(16, ac.currentTime + 0.7);
    gain.gain.setValueAtTime(0.5, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.75);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.8);

    // High-pass crunch burst
    const bufLen = Math.floor(ac.sampleRate * 0.3);
    const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
    const crunch = ac.createBufferSource();
    crunch.buffer = buf;
    const hp = ac.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 600;
    const cg = ac.createGain();
    cg.gain.setValueAtTime(0.28, ac.currentTime);
    cg.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.3);
    crunch.connect(hp);
    hp.connect(cg);
    cg.connect(ac.destination);
    crunch.start();
  }

  if (type === "lowbat") {
    // Double sonar ping
    [0, 0.22].forEach((delay) => {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = 1040;
      g.gain.setValueAtTime(0, ac.currentTime + delay);
      g.gain.linearRampToValueAtTime(0.13, ac.currentTime + delay + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + delay + 0.14);
      osc.connect(g);
      g.connect(ac.destination);
      osc.start(ac.currentTime + delay);
      osc.stop(ac.currentTime + delay + 0.16);
    });
  }

  if (type === "impact") {
    // Metallic hull thud: low triangle thump + brief noise crack
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(90, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(30, ac.currentTime + 0.12);
    g.gain.setValueAtTime(0.45, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.14);
    osc.connect(g);
    g.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.15);
    // Crack layer
    const bufLen = Math.floor(ac.sampleRate * 0.06);
    const buf = ac.createBuffer(1, bufLen, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const hp = ac.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 800;
    const cg = ac.createGain();
    cg.gain.setValueAtTime(0.2, ac.currentTime);
    cg.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.07);
    src.connect(hp);
    hp.connect(cg);
    cg.connect(ac.destination);
    src.start();
  }
}

let _lastLowBatPing = 0;

// ─── Game init ────────────────────────────────────────────────────────────────
function initGame() {
  probe = { x: W / 2, y: H / 2, vx: 0, vy: 0, angle: Math.PI * 0.5 };
  worldY = 0;
  battery = 100;
  hull = HULL_MAX;
  ventsFound = 0;
  particles = [];

  vents = [];
  let seedWY = 0;
  for (let i = 0; i < 6; i++) {
    seedWY += ventInterval(seedWY) * (0.85 + Math.random() * 0.3);
    vents.push(buildVent(seedWY));
  }

  lastTime = null;
  state = "play";
  document.getElementById("overlay").style.display = "none";

  initAmbientSound();
  setAmbient(true);
  initThrusterSound();
  setThruster(false);
}

// ─── Input ────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (state === "title" || state === "dead") initGame();
});
window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});
canvas.addEventListener("click", () => {
  if (state === "title" || state === "dead") initGame();
});

let touchLeft = false,
  touchRight = false,
  touchThrust = false;
canvas.addEventListener(
  "touchstart",
  (e) => {
    e.preventDefault();
    Array.from(e.touches).forEach((t) => {
      const rx = t.clientX / canvas.offsetWidth;
      if (rx < 0.33) touchLeft = true;
      else if (rx > 0.66) touchRight = true;
      else touchThrust = true;
    });
    if (state !== "play") initGame();
  },
  { passive: false },
);
canvas.addEventListener(
  "touchend",
  () => {
    touchLeft = touchRight = touchThrust = false;
  },
  { passive: false },
);

const inputLeft = () => keys["KeyA"] || keys["ArrowLeft"] || touchLeft;
const inputRight = () => keys["KeyD"] || keys["ArrowRight"] || touchRight;
const inputThrust = () => keys["KeyW"] || keys["ArrowUp"] || touchThrust;
const inputBrake = () => keys["Space"];

// ─── Particles ────────────────────────────────────────────────────────────────
function spawnThrusterParticles() {
  const back = probe.angle + Math.PI;
  for (let i = 0; i < 3; i++) {
    const spread = (Math.random() - 0.5) * 0.5;
    const speed = 1.2 + Math.random() * 1.4;
    particles.push({
      x: probe.x + Math.cos(back + spread) * PROBE_SIZE,
      y: probe.y + Math.sin(back + spread) * PROBE_SIZE,
      vx: Math.cos(back + spread) * speed + probe.vx * 0.3,
      vy: Math.sin(back + spread) * speed + probe.vy * 0.3,
      life: 1.0,
      decay: 0.04 + Math.random() * 0.04,
    });
  }
}

function spawnVentParticles(vent) {
  const svy = vent.wy - worldY + H * 0.5;
  for (let i = 0; i < 28; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 0.5 + Math.random() * 2.5;
    const cyan = Math.random() > 0.45;
    particles.push({
      x: vent.x + (Math.random() - 0.5) * VENT_RADIUS,
      y: svy + (Math.random() - 0.5) * VENT_RADIUS,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 1.0,
      decay: 0.018 + Math.random() * 0.022,
      vent: true,
      cyan,
    });
  }
}

// ─── Collision ────────────────────────────────────────────────────────────────
function spawnImpactParticles(cx, cy) {
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 0.8 + Math.random() * 2.2;
    particles.push({
      x: cx + (Math.random() - 0.5) * 6,
      y: cy + (Math.random() - 0.5) * 6,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 1.0,
      decay: 0.04 + Math.random() * 0.05,
      impact: true,
    });
  }
}

// Returns true if the probe is currently inside a wall
function isInsideWall() {
  const wy = worldY + (probe.y - H * 0.5);
  return (
    probe.x - PROBE_SIZE < wallLeft(wy) || probe.x + PROBE_SIZE > wallRight(wy)
  );
}

// Resolves wall collision: bounces probe, applies hull damage scaled to impact speed
function handleWallCollision() {
  const wy = worldY + (probe.y - H * 0.5);
  const lx = wallLeft(wy);
  const rx = wallRight(wy);
  const hitLeft = probe.x - PROBE_SIZE < lx;
  const hitRight = probe.x + PROBE_SIZE > rx;
  if (!hitLeft && !hitRight) return;

  const impactSpd = Math.hypot(probe.vx, probe.vy);

  // Cooldown: one damage event per collision, not per frame
  const now = Date.now();
  if (now - _lastImpactTime > HULL_IMPACT_COOLDOWN) {
    _lastImpactTime = now;
    const damage = Math.max(1, impactSpd * HULL_DAMAGE_SCALE);
    hull = Math.max(0, hull - damage);
    playSound("impact");
    const cx = hitLeft ? lx + PROBE_SIZE : rx - PROBE_SIZE;
    spawnImpactParticles(cx, probe.y);
  }

  // Push probe back inside the wall and reflect horizontal velocity
  if (hitLeft) {
    probe.x = lx + PROBE_SIZE + 1;
    probe.vx = Math.abs(probe.vx) * 0.4;
  }
  if (hitRight) {
    probe.x = rx - PROBE_SIZE - 1;
    probe.vx = -Math.abs(probe.vx) * 0.4;
  }
  // Bleed some vertical speed from the glancing collision
  probe.vy *= 0.72;

  if (hull <= 0) {
    triggerDeath("HULL BREACH — CRUSHED BY CANYON WALL");
  }
}

// ─── Update ───────────────────────────────────────────────────────────────────
function update(dt) {
  if (state !== "play") return;
  dt = Math.min(dt, 50); // guard against tab-refocus spiral

  if (inputLeft()) probe.angle -= ROT_SPEED;
  if (inputRight()) probe.angle += ROT_SPEED;

  const thrusting = inputThrust();
  const braking = inputBrake();
  const depthScale = 1 + (worldY / 500) * 0.01; // drain scales with depth

  if (thrusting) {
    probe.vx += Math.cos(probe.angle) * THRUST;
    probe.vy += Math.sin(probe.angle) * THRUST;
    spawnThrusterParticles();
    battery -= THRUST_DRAIN * depthScale;
  } else {
    battery -= BATTERY_DRAIN * depthScale;
  }
  setThruster(thrusting);

  if (braking) {
    probe.vx *= 0.88;
    probe.vy *= 0.88;
  }

  probe.vy -= BUOYANCY * (dt / 16); // buoyancy pushes upward
  probe.vx *= DRAG;
  probe.vy *= DRAG;

  probe.x += probe.vx;
  probe.y += probe.vy;

  // Keep probe vertically centred — scroll the world instead
  const drift = probe.y - H * 0.5;
  worldY += drift * 0.08;
  probe.y -= drift * 0.08;

  probe.x = Math.max(PROBE_SIZE, Math.min(W - PROBE_SIZE, probe.x));

  handleWallCollision();
  if (state !== "play") return; // hull may have triggered death

  battery = Math.max(0, battery);
  if (battery <= 0) {
    triggerDeath("BATTERY DEPLETED — DRONE LOST TO THE ABYSS");
    return;
  }

  // Low-battery warning ping
  if (battery < 20) {
    const now = Date.now();
    if (now - _lastLowBatPing > 3000) {
      _lastLowBatPing = now;
      playSound("lowbat");
    }
  }

  // Ambient depth modulation (throttled)
  if (Math.round(worldY) % 60 === 0) updateAmbientDepth(worldY);

  // Update particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    if (p.vent) p.vy -= 0.05; // bio-sparks drift upward
    if (p.life <= 0) particles.splice(i, 1);
  }

  // Bio-node collection
  for (const vent of vents) {
    if (vent.collected) continue;
    const svy = vent.wy - worldY + H * 0.5;
    const dx = probe.x - vent.x;
    const dy = probe.y - svy;
    if (Math.sqrt(dx * dx + dy * dy) < VENT_RADIUS + PROBE_SIZE) {
      vent.collected = true;
      ventsFound++;
      battery = Math.min(100, battery + vent.charge);
      spawnVentParticles(vent);
      playSound("collect");
    }
  }

  // Spawn more nodes ahead
  const lastVentWY = vents.length ? vents[vents.length - 1].wy : 0;
  const nextInterval = ventInterval(lastVentWY);
  if (lastVentWY < worldY + H + nextInterval * 2) {
    vents.push(
      buildVent(lastVentWY + nextInterval * (0.75 + Math.random() * 0.5)),
    );
  }
}

// ─── Death ────────────────────────────────────────────────────────────────────
function triggerDeath(msg) {
  deathMessage = msg;
  state = "dead";
  setThruster(false);
  setAmbient(false);
  playSound("death");
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function drawBackground() {
  const d = Math.min(1, worldY / 3000);
  const r = 0;
  const g = Math.round(8 + d * 2);
  const b = Math.round(20 + d * 10);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, `rgb(${r},${g},${b + 6})`);
  grad.addColorStop(1, `rgb(${r},${g},${b})`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function drawWalls() {
  const steps = 4;
  ctx.save();

  const lxMid = wallLeft(worldY);
  const rxMid = wallRight(worldY);

  // Left wall fill
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let sy = 0; sy <= H; sy += steps)
    ctx.lineTo(wallLeft(worldY + (sy - H * 0.5)), sy);
  ctx.lineTo(0, H);
  ctx.closePath();
  const leftGrad = ctx.createLinearGradient(lxMid, 0, 0, 0);
  leftGrad.addColorStop(0, "#0a2030");
  leftGrad.addColorStop(0.3, "#05101c");
  leftGrad.addColorStop(1, "#02080f");
  ctx.fillStyle = leftGrad;
  ctx.fill();

  // Left wall edge highlight
  ctx.beginPath();
  for (let sy = 0; sy <= H; sy += steps) {
    const lx = wallLeft(worldY + (sy - H * 0.5));
    sy === 0 ? ctx.moveTo(lx, sy) : ctx.lineTo(lx, sy);
  }
  ctx.strokeStyle = "#38bdf828";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Right wall fill
  ctx.beginPath();
  ctx.moveTo(W, 0);
  for (let sy = 0; sy <= H; sy += steps)
    ctx.lineTo(wallRight(worldY + (sy - H * 0.5)), sy);
  ctx.lineTo(W, H);
  ctx.closePath();
  const rightGrad = ctx.createLinearGradient(rxMid, 0, W, 0);
  rightGrad.addColorStop(0, "#0a2030");
  rightGrad.addColorStop(0.3, "#05101c");
  rightGrad.addColorStop(1, "#02080f");
  ctx.fillStyle = rightGrad;
  ctx.fill();

  // Right wall edge highlight
  ctx.beginPath();
  for (let sy = 0; sy <= H; sy += steps) {
    const rx = wallRight(worldY + (sy - H * 0.5));
    sy === 0 ? ctx.moveTo(rx, sy) : ctx.lineTo(rx, sy);
  }
  ctx.strokeStyle = "#38bdf828";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

function drawDepthMarkers() {
  const interval = 200;
  const firstMarker = Math.ceil((worldY - H * 0.5) / interval) * interval;
  ctx.save();
  ctx.font = '10px "Share Tech Mono", monospace';
  ctx.fillStyle = "#0e3a52";
  ctx.textAlign = "center";
  for (let wy = firstMarker; wy < worldY + H * 0.5 + interval; wy += interval) {
    const sy = wy - worldY + H * 0.5;
    if (sy < 0 || sy > H) continue;
    ctx.strokeStyle = "#07192a";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 12]);
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(W, sy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(`─── ${Math.round(wy)} m ───`, W / 2, sy - 3);
  }
  ctx.restore();
}

function drawVents() {
  const t = Date.now() / 1000;
  for (const vent of vents) {
    if (vent.collected) continue;
    const svy = vent.wy - worldY + H * 0.5;
    if (svy < -VENT_RADIUS * 4 || svy > H + VENT_RADIUS * 4) continue;

    ctx.save();
    const pulse = 0.55 + 0.45 * Math.sin(t * 1.8);

    // Ambient halo
    const haloR = VENT_RADIUS * (2.8 + 0.6 * pulse);
    const halo = ctx.createRadialGradient(vent.x, svy, 0, vent.x, svy, haloR);
    halo.addColorStop(0, `rgba(100,220,255,${0.18 * pulse})`);
    halo.addColorStop(0.5, `rgba(140,80,255,${0.1 * pulse})`);
    halo.addColorStop(1, "transparent");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(vent.x, svy, haloR, 0, Math.PI * 2);
    ctx.fill();

    // Tendrils
    for (let i = 0; i < vent.arms.length; i++) {
      const arm = vent.arms[i];
      const sway = arm.curve * Math.sin(t * 1.1 + i * 0.9);
      const tipA = arm.a + sway;
      const tipX = vent.x + Math.cos(tipA) * arm.len;
      const tipY = svy + Math.sin(tipA) * arm.len;
      const midA = arm.a + sway * 0.5;
      const cpx = vent.x + Math.cos(midA) * arm.len * 0.55;
      const cpy = svy + Math.sin(midA) * arm.len * 0.55;
      const bright = 0.6 + 0.4 * Math.sin(t * 2.2 + i * 1.3);

      ctx.beginPath();
      ctx.moveTo(vent.x, svy);
      ctx.quadraticCurveTo(cpx, cpy, tipX, tipY);
      ctx.strokeStyle = `rgba(${Math.round(60 + 80 * bright)},${Math.round(180 + 60 * bright)},255,${0.55 + 0.35 * bright})`;
      ctx.lineWidth = 1.5 - i * 0.06;
      ctx.shadowColor = "#88ccff";
      ctx.shadowBlur = 4;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(tipX, tipY, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200,240,255,${0.7 * bright})`;
      ctx.shadowBlur = 6;
      ctx.fill();
    }

    // Core nucleus
    const coreR = VENT_RADIUS * 0.42 * (0.88 + 0.12 * pulse);
    const core = ctx.createRadialGradient(
      vent.x,
      svy,
      0,
      vent.x,
      svy,
      coreR * 2.2,
    );
    core.addColorStop(0, "rgba(220,250,255,0.95)");
    core.addColorStop(0.3, `rgba(80,200,255,${0.75 * pulse})`);
    core.addColorStop(0.7, `rgba(120,60,255,${0.45 * pulse})`);
    core.addColorStop(1, "transparent");
    ctx.beginPath();
    ctx.arc(vent.x, svy, coreR * 2.2, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.shadowColor = "#aaddff";
    ctx.shadowBlur = 10;
    ctx.fill();

    ctx.restore();
  }
}

function drawParticles() {
  ctx.save();
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life);
    if (p.vent) {
      const h = p.cyan ? 190 + p.life * 20 : 270 + p.life * 30;
      ctx.fillStyle = `hsl(${h}, 100%, ${70 + p.life * 20}%)`;
    } else if (p.impact) {
      const bright = 55 + p.life * 30;
      ctx.fillStyle = `hsl(${20 + p.life * 10}, 100%, ${bright}%)`;
    } else {
      ctx.fillStyle = `hsl(${200 + p.life * 15}, 90%, ${55 + p.life * 20}%)`;
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.vent ? 3 : 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawProbe() {
  ctx.save();
  ctx.translate(probe.x, probe.y);
  ctx.rotate(probe.angle);

  // Thruster glow
  if (inputThrust()) {
    ctx.save();
    const tg = ctx.createRadialGradient(
      -PROBE_SIZE * 1.4,
      0,
      0,
      -PROBE_SIZE * 1.4,
      0,
      PROBE_SIZE * 2,
    );
    tg.addColorStop(0, "rgba(56,189,248,0.55)");
    tg.addColorStop(1, "transparent");
    ctx.fillStyle = tg;
    ctx.beginPath();
    ctx.arc(-PROBE_SIZE * 1.4, 0, PROBE_SIZE * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Body — tint red/orange as hull drops
  const hullRatio = hull / HULL_MAX;
  const bodyFill =
    hullRatio > 0.5
      ? "#04111d"
      : `rgb(${Math.round(20 + (1 - hullRatio) * 60)},${Math.round(10 + hullRatio * 8)},${Math.round(20 * hullRatio)})`;
  const probeGlow =
    hullRatio > 0.5
      ? "#38bdf8"
      : `hsl(${Math.round(hullRatio * 200)},100%,60%)`;
  ctx.strokeStyle = probeGlow;
  ctx.lineWidth = 1.5;
  ctx.fillStyle = bodyFill;
  ctx.shadowColor = probeGlow;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(PROBE_SIZE, 0);
  ctx.lineTo(PROBE_SIZE * 0.3, -PROBE_SIZE * 0.55);
  ctx.lineTo(-PROBE_SIZE, -PROBE_SIZE * 0.4);
  ctx.lineTo(-PROBE_SIZE * 1.3, 0);
  ctx.lineTo(-PROBE_SIZE, PROBE_SIZE * 0.4);
  ctx.lineTo(PROBE_SIZE * 0.3, PROBE_SIZE * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Fins
  ctx.fillStyle = "#0a2035";
  [[-1], [1]].forEach(([sign]) => {
    ctx.beginPath();
    ctx.moveTo(-PROBE_SIZE * 0.4, sign * PROBE_SIZE * 0.5);
    ctx.lineTo(-PROBE_SIZE * 0.8, sign * PROBE_SIZE * 1.1);
    ctx.lineTo(-PROBE_SIZE * 1.0, sign * PROBE_SIZE * 0.4);
    ctx.fill();
    ctx.stroke();
  });

  // Cockpit dot
  ctx.beginPath();
  ctx.arc(PROBE_SIZE * 0.1, 0, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "#bae6fd";
  ctx.shadowBlur = 0;
  ctx.fill();

  ctx.restore();
}

function drawBatteryBar() {
  const bw = 120,
    bh = 8;
  const bx = W - bw - 10;
  const by = H - bh - 8;

  ctx.save();
  ctx.fillStyle = "#04111d";
  ctx.strokeStyle = "#38bdf833";
  ctx.lineWidth = 1;
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeRect(bx, by, bw, bh);

  const hue = battery > 30 ? 200 : battery > 15 ? 40 : 0;
  ctx.fillStyle = `hsl(${hue}, 100%, 45%)`;
  ctx.fillRect(bx, by, (battery / 100) * bw, bh);

  ctx.fillStyle = "#1e6a8a";
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.textAlign = "right";
  ctx.fillText("PWR", bx - 4, by + bh - 1);
  ctx.restore();
}

function drawHullBar() {
  const bw = 120,
    bh = 8;
  const bx = 10;
  const by = H - bh - 8;

  ctx.save();
  ctx.fillStyle = "#04111d";
  ctx.strokeStyle = "#38bdf833";
  ctx.lineWidth = 1;
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeRect(bx, by, bw, bh);

  const ratio = hull / HULL_MAX;
  const hullHue = ratio > 0.5 ? 120 : ratio > 0.25 ? 40 : 0;
  ctx.fillStyle = `hsl(${hullHue}, 100%, 42%)`;
  ctx.fillRect(bx, by, ratio * bw, bh);

  ctx.fillStyle = "#1e6a8a";
  ctx.font = '9px "Share Tech Mono", monospace';
  ctx.textAlign = "left";
  ctx.fillText("HULL", bx + bw + 4, by + bh - 1);
  ctx.restore();
}

function drawHUD() {
  document.getElementById("h-depth").textContent = Math.round(worldY);
  document.getElementById("h-battery").textContent = battery.toFixed(1);
  document.getElementById("h-hull").textContent = Math.ceil(hull);
  document.getElementById("h-vents").textContent = ventsFound;
  const spd = Math.sqrt(probe.vx ** 2 + probe.vy ** 2);
  document.getElementById("h-speed").textContent = spd.toFixed(2);
}

function drawDeadOverlay() {
  ctx.save();
  ctx.fillStyle = "rgba(1,6,14,0.88)";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";

  ctx.font = 'bold 26px "Share Tech Mono", monospace';
  ctx.fillStyle = "#ff4422";
  ctx.shadowColor = "#ff4422";
  ctx.shadowBlur = 16;
  ctx.fillText("── SIGNAL LOST ──", W / 2, H / 2 - 70);

  ctx.font = '13px "Share Tech Mono", monospace';
  ctx.fillStyle = "#ff8855";
  ctx.shadowColor = "#ff8855";
  ctx.fillText(deathMessage, W / 2, H / 2 - 36);

  ctx.fillStyle = "#38bdf8";
  ctx.shadowColor = "#38bdf8";
  ctx.fillText(`FINAL DEPTH  : ${Math.round(worldY)} m`, W / 2, H / 2 + 4);
  ctx.fillText(`NODES FOUND  : ${ventsFound}`, W / 2, H / 2 + 24);
  ctx.fillText(`BATTERY LEFT : ${battery.toFixed(1)}%`, W / 2, H / 2 + 44);
  ctx.fillText(`HULL LEFT    : ${Math.ceil(hull)}%`, W / 2, H / 2 + 64);

  if (Math.floor(Date.now() / 600) % 2 === 0) {
    ctx.font = '14px "Share Tech Mono", monospace';
    ctx.fillStyle = "#7dd3fc";
    ctx.shadowColor = "#7dd3fc";
    ctx.fillText("[ PRESS ANY KEY TO REDEPLOY ]", W / 2, H / 2 + 86);
  }
  ctx.restore();
}

// ─── Main loop ────────────────────────────────────────────────────────────────
function loop(ts) {
  const dt = lastTime ? ts - lastTime : 16;
  lastTime = ts;

  update(dt);

  drawBackground();
  drawDepthMarkers();
  drawWalls();
  drawVents();
  drawParticles();

  if (state === "play" || state === "dead") {
    drawProbe();
    drawBatteryBar();
    drawHullBar();
    drawHUD();
  }

  if (state === "dead") drawDeadOverlay();

  requestAnimationFrame(loop);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
lastTime = null;
requestAnimationFrame(loop);
