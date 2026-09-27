'use strict';

// 8259A Programmable Interrupt Controller (PC-98: master 0x00/0x02, slave 0x08/0x0A)
// Master vector base 0x08 (IRQ0-7), slave vector base 0x10 (IRQ8-15)
class PIC {
  constructor(io, cpu) {
    this.cpu = cpu;

    this.master = this._mkUnit(0x08);
    this.slave  = this._mkUnit(0x10);

    // Master PIC: cmd 0x00, data 0x02
    io.register(0x00, () => this._readCmd(this.master), (p,v) => this._writeCmd(this.master, v));
    io.register(0x02, () => this.master.mask,           (p,v) => this._writeData(this.master, v));
    // Slave PIC: cmd 0x08, data 0x0A
    io.register(0x08, () => this._readCmd(this.slave),  (p,v) => this._writeCmd(this.slave, v));
    io.register(0x0A, () => this.slave.mask,            (p,v) => this._writeData(this.slave, v));
  }

  _mkUnit(base) {
    return { base, mask: 0xFF, irr: 0, isr: 0, icwStep: 0, readISR: false };
  }

  _readCmd(u) {
    return u.readISR ? u.isr : u.irr;
  }

  _writeCmd(u, v) {
    if (v & 0x10) {
      // ICW1: start init sequence
      u.icwStep = 1;
      u.mask = 0;
      u.irr = 0;
      u.isr = 0;
      u.readISR = false;
    } else if ((v & 0x18) === 0x08) {
      // OCW3
      if (v & 0x02) u.readISR = !!(v & 0x01);
    } else if (v === 0x20) {
      // Non-specific EOI
      for (let i = 0; i < 8; i++) {
        if (u.isr & (1 << i)) { u.isr &= ~(1 << i); break; }
      }
    } else if ((v & 0xE0) === 0x60) {
      // Specific EOI
      u.isr &= ~(1 << (v & 7));
    }
  }

  _writeData(u, v) {
    if (u.icwStep === 1) {
      // ICW2: vector base
      u.base = v & 0xF8;
      u.icwStep = 2;
    } else if (u.icwStep === 2) {
      // ICW3
      u.icwStep = 3;
    } else if (u.icwStep === 3) {
      // ICW4
      u.icwStep = 0;
    } else {
      // OCW1: interrupt mask
      u.mask = v;
    }
  }

  // Raise hardware IRQ (0-15)
  raise(irq) {
    const u  = irq < 8 ? this.master : this.slave;
    const ir = irq & 7;
    const bit = 1 << ir;
    if (u.mask & bit) return;        // masked
    if (u.isr & bit)  return;        // still being serviced
    u.irr |= bit;
    // Simplified ack: mark in-service immediately and queue to CPU
    u.irr &= ~bit;
    u.isr |= bit;
    this.cpu.requestInterrupt(u.base + ir);
  }

  reset() {
    this.master.mask = 0xFF; this.master.irr = 0; this.master.isr = 0;
    this.master.icwStep = 0; this.master.readISR = false; this.master.base = 0x08;
    this.slave.mask = 0xFF;  this.slave.irr = 0;  this.slave.isr = 0;
    this.slave.icwStep = 0;  this.slave.readISR = false;  this.slave.base = 0x10;
  }
}
