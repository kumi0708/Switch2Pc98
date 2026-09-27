'use strict';

// PC-98 bus mouse (8255A at 0x7FD9-0x7FDF)
// Port A (0x7FD9) read: bit7=left btn, bit6=middle, bit5=right (all active low),
//                       bits0-3 = selected displacement counter nibble
// Port C (0x7FDD): bit7=HC (latch+clear counters on rising edge),
//                  bit6=SXY (0=X counter, 1=Y), bit5=SHL (0=low nibble, 1=high)
// Control (0x7FDF): BSR mode (bit7=0): set/reset single port C bit
class Mouse {
  constructor(io) {
    this._dx = 0; this._dy = 0;   // accumulating deltas
    this._lx = 0; this._ly = 0;   // latched counter values
    this._btnL = false; this._btnR = false;
    this._portC = 0;

    io.register(0x7FD9, () => this._readA(), (p,v) => {});
    io.register(0x7FDB, () => 0xFF, (p,v) => {});
    io.register(0x7FDD, () => this._portC, (p,v) => this._writeC(v));
    io.register(0x7FDF, null, (p,v) => {
      if (!(v & 0x80)) {
        // BSR mode: bit0 = value, bits1-3 = port C bit number
        const bit = (v >> 1) & 7;
        const old = this._portC;
        if (v & 1) this._portC |= (1 << bit);
        else       this._portC &= ~(1 << bit);
        this._hcEdge(old);
      }
    });
  }

  _writeC(v) {
    const old = this._portC;
    this._portC = v;
    this._hcEdge(old);
  }

  _hcEdge(old) {
    // Rising edge of HC: latch counters and clear accumulators
    if ((this._portC & 0x80) && !(old & 0x80)) {
      this._lx = this._dx & 0xFF;
      this._ly = this._dy & 0xFF;
      this._dx = 0;
      this._dy = 0;
    }
  }

  _readA() {
    const v   = (this._portC & 0x40) ? this._ly : this._lx;
    const nib = (this._portC & 0x20) ? (v >> 4) & 0x0F : v & 0x0F;
    let r = nib | 0x40; // middle button released
    if (!this._btnL) r |= 0x80;
    if (!this._btnR) r |= 0x20;
    return r;
  }

  // Browser event feeds
  move(dx, dy) {
    this._dx = Math.max(-127, Math.min(127, this._dx + dx));
    this._dy = Math.max(-127, Math.min(127, this._dy + dy));
  }
  button(which, pressed) {
    if (which === 0) this._btnL = pressed;
    else             this._btnR = pressed;
  }

  reset() {
    this._dx = this._dy = this._lx = this._ly = 0;
    this._btnL = this._btnR = false;
    this._portC = 0;
  }
}
