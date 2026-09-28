'use strict';

// PC-98 同級生 — Brewser (Nintendo Switch) front-end for pc98EmulatorWeb.
// Disks are bundled under disks/ (renamed *.bin so the Brewser resource
// loader serves them), the CG ROM is pre-rendered in cgrom.bin.

// ---- diagnostics ----
// On a release Brewser build `console.log` is silent and only `console.error`
// reaches the on-device log file, so every boot step is reported with
// console.error and mirrored to the on-screen overlay. If the app ever comes
// up blank again, the last `[pc98]` line in the log says how far it got.
const BOOT_LOG = [];
const BOOT_T0 = Date.now();
function diag(msg) {
  // Elapsed ms in every line so a slow stage is obvious from the log alone.
  const line = '+' + (Date.now() - BOOT_T0) + 'ms ' + msg;
  BOOT_LOG.push(line);
  try { console.error('[pc98] ' + line); } catch (_) {}
}
function fatal(where, err) {
  const detail = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
  diag('FATAL ' + where + ': ' + detail);
  try {
    const el = document.getElementById('overlay-msg');
    const ov = document.getElementById('overlay');
    if (el && ov) {
      el.className = 'overlay-msg error';
      const NL = String.fromCharCode(10);
      el.textContent = 'エラー (' + where + ')' + NL + detail + NL + NL
        + '--- boot log ---' + NL + BOOT_LOG.join(NL);
      ov.classList.remove('hidden');
    }
  } catch (_) {}
}
diag('script start');
try {
  window.addEventListener('error', (e) => fatal('window.error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => fatal('unhandledrejection', e.reason));
} catch (_) {}

const DISKS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
const BOOT_FDD1 = 'a';
const BOOT_FDD2 = 'b';

const SCREEN_W = 640, SCREEN_H = 400;
const PANEL_W = 160;

// ---- UI elements ----
const canvas     = document.getElementById('screen');
const overlay    = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const toastEl    = document.getElementById('toast');
const vkbdEl     = document.getElementById('vkbd');
const btnKbd     = document.getElementById('btn-kbd');
const btnPause   = document.getElementById('btn-pause');
const btnReset   = document.getElementById('btn-reset');
const statusText = document.getElementById('status-text');
const cpuSpeed   = document.getElementById('cpu-speed');
const fddAct     = document.getElementById('fdd-activity');
const fddLed     = document.getElementById('fdd-led');
const geomEl     = document.getElementById('geom');
const driveLabel = [document.getElementById('fdd1-label'), document.getElementById('fdd2-label')];
const driveGrid  = [document.getElementById('fdd1-grid'), document.getElementById('fdd2-grid')];

let pc98 = null;
let paused = false;
let lastFps = 0;
let paintCount = 0;
// Host hard-repaint hook, present only inside the Brewser runtime. Looked up
// once so the per-frame path is a plain call, and reported in the status bar
// so the console can say whether this build is taking the hook at all.
const repaintHook = (typeof globalThis !== 'undefined'
  && typeof globalThis.__swbRepaint === 'function')
  ? globalThis.__swbRepaint : null;

// The host publishes its current display mode. In `fullscreen-canvas` it
// paints the canvas straight to the screen every frame, which is the only
// path that keeps an animating canvas live; everywhere else the canvas is
// baked into a cache that canvas drawing does not invalidate.
function isFullscreenCanvas() {
  return typeof globalThis !== 'undefined'
    && globalThis.__swbBrowserMode === 'fullscreen-canvas';
}

// Ask the host to promote the emulator canvas to fullscreen. Absent outside
const diskCache = {};          // letter -> FDI
const mounted = [null, null];  // letter per drive
let toastTimer = null;

// ---- canvas layout ----
// The runtime viewport is 1280x720 on Switch but the page must not assume it:
// scale the 640x400 framebuffer to whatever the screen area actually is,
// keeping integer-friendly proportions and the 8:5 aspect.
function layout() {
  if (glPresenter) {
    // The WebGL path letterboxes the picture inside a screen-sized drawing
    // buffer, so the element itself just fills the viewport and the panel
    // floats over its right-hand strip.
    canvas.parentNode.style.marginRight = '0';
    canvas.style.width = (window.innerWidth || 1280) + 'px';
    canvas.style.height = (window.innerHeight || 720) + 'px';
    glPresenter.resize();
    return;
  }
  const box = canvas.parentNode;
  const w = box.clientWidth || (window.innerWidth - 160) || 1120;
  const h = box.clientHeight || window.innerHeight || 720;
  const scale = Math.min(w / SCREEN_W, h / SCREEN_H);
  canvas.style.width  = Math.max(1, Math.floor(SCREEN_W * scale)) + 'px';
  canvas.style.height = Math.max(1, Math.floor(SCREEN_H * scale)) + 'px';
}
try { window.addEventListener('resize', layout); } catch (_) {}

function setStatus(msg) { statusText.textContent = msg; }

function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

// ---- resource loading ----
function xhrBytes(path) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      // A local (non-HTTP) load reports status 0 on success.
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) resolve(xhr.response);
      else reject(new Error(`${path}: HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error(`${path}: XHR error`));
    xhr.send();
  });
}

async function fetchBytes(path) {
  let buf;
  if (typeof fetch === 'function') {
    let res;
    try {
      res = await fetch(path);
    } catch (err) {
      throw new Error(`${path}: fetch failed (${err && err.message ? err.message : err})`);
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    buf = await res.arrayBuffer();
  } else {
    diag('fetch() unavailable, falling back to XMLHttpRequest');
    buf = await xhrBytes(path);
  }
  if (!buf || !buf.byteLength) throw new Error(`${path}: empty response`);
  diag(`loaded ${path} (${buf.byteLength} bytes)`);
  return buf;
}

async function loadDisk(letter) {
  if (diskCache[letter]) return diskCache[letter];
  const buf = await fetchBytes(`disks/disk_${letter}.bin`);
  const fdi = new FDI(buf);
  if (!fdi.isValid()) throw new Error(`disk ${letter}: invalid FDI`);
  diskCache[letter] = fdi;
  return fdi;
}

// ---- disk panel ----
// Built with one innerHTML assignment per drive and a single delegated
// listener rather than createElement/addEventListener per button: on the
// runtime's own DOM implementation each element and listener costs real
// time at startup, and this is 18 buttons before anything is on screen.
function buildDiskPanel() {
  for (let d = 0; d < 2; d++) {
    let html = '';
    for (const l of DISKS) {
      html += `<button class="disk-btn" data-letter="${l}">${l.toUpperCase()}</button>`;
    }
    driveGrid[d].innerHTML = html;
    const drive = d;
    driveGrid[d].addEventListener('click', (e) => {
      const letter = e.target && e.target.getAttribute && e.target.getAttribute('data-letter');
      if (letter) void mountDisk(drive, letter);
    });
  }
}

function refreshDiskPanel() {
  for (let d = 0; d < 2; d++) {
    driveLabel[d].textContent = mounted[d] ? mounted[d].toUpperCase() : '-';
    const btns = driveGrid[d].children;
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const on = b.getAttribute('data-letter') === mounted[d];
      b.className = on ? 'disk-btn active' : 'disk-btn';
    }
  }
}

async function mountDisk(drive, letter) {
  if (mounted[drive] === letter) return;
  const btn = driveGrid[drive].querySelector(`[data-letter="${letter}"]`);
  try {
    if (!diskCache[letter]) {
      if (btn) btn.classList.add('loading');
      setStatus(`ディスク${letter.toUpperCase()} 読込中`);
      await loadDisk(letter);
    }
  } catch (err) {
    setStatus(`読込エラー: ${err.message}`);
    toast(`ディスク${letter.toUpperCase()} の読み込みに失敗`);
    if (btn) btn.classList.remove('loading');
    return;
  }
  if (btn) btn.classList.remove('loading');

  // A floppy can only be in one drive at a time.
  const other = drive ^ 1;
  if (mounted[other] === letter) {
    mounted[other] = null;
    if (pc98) pc98.fdc.mount(other, null);
  }
  mounted[drive] = letter;
  if (pc98) pc98.mountDisk(drive, diskCache[letter]);
  refreshDiskPanel();
  setStatus(`FDD${drive + 1}: ディスク${letter.toUpperCase()}`);
  toast(`FDD${drive + 1} ← ディスク ${letter.toUpperCase()}`);
}

function cycleDisk(drive, dir) {
  const cur = mounted[drive] ? DISKS.indexOf(mounted[drive]) : -1;
  const next = (cur + dir + DISKS.length) % DISKS.length;
  void mountDisk(drive, DISKS[next]);
}

// ---- mouse delta drip ----
// The bus mouse counters are 8-bit and the emulator clamps them to +-127 per
// poll, so a big pointer jump (absolute pointer / touch) would be truncated.
// Queue the deltas and hand out at most MOUSE_STEP mickeys per HC latch
// (i.e. per game poll), so the game cursor always catches up.
const MOUSE_STEP = 100;
function installMouseDrip(mouse) {
  let px = 0, py = 0;
  mouse.move = (dx, dy) => { px += dx; py += dy; };
  const origEdge = mouse._hcEdge.bind(mouse);
  mouse._hcEdge = (old) => {
    if ((mouse._portC & 0x80) && !(old & 0x80)) {
      const sx = Math.max(-MOUSE_STEP, Math.min(MOUSE_STEP, px));
      const sy = Math.max(-MOUSE_STEP, Math.min(MOUSE_STEP, py));
      mouse._dx = sx; mouse._dy = sy;
      px -= sx; py -= sy;
    }
    origEdge(old);
  };
  const origReset = mouse.reset.bind(mouse);
  mouse.reset = () => { px = 0; py = 0; origReset(); };
  mouseDrained = () => px === 0 && py === 0;
}
let mouseDrained = () => true;

// ---- emulator lifecycle ----
function bootMachine() {
  if (pc98) pc98.stop();
  pc98 = new PC98(canvas, glPresenter ? glPresenter.present : null);
  installMouseDrip(pc98.mouse);
  // Count the frames Video.render actually pushes to the canvas (it skips
  // frames where nothing changed), so the panel can distinguish "nothing is
  // being drawn" from "drawing is not reaching the screen".
  paintCount = 0;
  const video = pc98.video;
  const origRender = video.render.bind(video);
  video.render = () => {
    const dirty = video._dirty;
    origRender();
    if (!dirty) return;
    paintCount++;
    // The host composites the page through a cached bake of the element
    // tree, and drawing into a canvas does not invalidate that cache — on
    // the console the canvas was composited once and every later frame was
    // dropped, which is why a self-test pattern drawn before boot stayed on
    // screen forever. Fullscreen-canvas mode blits the canvas every frame on
    // its own, so the hard repaint is only the fallback for when the mode
    // could not be entered, and only on frames that actually changed.
    if (repaintHook && !glPresenter && !isFullscreenCanvas()) repaintHook();
  };
  pc98.onFPS = (fps) => { lastFps = fps; };
  pc98._speedMultiplier = 1.0;
  for (let d = 0; d < 2; d++) {
    if (mounted[d]) pc98.mountDisk(d, diskCache[mounted[d]]);
  }
  pc98.reset();
  pc98.start();
  paused = false;
  btnPause.textContent = '一時停止';
  overlay.classList.add('hidden');
  setStatus('実行中');
}

btnReset.addEventListener('click', () => {
  if (!pc98) return;
  bootMachine();
  setStatus('リセット');
});

btnPause.addEventListener('click', () => {
  if (!pc98) return;
  if (paused) {
    pc98.start();
    paused = false;
    btnPause.textContent = '一時停止';
    setStatus('実行中');
  } else {
    pc98.stop();
    paused = true;
    btnPause.textContent = '再開';
    setStatus('一時停止中');
  }
});

// ---- mouse (pointer / software cursor on Switch) ----
// Deltas are derived from absolute canvas coordinates, scaled to 640x400.
let mouseLastX = null, mouseLastY = null, mouseAccX = 0, mouseAccY = 0;
let touchUntil = 0; // ignore compat mouse events shortly after touch

function canvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return [
    (clientX - rect.left) * (SCREEN_W / rect.width),
    (clientY - rect.top) * (SCREEN_H / rect.height),
  ];
}

function feedMove(x, y) {
  if (mouseLastX !== null) {
    mouseAccX += x - mouseLastX;
    mouseAccY += y - mouseLastY;
    const dx = Math.trunc(mouseAccX);
    const dy = Math.trunc(mouseAccY);
    if (dx !== 0 || dy !== 0) {
      if (pc98 && pc98.mouse) pc98.mouse.move(dx, dy);
      mouseAccX -= dx;
      mouseAccY -= dy;
    }
  }
  mouseLastX = x;
  mouseLastY = y;
}

function resetMoveTracking() { mouseLastX = null; mouseLastY = null; }

canvas.addEventListener('mousemove', (e) => {
  if (Date.now() < touchUntil) return;
  const [x, y] = canvasPos(e.clientX, e.clientY);
  feedMove(x, y);
});
canvas.addEventListener('mouseleave', resetMoveTracking);
// Button state machine. Two timing rules:
//  * a press is only delivered once the queued movement has drained
//    (mouseDrained()), so a "jump + click" (touch tap / synthetic click)
//    lands where the pointer went, not where the game cursor used to be;
//  * a press is held for at least MIN_PRESS_MS before the release is
//    delivered, since the game samples the mouse from a ~120 Hz interrupt.
// A tap released before its press could be delivered still produces a
// full press/release pair.
const MIN_PRESS_MS = 70;
const MAX_DRAIN_WAIT_MS = 250; // give up waiting if the game isn't polling
const btnState = [
  { wantDown: false, pending: false, wantSince: 0, down: false, downAt: 0 },
  { wantDown: false, pending: false, wantSince: 0, down: false, downAt: 0 },
];
function pressButton(which) {
  const st = btnState[which];
  st.wantDown = true;
  if (!st.down && !st.pending) { st.pending = true; st.wantSince = Date.now(); }
}
function releaseButton(which) { btnState[which].wantDown = false; }
function serviceButtons() {
  if (!pc98 || !pc98.mouse) return;
  const now = Date.now();
  for (let w = 0; w < 2; w++) {
    const st = btnState[w];
    if (st.pending && !st.down) {
      if (!mouseDrained() && now - st.wantSince < MAX_DRAIN_WAIT_MS) continue;
      st.pending = false;
      st.down = true; st.downAt = now;
      pc98.mouse.button(w, true);
    } else if (st.down && !st.wantDown) {
      if (now - st.downAt < MIN_PRESS_MS) continue;
      st.down = false;
      pc98.mouse.button(w, false);
    }
  }
}
setInterval(serviceButtons, 4);

canvas.addEventListener('mousedown', (e) => {
  if (Date.now() < touchUntil) return;
  e.preventDefault();
  pressButton(e.button === 2 ? 1 : 0);
});
canvas.addEventListener('mouseup', (e) => {
  if (Date.now() < touchUntil) return;
  releaseButton(e.button === 2 ? 1 : 0);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Touch (handheld): drag = move, tap = left click, two-finger tap = right click.
let touchStartT = 0, touchMoved = 0, touchFingers = 0;
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  touchUntil = Date.now() + 700;
  touchFingers = Math.max(touchFingers, e.touches.length);
  if (e.touches.length === 1) {
    touchStartT = Date.now();
    touchMoved = 0;
    resetMoveTracking();
    const [x, y] = canvasPos(e.touches[0].clientX, e.touches[0].clientY);
    feedMove(x, y);
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  touchUntil = Date.now() + 700;
  if (e.touches.length !== 1) return;
  const [x, y] = canvasPos(e.touches[0].clientX, e.touches[0].clientY);
  if (mouseLastX !== null) touchMoved += Math.abs(x - mouseLastX) + Math.abs(y - mouseLastY);
  feedMove(x, y);
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  touchUntil = Date.now() + 700;
  if (e.touches.length > 0) return; // wait for last finger
  const fingers = touchFingers;
  touchFingers = 0;
  resetMoveTracking();
  const dur = Date.now() - touchStartT;
  if (dur < 400 && touchMoved < 12) {
    const which = fingers >= 2 ? 1 : 0;
    pressButton(which);
    releaseButton(which);
  }
}, { passive: false });
canvas.addEventListener('touchcancel', () => { touchFingers = 0; resetMoveTracking(); });

// ---- physical keyboard (USB keyboard on Switch / PC) ----
document.addEventListener('keydown', (e) => {
  if (!pc98) return;
  e.preventDefault();
  pc98.onKeyDown(e);
});
document.addEventListener('keyup', (e) => {
  if (!pc98) return;
  pc98.onKeyUp(e);
});

// ---- virtual keyboard (clickable with cursor / touch) ----
// [label, code, key]
const VK_ROWS = [
  [['ESC', 'Escape', 'Escape'], ['1', 'Digit1', '1'], ['2', 'Digit2', '2'], ['3', 'Digit3', '3'], ['4', 'Digit4', '4'],
   ['5', 'Digit5', '5'], ['6', 'Digit6', '6'], ['7', 'Digit7', '7'], ['8', 'Digit8', '8'], ['9', 'Digit9', '9'],
   ['0', 'Digit0', '0'], ['-', 'Minus', '-'], ['BS', 'Backspace', 'Backspace']],
  [['Q', 'KeyQ', 'q'], ['W', 'KeyW', 'w'], ['E', 'KeyE', 'e'], ['R', 'KeyR', 'r'], ['T', 'KeyT', 't'],
   ['Y', 'KeyY', 'y'], ['U', 'KeyU', 'u'], ['I', 'KeyI', 'i'], ['O', 'KeyO', 'o'], ['P', 'KeyP', 'p'],
   ['↑', 'ArrowUp', 'ArrowUp'], ['F1', 'F1', 'F1'], ['F2', 'F2', 'F2']],
  [['A', 'KeyA', 'a'], ['S', 'KeyS', 's'], ['D', 'KeyD', 'd'], ['F', 'KeyF', 'f'], ['G', 'KeyG', 'g'],
   ['H', 'KeyH', 'h'], ['J', 'KeyJ', 'j'], ['K', 'KeyK', 'k'], ['L', 'KeyL', 'l'], ['←', 'ArrowLeft', 'ArrowLeft'],
   ['↓', 'ArrowDown', 'ArrowDown'], ['→', 'ArrowRight', 'ArrowRight'], ['F3', 'F3', 'F3']],
  [['Z', 'KeyZ', 'z'], ['X', 'KeyX', 'x'], ['C', 'KeyC', 'c'], ['V', 'KeyV', 'v'], ['B', 'KeyB', 'b'],
   ['N', 'KeyN', 'n'], ['M', 'KeyM', 'm'], ['SPACE', 'Space', ' ', 'xwide'], ['ENTER', 'Enter', 'Enter', 'wide'], ['閉じる', null, null, 'wide']],
];

// Built on first open, not at startup: ~50 keys with a listener each is the
// single most expensive piece of DOM in the page, and the game is played
// with the mouse — most sessions never open the keyboard at all. One
// innerHTML pass plus delegated listeners on the container.
let vkbdBuilt = false;
function buildVirtualKeyboard() {
  if (vkbdBuilt) return;
  vkbdBuilt = true;
  let html = '';
  for (const row of VK_ROWS) {
    html += '<div class="vk-row">';
    for (const [label, code, key, cls] of row) {
      const attrs = code === null
        ? ' data-close="1"'
        : ` data-code="${code}" data-key="${key === ' ' ? '&#32;' : key}"`;
      html += `<button class="vk${cls ? ' ' + cls : ''}"${attrs}>${label}</button>`;
    }
    html += '</div>';
  }
  vkbdEl.innerHTML = html;

  let downBtn = null;
  const press = (ev) => {
    const b = ev.target;
    if (!b || !b.getAttribute) return;
    if (b.getAttribute('data-close')) { ev.preventDefault(); toggleVirtualKeyboard(false); return; }
    const code = b.getAttribute('data-code');
    if (!code) return;
    ev.preventDefault();
    if (downBtn) release();
    downBtn = b;
    b.className = b.className + ' down';
    if (pc98) pc98.onKeyDown({ code, key: b.getAttribute('data-key') });
  };
  const release = () => {
    const b = downBtn;
    if (!b) return;
    downBtn = null;
    b.className = b.className.replace(' down', '');
    if (pc98) pc98.onKeyUp({ code: b.getAttribute('data-code'), key: b.getAttribute('data-key') });
  };
  vkbdEl.addEventListener('mousedown', press);
  vkbdEl.addEventListener('mouseup', release);
  vkbdEl.addEventListener('mouseleave', release);
  vkbdEl.addEventListener('touchstart', press, { passive: false });
  vkbdEl.addEventListener('touchend', (ev) => { ev.preventDefault(); release(); }, { passive: false });
}

function toggleVirtualKeyboard(show) {
  const visible = !vkbdEl.classList.contains('hidden');
  const next = show === undefined ? !visible : show;
  if (next) buildVirtualKeyboard();
  vkbdEl.classList.toggle('hidden', !next);
  btnKbd.classList.toggle('active', next);
}
btnKbd.addEventListener('click', () => toggleVirtualKeyboard());

// ---- gamepad (Switch Joy-Con / Pro Controller, standard mapping) ----
// The manifest hides Brewser's software mouse layer, so the game's own arrow
// cursor is the only pointer on screen (as on a real PC-98) and the pad
// reaches the page through the Gamepad API unfiltered:
//   Left stick          = mouse (speed follows deflection)
//   Right stick         = slow / precise mouse
//   A (0) / B (1)       = left / right mouse button
//   D-pad LEFT/RIGHT    = previous / next disk in FDD2
//   D-pad UP/DOWN       = previous / next disk in FDD1
//   Y (3)               = toggle virtual keyboard
// L / R / ZL / ZR / X / -  are left to the shell (back, home, exit, ...).
const GP_A = 0, GP_B = 1, GP_Y = 3;
const GP_UP = 12, GP_DOWN = 13, GP_LEFT = 14, GP_RIGHT = 15;
const STICK_DEADZONE = 0.18;
const STICK_MAX_PX   = 9;    // px per poll tick at full deflection (left stick)
const STICK_FINE_PX  = 2;    // right stick
const GP_POLL_MS     = 16;
const gpPrev = {};
let stickAccX = 0, stickAccY = 0;

function stickDelta(ax, ay, maxPx) {
  const mag = Math.hypot(ax, ay);
  if (mag < STICK_DEADZONE) return [0, 0];
  const t = Math.min(1, (mag - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  const speed = t * t * maxPx;
  return [ax / mag * speed, ay / mag * speed];
}

function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : null;
  if (!pads) return;
  let mx = 0, my = 0;
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p || !p.buttons) continue;
    const prev = gpPrev[i] || (gpPrev[i] = {});
    const pressed = (idx) => !!(p.buttons[idx] && p.buttons[idx].pressed);
    const edge = (idx) => { const now = pressed(idx); const was = !!prev[idx]; prev[idx] = now; return now && !was; };
    const axes = p.axes || [];
    const [lx, ly] = stickDelta(axes[0] || 0, axes[1] || 0, STICK_MAX_PX);
    const [rx, ry] = stickDelta(axes[2] || 0, axes[3] || 0, STICK_FINE_PX);
    mx += lx + rx; my += ly + ry;

    const a = pressed(GP_A), b = pressed(GP_B);
    if (a && !prev.a) pressButton(0);
    if (!a && prev.a) releaseButton(0);
    if (b && !prev.b) pressButton(1);
    if (!b && prev.b) releaseButton(1);
    prev.a = a; prev.b = b;

    if (edge(GP_LEFT))  cycleDisk(1, -1);
    if (edge(GP_RIGHT)) cycleDisk(1, +1);
    if (edge(GP_UP))    cycleDisk(0, -1);
    if (edge(GP_DOWN))  cycleDisk(0, +1);
    if (edge(GP_Y))     toggleVirtualKeyboard();
  }
  if (mx !== 0 || my !== 0) {
    stickAccX += mx; stickAccY += my;
    const dx = Math.trunc(stickAccX), dy = Math.trunc(stickAccY);
    if ((dx !== 0 || dy !== 0) && pc98 && pc98.mouse) {
      pc98.mouse.move(dx, dy);
      stickAccX -= dx; stickAccY -= dy;
    }
  }
}
setInterval(pollGamepads, GP_POLL_MS);

// ---- rAF watchdog ----
// PC98._loop reschedules itself with requestAnimationFrame. If the host
// stops delivering animation frames (hidden/offscreen surface) the machine
// would freeze; drive the loop from a timer while that is the case.
// Ticks at frame rate so that a host which never delivers animation frames
// (an embedded/background view, for instance) still runs the machine at
// full speed rather than at the watchdog's own rate. The threshold stays
// far above any plausible frame time — the timer callback cannot run while
// a frame is in progress, so once rAF is alive `_lastTime` is always fresh
// and this never double-drives the loop.
setInterval(() => {
  if (!pc98 || !pc98._running || paused) return;
  if (performance.now() - pc98._lastTime < 250) return;
  if (pc98._rafId) { cancelAnimationFrame(pc98._rafId); pc98._rafId = null; }
  pc98._loop();
}, 16);

// ---- status indicator ----
// Emulated clock rate matters more than frame rate here: the PC-98 ran at
// 10 MHz, so "0.4 MHz" means the game is crawling at 1/25 speed while
// "9.8 MHz" means it is keeping up. CS:IP shows whether the CPU is
// actually advancing or spinning in one place.
let lastCycles = 0, lastCycleT = 0;
let lastVpW = 0, lastVpH = 0;

function syncViewport() {
  const w = window.innerWidth || 0;
  const h = window.innerHeight || 0;
  if (!w || !h || (w === lastVpW && h === lastVpH)) return;
  lastVpW = w; lastVpH = h;
  layout();
  if (pc98) pc98.video._dirty = true;
  diag('viewport now ' + w + 'x' + h);
}
try { window.addEventListener('resize', syncViewport); } catch (_) {}
setInterval(() => {
  if (!pc98) {
    cpuSpeed.textContent = '';
    fddAct.textContent = '';
    fddLed.classList.add('hidden');
    return;
  }
  const now = Date.now();
  const cyc = pc98.cpu.totalCycles;
  if (lastCycleT) {
    const mhz = (cyc - lastCycles) / ((now - lastCycleT) * 1000);
    cpuSpeed.textContent = `${lastFps} FPS  ${mhz.toFixed(2)} MHz`;
  }
  lastCycles = cyc;
  lastCycleT = now;

  const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
  // P = frames actually pushed to the canvas. If this keeps climbing while
  // the screen stays black, the emulator is painting and the display path
  // is losing it; if it stops, the machine stopped changing the screen.
  syncViewport();
  const r = glPresenter && glPresenter.rect ? glPresenter.rect() : null;
  geomEl.textContent = `vp ${window.innerWidth || 0}x${window.innerHeight || 0}`
    + ` / buf ${canvas.width}x${canvas.height}`
    + (r ? ` / img ${r[2]}x${r[3]} @${r[0]},${r[1]}` : ' / 2d');
  const mode = (typeof globalThis !== 'undefined' && globalThis.__swbBrowserMode) || '';
  const modeTag = mode ? ' ' + String(mode).replace('fullscreen-', 'FS-') : '';
  fddAct.textContent = `${hex(pc98.cpu.cs, 4)}:${hex(pc98.cpu.ip, 4)} P:${paintCount}${repaintHook ? ' R' : ''}${modeTag}`;
  fddLed.classList.toggle('hidden', now - (pc98.video._fddActivity || 0) >= 700);
}, 500);

// ---- boot ----
// Hand control back to the runtime so it can paint. The shell populates the
// DOM and runs page scripts before its first paint, so anything done
// synchronously here — or in one unbroken chain of microtasks — happens
// while the screen is still blank. Yielding through a timer (and a frame
// when one is offered) lets "起動中..." and the panel appear first, which
// also makes a slow stage visible instead of looking like a hang.
function yieldToPaint() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { requestAnimationFrame(() => setTimeout(finish, 0)); } catch (_) {}
    setTimeout(finish, 120);
  });
}

// ---- presentation ----
// Canvas 2D reaches the screen only once inside the runtime: the host takes
// the canvas into its composite and never re-reads it, so every emulator
// frame after the first was dropped — a self-test pattern drawn before boot
// sat on screen while the machine ran behind it, even in fullscreen-canvas
// mode. WebGL is the path the host keeps live: it copies the shared GL
// bridge framebuffer straight to the display each frame. So the composed
// framebuffer is uploaded as a texture and drawn as a quad, and the canvas
// is set up the way the emulators already working on this console do —
// screen-sized drawing buffer, plain `webgl` context, no alpha or depth.
const VS_SRC =
  'attribute vec2 p;' +
  'varying vec2 uv;' +
  'void main(){ uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }';
const FS_SRC =
  'precision mediump float;' +
  'varying vec2 uv;' +
  'uniform sampler2D tex;' +
  'void main(){ gl_FragColor = texture2D(tex, uv); }';

let glPresenter = null;   // { present(frame), resize() }

function createGLPresenter() {
  // The drawing buffer size comes from the canvas element's width/height
  // ATTRIBUTES and is deliberately not reassigned here. Assigning the
  // properties reported the new size back to the page while the host's GL
  // bridge kept the region declared in the tag, so the picture was rendered
  // at one size and copied at another — a zoomed crop on screen.
  const bw = canvas.width, bh = canvas.height;

  const attrs = { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false };
  let gl = null;
  try {
    gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  } catch (err) {
    diag('getContext(webgl) threw: ' + (err && err.message ? err.message : err));
  }
  if (!gl) {
    diag('WebGL unavailable, falling back to Canvas 2D');
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    return null;
  }

  let prog;
  try {
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader: ' + gl.getShaderInfoLog(sh));
      }
      return sh;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS_SRC));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    }
  } catch (err) {
    diag('WebGL setup failed: ' + (err && err.message ? err.message : err));
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    return null;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // NEAREST keeps the 640x400 framebuffer crisp when scaled up.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SCREEN_W, SCREEN_H, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.uniform1i(gl.getUniformLocation(prog, 'tex'), 0);
  gl.clearColor(0, 0, 0, 1);

  // Letterbox the picture, keeping the panel's strip on the right clear.
  let vx = 0, vy = 0, vw = SCREEN_W, vh = SCREEN_H;
  function resize() {
    const dw = canvas.width, dh = canvas.height;
    const usableW = Math.max(1, dw > PANEL_W * 2 ? dw - PANEL_W : dw);
    const scale = Math.min(usableW / SCREEN_W, dh / SCREEN_H);
    vw = Math.max(1, Math.round(SCREEN_W * scale));
    vh = Math.max(1, Math.round(SCREEN_H * scale));
    vx = Math.round((usableW - vw) / 2);
    vy = Math.round((dh - vh) / 2);
  }
  resize();

  const rgba = new Uint8Array(SCREEN_W * SCREEN_H * 4);
  function present(frame) {
    rgba.set(frame.data);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SCREEN_W, SCREEN_H,
      gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(vx, vy, vw, vh);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  diag('WebGL presenter ready (' + bw + 'x' + bh + ')');
  return { present, resize, rect: () => [vx, vy, vw, vh] };
}

// ---- presentation self-test ----
// Animated on purpose: a static pattern only proves that something reached
// the screen once, which was already true while every later frame was being
// dropped. Bars that visibly slide prove the path stays live. It also runs
// through the real presenter, so it tests what the emulator will use.
// Set SELFTEST_MS to 0 to skip it.
const SELFTEST_MS = 3000;

function selfTestFrame(bytes, phase) {
  const BARS = [
    0xFFFFFFFF, 0xFF00FFFF, 0xFFFFFF00, 0xFF00FF00,
    0xFFFF00FF, 0xFF0000FF, 0xFFFF0000, 0xFF808080,
  ];
  const px = new Uint32Array(bytes.buffer, bytes.byteOffset, SCREEN_W * SCREEN_H);
  const bw = SCREEN_W / BARS.length;
  for (let y = 0; y < SCREEN_H; y++) {
    const dir = y < SCREEN_H / 2 ? 1 : -1;
    for (let x = 0; x < SCREEN_W; x++) {
      const shifted = x + dir * phase;
      const i = ((Math.floor(shifted / bw) % BARS.length) + BARS.length) % BARS.length;
      px[y * SCREEN_W + x] = BARS[i];
    }
  }
}

function canvasSelfTest() {
  if (SELFTEST_MS <= 0) return Promise.resolve();
  // The loading overlay sits on top of the canvas at 82% black, which would
  // dim the very thing being judged by eye.
  overlay.classList.add('hidden');
  setStatus('自己テスト表示中');
  diag('self-test start');

  const ctx2d = glPresenter ? null : canvas.getContext('2d');
  const frame = glPresenter
    ? { data: new Uint8ClampedArray(SCREEN_W * SCREEN_H * 4), width: SCREEN_W, height: SCREEN_H }
    : ctx2d.createImageData(SCREEN_W, SCREEN_H);

  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const elapsed = Date.now() - t0;
      selfTestFrame(frame.data, Math.floor(elapsed / 25));
      if (glPresenter) {
        glPresenter.present(frame);
      } else {
        ctx2d.putImageData(frame, 0, 0);
        if (repaintHook) repaintHook();
      }
      if (elapsed >= SELFTEST_MS) {
        clearInterval(timer);
        diag('self-test done');
        resolve();
      }
    }, 50);
  });
}

async function main() {
  diag('main() start');
  layout();
  buildDiskPanel();
  refreshDiskPanel();
  diag('panel built');

  glPresenter = createGLPresenter();
  layout();

  overlayMsg.textContent = 'フォント読み込み中...';
  await yieldToPaint();

  try {
    Video.cgrom = new Uint8Array(await fetchBytes('cgrom.bin'));
  } catch (err) {
    // Not fatal: video.js falls back to rasterising glyphs with a canvas font.
    diag('cgrom.bin unavailable, using canvas font: ' + (err && err.message ? err.message : err));
    Video.cgrom = null;
  }

  overlayMsg.textContent = 'ディスク読み込み中...';
  await yieldToPaint();

  // Both disks go in before the machine starts. Booting with FDD2 still
  // empty and filling it in afterwards saved ~1.2 MB of startup I/O, but
  // it also let the game look for disk B before it was there — and the
  // measured startup cost turned out to be milliseconds, not seconds.
  await loadDisk(BOOT_FDD1);
  await loadDisk(BOOT_FDD2);
  mounted[0] = BOOT_FDD1;
  mounted[1] = BOOT_FDD2;
  refreshDiskPanel();

  await yieldToPaint();
  await canvasSelfTest();

  bootMachine();
  diag('machine running');
}

main().catch((err) => fatal('main', err));
