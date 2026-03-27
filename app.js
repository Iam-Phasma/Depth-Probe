'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// 1. PERLIN NOISE (1D + fBm)
// ─────────────────────────────────────────────────────────────────────────────

class Perlin {
  constructor (seed = 0) {
    // Xorshift32 seeded RNG
    let s = (seed | 0) || 1;
    const rng = () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.p = new Uint8Array([...p, ...p]);
  }

  /** Smootherstep fade */
  _fade (t) { return t * t * t * (t * (t * 6 - 15) + 10); }

  /** 1-D gradient: odd hash → positive slope, even → negative */
  _grad (h, x) { return (h & 1) ? x : -x; }

  /** Single-octave noise in roughly [-0.5, 0.5] */
  noise (x) {
    const X = Math.floor(x) & 255;
    const f = x - Math.floor(x);
    const u = this._fade(f);
    return this._lerp(this._grad(this.p[X], f), this._grad(this.p[X + 1], f - 1), u);
  }

  _lerp (a, b, t) { return a + t * (b - a); }

  /** Fractal Brownian Motion: sum of octaves */
  fbm (x, octaves = 5, lacunarity = 2, gain = 0.5) {
    let v = 0, amp = 1, freq = 1, maxAmp = 0;
    for (let i = 0; i < octaves; i++) {
      v      += this.noise(x * freq) * amp;
      maxAmp += amp;
      amp    *= gain;
      freq   *= lacunarity;
    }
    return v / maxAmp;   // normalized to [-1, 1]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. CANVAS & NOISE INSTANCES
// ─────────────────────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
const CW     = canvas.width;   // 480
const CH     = canvas.height;  // 720

// Independent noise seeds for left wall, right wall, vent placement
const NL = new Perlin(1337);
const NR = new Perlin(7331);
const NV = new Perlin(5050);

// ─────────────────────────────────────────────────────────────────────────────
// 3. TUNING CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const BUOYANCY    = 80;    // upward acceleration      (px / s²)
const THRUST      = 260;   // forward acceleration     (px / s²)
const DRAG        = 2.4;   // linear drag coefficient
const ROT_SPD     = 3.2;   // rotation speed           (rad / s)
const BATT_IDLE   = 1.8;   // battery drain idle       (% / s)
const BATT_THRUST = 4.0;   // extra drain while thrust (% / s)
const VENT_CHARGE = 65;    // recharge rate at vent    (% / s)
const VENT_GAP    = 680;   // world-units between vents
const DRONE_R     = 14;    // drone collision radius   (px)

// ─────────────────────────────────────────────────────────────────────────────
// 4. GAME STATE
// ─────────────────────────────────────────────────────────────────────────────

let scene = 'title';   // 'title' | 'play' | 'over'
let drone, cam, vents, sparks;

// ─────────────────────────────────────────────────────────────────────────────
// 5. INITIALISE A NEW DIVE
// ─────────────────────────────────────────────────────────────────────────────

function init () {
  drone = {
    x: CW / 2, y: 80,
    vx: 0, vy: 0,
    angle: Math.PI / 2,    // nose pointing downward (positive-y axis in canvas)
    battery: 100,
    depth: 80, best: 0,
    thrusting: false, onVent: false,
  };
  cam    = { y: 0 };
  sparks = [];

  // Pre-generate thermal vents for a very deep dive
  vents = [];
  for (let d = VENT_GAP; d < 80000; d += VENT_GAP) {
    const x = CW / 2 + NV.fbm(d / 500, 3) * 90;
    vents.push({ wy: d, x, phase: Math.random() * Math.PI * 2 });
  }

  scene = 'play';
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. CANYON PROFILE  (world-y → {lx, rx})
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the x-coordinates of the left and right canyon walls at world depth wy.
 * The corridor narrows gradually with depth; Perlin noise shapes both sides
 * independently, producing an organic-looking trench.
 */
function canyonWalls (wy) {
  const halfW = Math.max(75, 185 - wy / 160);  // narrows with depth
  const amp   = halfW * 0.6;
  const scale = 310;
  const lx = CW / 2 - halfW + NL.fbm(wy / scale, 5) * amp;
  const rx = CW / 2 + halfW + NR.fbm(wy / scale, 5) * amp;
  return { lx, rx };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. INPUT
// ─────────────────────────────────────────────────────────────────────────────

const keys = {};

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (scene === 'title') { init(); return; }
  if (scene === 'over' && e.code === 'KeyR') { init(); }
});
addEventListener('keyup', e => { keys[e.code] = false; });

// Touch zones — left 35 % of canvas rotates left, right 35 % rotates right,
// bottom 35 % applies thrust.  Remaining central area does nothing.
let tL = false, tR = false, tT = false;

canvas.addEventListener('touchstart',  onTouch, { passive: false });
canvas.addEventListener('touchmove',   onTouch, { passive: false });
canvas.addEventListener('touchend',    onTouchEnd, { passive: false });
canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

function onTouch (e) {
  e.preventDefault();
  if (scene !== 'play') { init(); return; }
  tL = tR = tT = false;
  const rect = canvas.getBoundingClientRect();
  const sx   = CW / rect.width;
  const sy   = CH / rect.height;
  for (const t of e.touches) {
    const tx = (t.clientX - rect.left) * sx;
    const ty = (t.clientY - rect.top)  * sy;
    if      (ty > CH * 0.65)   tT = true;
    else if (tx < CW * 0.35)   tL = true;
    else if (tx > CW * 0.65)   tR = true;
  }
}

function onTouchEnd (e) {
  if (e.touches.length === 0) { tL = tR = tT = false; }
  else onTouch(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. UPDATE
// ─────────────────────────────────────────────────────────────────────────────

function update (dt) {
  if (scene !== 'play') return;

  // ── Rotation
  if (keys['KeyA'] || keys['ArrowLeft']  || tL) drone.angle -= ROT_SPD * dt;
  if (keys['KeyD'] || keys['ArrowRight'] || tR) drone.angle += ROT_SPD * dt;

  // ── Thrust (forward burn in the direction the nose is pointing)
  const thrusting = (keys['KeyW'] || keys['ArrowUp'] || keys['Space'] || tT) && drone.battery > 0;
  drone.thrusting = thrusting;
  if (thrusting) {
    drone.vx += Math.cos(drone.angle) * THRUST * dt;
    drone.vy += Math.sin(drone.angle) * THRUST * dt;
    drone.battery -= BATT_THRUST * dt;
    if (Math.random() < 0.45) emitExhaust();
  }

  // ── Buoyancy — constant upward force (fighting gravity of water)
  drone.vy -= BUOYANCY * dt;

  // ── Linear drag (water resistance)
  drone.vx -= drone.vx * DRAG * dt;
  drone.vy -= drone.vy * DRAG * dt;

  // ── Integrate position
  drone.x += drone.vx * dt;
  drone.y += drone.vy * dt;

  // ── Surface ceiling
  if (drone.y < 20) { drone.y = 20; if (drone.vy < 0) drone.vy = 0; }

  // ── Smooth camera: keep drone at ~32 % from top of screen
  const targetCamY = drone.y - CH * 0.32;
  cam.y += (targetCamY - cam.y) * Math.min(1, 5 * dt);

  // ── Depth record
  drone.depth = drone.y;
  if (drone.depth > drone.best) drone.best = drone.depth;

  // ── Canyon wall collision
  const { lx, rx } = canyonWalls(drone.y);
  if (drone.x < lx + DRONE_R) {
    drone.x  = lx + DRONE_R;
    drone.vx =  Math.abs(drone.vx) * 0.3;
    drone.vy *= 0.85;
  }
  if (drone.x > rx - DRONE_R) {
    drone.x  = rx - DRONE_R;
    drone.vx = -Math.abs(drone.vx) * 0.3;
    drone.vy *= 0.85;
  }

  // ── Idle battery drain
  drone.battery = Math.max(0, drone.battery - BATT_IDLE * dt);

  // ── Thermal vent interaction
  drone.onVent = false;
  for (const v of vents) {
    if (Math.abs(v.wy - drone.y) > CH) continue;        // skip off-screen vents
    if (Math.hypot(drone.x - v.x, drone.y - v.wy) < DRONE_R + 22) {
      drone.battery = Math.min(100, drone.battery + VENT_CHARGE * dt);
      drone.onVent  = true;
      if (Math.random() < 0.35) emitVentSpark(v);
    }
  }

  // ── Advance sparks
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x    += s.vx * dt;
    s.y    += s.vy * dt;
    s.life -= s.decay * dt;
    if (s.life <= 0) sparks.splice(i, 1);
  }

  // ── Game over when battery is exhausted
  if (drone.battery <= 0) scene = 'over';
}

// ── Exhaust bubble emitted behind the drone during thrust
function emitExhaust () {
  const a  = drone.angle + Math.PI + (Math.random() - 0.5) * 0.55;
  const ox = Math.cos(drone.angle + Math.PI) * 15;
  const oy = Math.sin(drone.angle + Math.PI) * 15;
  const life = 0.25 + Math.random() * 0.2;
  sparks.push({
    x: drone.x + ox, y: drone.y + oy,
    vx: Math.cos(a) * (20 + Math.random() * 55),
    vy: Math.sin(a) * (20 + Math.random() * 55),
    r: 1.5 + Math.random() * 2.5,
    life, decay: 1 / life, type: 'ex',
  });
}

// ── Superheated water particle rising from a thermal vent
function emitVentSpark (v) {
  const life = 1 + Math.random() * 0.8;
  sparks.push({
    x: v.x + (Math.random() - 0.5) * 22, y: v.wy,
    vx: (Math.random() - 0.5) * 30,
    vy: -(50 + Math.random() * 90),
    r: 2.5 + Math.random() * 4,
    life, decay: 1 / life, type: 'vt',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. RENDER
// ─────────────────────────────────────────────────────────────────────────────

/** Convert world-y coordinate to screen-y */
const toSY = wy => wy - cam.y;

function render (now) {
  // Deep ocean background
  const bg = ctx.createLinearGradient(0, 0, 0, CH);
  bg.addColorStop(0, '#000d1a');
  bg.addColorStop(1, '#000408');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CW, CH);

  if (scene === 'title') { drawTitle(now); return; }

  drawWalls();
  drawSparks();
  drawVents(now);
  drawDrone(now);
  drawHUD(now);

  if (scene === 'over') drawGameOver();
}

// ─── Canyon walls ────────────────────────────────────────────────────────────

function drawWalls () {
  const steps = Math.ceil(CH / 6) + 3;
  const dy    = CH / (steps - 1);
  const Lpts  = [];
  const Rpts  = [];

  for (let i = 0; i < steps; i++) {
    const sy = i * dy;
    const { lx, rx } = canyonWalls(sy + cam.y);
    Lpts.push([lx, sy]);
    Rpts.push([rx, sy]);
  }

  // Left rock face
  ctx.beginPath();
  ctx.moveTo(0, 0);
  Lpts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(0, CH);
  ctx.closePath();
  const lg = ctx.createLinearGradient(0, 0, 160, 0);
  lg.addColorStop(0,    '#04101e');
  lg.addColorStop(0.65, '#08192c');
  lg.addColorStop(1,    '#12345a');
  ctx.fillStyle = lg;
  ctx.fill();

  // Left wall glow edge
  ctx.beginPath();
  Lpts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.strokeStyle = 'rgba(30,120,220,0.4)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Right rock face
  ctx.beginPath();
  ctx.moveTo(CW, 0);
  Rpts.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(CW, CH);
  ctx.closePath();
  const rg = ctx.createLinearGradient(CW, 0, CW - 160, 0);
  rg.addColorStop(0,    '#04101e');
  rg.addColorStop(0.65, '#08192c');
  rg.addColorStop(1,    '#12345a');
  ctx.fillStyle = rg;
  ctx.fill();

  // Right wall glow edge
  ctx.beginPath();
  Rpts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.strokeStyle = 'rgba(30,120,220,0.4)';
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}

// ─── Drone ───────────────────────────────────────────────────────────────────

function drawDrone (now) {
  const sx = drone.x;
  const sy = toSY(drone.y);
  const lowBatt = drone.battery < 20;

  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(drone.angle);

  // Dynamic glow
  ctx.shadowColor = drone.onVent  ? '#ffaa00'
                  : lowBatt       ? '#ff4400'
                  : '#00aaff';
  ctx.shadowBlur  = drone.thrusting ? 22 : 12;

  // Hull (ellipse body)
  ctx.beginPath();
  ctx.ellipse(0, 0, 15, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#0099cc';
  ctx.fill();

  // Nose cone
  ctx.beginPath();
  ctx.moveTo(11, 0);
  ctx.lineTo(19, 0);
  ctx.lineTo(11, -4);
  ctx.lineTo(11,  4);
  ctx.closePath();
  ctx.fillStyle = '#00ccff';
  ctx.fill();

  // Viewport window
  ctx.beginPath();
  ctx.arc(4, 0, 4, 0, Math.PI * 2);
  ctx.fillStyle = lowBatt
    ? `rgba(255,50,0,${0.6 + Math.sin(now / 200) * 0.4})`
    : '#00ffcc';
  ctx.fill();

  // Propeller ring (aft)
  ctx.beginPath();
  ctx.arc(-15, 0, 5, 0, Math.PI * 2);
  ctx.strokeStyle = '#005588';
  ctx.lineWidth   = 2;
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.restore();
}

// ─── Thermal vents ───────────────────────────────────────────────────────────

function drawVents (now) {
  for (const v of vents) {
    const sy = toSY(v.wy);
    if (sy < -50 || sy > CH + 50) continue;

    const pulse = Math.sin(now / 500 + v.phase) * 0.5 + 0.5;
    const outerR = 40 + pulse * 15;

    // Radial heat glow
    const g = ctx.createRadialGradient(v.x, sy, 0, v.x, sy, outerR);
    g.addColorStop(0,   `rgba(255,130,0,${0.5 + pulse * 0.3})`);
    g.addColorStop(0.4, `rgba(255,60,0,${0.25 + pulse * 0.15})`);
    g.addColorStop(1,   'rgba(200,0,0,0)');
    ctx.beginPath();
    ctx.arc(v.x, sy, outerR, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();

    // Hot core
    ctx.beginPath();
    ctx.arc(v.x, sy, 8 + pulse * 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,220,80,${0.85 + pulse * 0.15})`;
    ctx.fill();

    // Label
    ctx.font      = `${10 + pulse | 0}px monospace`;
    ctx.fillStyle = `rgba(255,200,60,${0.5 + pulse * 0.5})`;
    ctx.textAlign = 'center';
    ctx.fillText('THERMAL VENT', v.x, sy - 24);
  }
}

// ─── Particle sparks ─────────────────────────────────────────────────────────

function drawSparks () {
  for (const s of sparks) {
    const sy = toSY(s.y);
    if (sy < -10 || sy > CH + 10) continue;
    ctx.beginPath();
    ctx.arc(s.x, sy, s.r * s.life, 0, Math.PI * 2);
    ctx.fillStyle = s.type === 'ex'
      ? `rgba(0,200,255,${s.life * 0.75})`
      : `rgba(255,160,50,${s.life * 0.65})`;
    ctx.fill();
  }
}

// ─── HUD ─────────────────────────────────────────────────────────────────────

function drawHUD (now) {
  // ── Depth / speed readout (top-left)
  ctx.font      = 'bold 13px monospace';
  ctx.fillStyle = '#00ccff';
  ctx.textAlign = 'left';
  ctx.fillText(`DEPTH  ${Math.floor(drone.depth)} m`,    10, 20);
  ctx.fillText(`RECORD ${Math.floor(drone.best)} m`,     10, 38);
  ctx.fillText(`SPEED  ${Math.hypot(drone.vx, drone.vy).toFixed(1)} m/s`, 10, 56);

  // ── Battery bar (top-right)
  const bw   = 140, bh = 14;
  const bx   = CW - bw - 10, by = 8;
  const frac = drone.battery / 100;
  ctx.strokeStyle = '#00ccff';
  ctx.lineWidth   = 1;
  ctx.strokeRect(bx, by, bw, bh);
  const blink = frac < 0.2 ? (Math.sin(now / 180) > 0 ? 1 : 0) : 1;
  ctx.fillStyle = frac > 0.5 ? `rgba(0,255,100,${blink})`
                : frac > 0.25 ? `rgba(255,200,0,${blink})`
                : `rgba(255,50,0,${blink})`;
  ctx.fillRect(bx + 1, by + 1, (bw - 2) * frac, bh - 2);
  ctx.font      = '10px monospace';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(`BATTERY ${Math.floor(drone.battery)}%`, bx + bw / 2, by + bh - 2);

  // ── Orientation compass (bottom-right)
  const cx = CW - 26, cy = CH - 26, cr = 18;
  ctx.strokeStyle = 'rgba(0,180,255,0.4)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#00ffff';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(drone.angle) * cr, cy + Math.sin(drone.angle) * cr);
  ctx.stroke();

  // ── Recharging indicator
  if (drone.onVent) {
    ctx.font      = 'bold 13px monospace';
    ctx.fillStyle = `rgba(255,200,50,${0.7 + Math.sin(now / 150) * 0.3})`;
    ctx.textAlign = 'center';
    ctx.fillText('⚡ RECHARGING ⚡', CW / 2, 22);
  }

  // ── Touch zone hints (faint, bottom strip)
  ctx.font      = '10px monospace';
  ctx.fillStyle = 'rgba(0,180,255,0.4)';
  ctx.textAlign = 'left';
  ctx.fillText('A/D : ROTATE   W/↑ : THRUST', 8, CH - 8);

  // Draw subtle touch-zone outlines for mobile players
  ctx.strokeStyle = 'rgba(0,150,255,0.15)';
  ctx.lineWidth   = 1;
  // Left rotate zone
  ctx.strokeRect(0, 0, CW * 0.35, CH * 0.65);
  // Right rotate zone
  ctx.strokeRect(CW * 0.65, 0, CW * 0.35, CH * 0.65);
  // Thrust zone
  ctx.strokeRect(0, CH * 0.65, CW, CH * 0.35);
}

// ─── Title screen ─────────────────────────────────────────────────────────────

function drawTitle (now) {
  ctx.save();
  ctx.font        = 'bold 34px monospace';
  ctx.fillStyle   = '#00ffff';
  ctx.textAlign   = 'center';
  ctx.shadowColor = '#00ffff';
  ctx.shadowBlur  = 20;
  ctx.fillText('DEPTH-PROBE', CW / 2, CH / 2 - 100);
  ctx.shadowBlur  = 0;

  ctx.font      = '15px monospace';
  ctx.fillStyle = '#0099cc';
  ctx.fillText('DEEP SEA EDITION', CW / 2, CH / 2 - 68);

  ctx.font      = '13px monospace';
  ctx.fillStyle = '#0077aa';
  const lines = [
    'A / D  or  ◁ ▷  — Rotate',
    'W / ↑  or  ▽    — Thrust',
    '',
    'Find Thermal Vents to recharge.',
    'Descend as deep as possible!',
  ];
  lines.forEach((l, i) => ctx.fillText(l, CW / 2, CH / 2 - 20 + i * 22));

  if (Math.floor(now / 500) % 2 === 0) {
    ctx.font      = 'bold 14px monospace';
    ctx.fillStyle = '#00ffff';
    ctx.fillText('PRESS ANY KEY  /  TAP TO DIVE', CW / 2, CH / 2 + 110);
  }
  ctx.restore();
}

// ─── Game-over screen ────────────────────────────────────────────────────────

function drawGameOver () {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, CW, CH);

  ctx.save();
  ctx.font        = 'bold 26px monospace';
  ctx.fillStyle   = '#ff3300';
  ctx.textAlign   = 'center';
  ctx.shadowColor = '#ff3300';
  ctx.shadowBlur  = 18;
  ctx.fillText('POWER FAILURE', CW / 2, CH / 2 - 50);
  ctx.shadowBlur  = 0;

  ctx.font      = '16px monospace';
  ctx.fillStyle = '#00ccff';
  ctx.fillText(`MAX DEPTH : ${Math.floor(drone.best)} m`, CW / 2, CH / 2);

  ctx.font      = '13px monospace';
  ctx.fillStyle = '#0077aa';
  ctx.fillText('Press R  /  Tap to dive again', CW / 2, CH / 2 + 42);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. GAME LOOP
// ─────────────────────────────────────────────────────────────────────────────

let lastTS = 0;

function loop (now) {
  const dt = Math.min((now - lastTS) / 1000, 0.05);   // cap at 50 ms
  lastTS = now;
  update(dt);
  render(now);
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
