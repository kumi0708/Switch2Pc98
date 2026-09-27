'use strict';

// 8253 Programmable Interval Timer
class PIT {
  constructor(io, pic) {
    this.pic = pic;
    this._counters = [
      { mode: 2, count: 0, latch: 0, reload: 0x10000, lowByte: true, out: true },
      { mode: 2, count: 0, latch: 0, reload: 0,       lowByte: true, out: true },
      { mode: 2, count: 0, latch: 0, reload: 0,       lowByte: true, out: true },
    ];
    this._cycleAccum = 0;
    // PC-98: PIT ports at 0x71,0x73,0x75,0x77
    io.register(0x71, () => this._read(0), (p,v) => this._write(0,v));
    io.register(0x73, () => this._read(1), (p,v) => this._write(1,v));
    io.register(0x75, () => this._read(2), (p,v) => this._write(2,v));
    io.register(0x77, () => 0,             (p,v) => this._control(v));
  }

  _control(v) {
    const ch = (v >> 6) & 3;
    if (ch === 3) return; // read-back
    const rw = (v >> 4) & 3;
    const mode = (v >> 1) & 7;
    const c = this._counters[ch];
    c.mode = mode;
    c.lowByte = true;
    if (rw === 0) { c.latch = c.count; }
  }

  _read(ch) {
    const c = this._counters[ch];
    if (c.lowByte) { c.lowByte = false; return c.count & 0xFF; }
    c.lowByte = true;
    return (c.count >> 8) & 0xFF;
  }

  _write(ch, v) {
    const c = this._counters[ch];
    if (c.lowByte) { c.latch = v; c.lowByte = false; }
    else {
      c.reload = c.latch | (v << 8);
      if (!c.reload) c.reload = 0x10000;
      c.count  = c.reload;
      c.lowByte = true;
    }
  }

  // Called with CPU cycles elapsed, generates IRQ0 (timer tick)
  tick(cycles) {
    this._cycleAccum += cycles;
    // PC-98 timer: ~2.4576MHz, IRQ0 at ~100Hz (10ms)
    // 2457600 / 100 = 24576 cycles per tick (approximately)
    const CYCLES_PER_TICK = 24576;
    while (this._cycleAccum >= CYCLES_PER_TICK) {
      this._cycleAccum -= CYCLES_PER_TICK;
      this.pic.raise(0); // IRQ0 → INT 08h
    }
  }

  reset() {
    this._cycleAccum = 0;
    for (const c of this._counters) {
      c.count = c.reload = 0x10000;
      c.lowByte = true;
    }
  }
}
