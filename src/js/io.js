'use strict';

class IO {
  constructor() {
    this._read  = new Array(0x10000).fill(null);
    this._write = new Array(0x10000).fill(null);
  }

  register(port, readFn, writeFn) {
    if (readFn)  this._read[port]  = readFn;
    if (writeFn) this._write[port] = writeFn;
  }

  // Register a range of ports
  registerRange(start, end, readFn, writeFn) {
    for (let p = start; p <= end; p++) {
      this.register(p, readFn, writeFn);
    }
  }

  read8(port) {
    port &= 0xFFFF;
    if (this._read[port]) return this._read[port](port) & 0xFF;
    if (this.debugUnknown) this._logUnknown('R', port);
    return 0xFF;
  }

  write8(port, val) {
    port &= 0xFFFF;
    val &= 0xFF;
    if (this._portWriteLog) {
      this._portWriteLog.set(port, (this._portWriteLog.get(port) || 0) + 1);
    }
    if (this._write[port]) { this._write[port](port, val); return; }
    if (this.debugUnknown) this._logUnknown('W', port, val);
  }

  _logUnknown(dir, port, val) {
    const k = `${dir}:${port.toString(16)}`;
    if (!this._unknownSeen) this._unknownSeen = new Map();
    const cnt = (this._unknownSeen.get(k) || 0) + 1;
    this._unknownSeen.set(k, cnt);
    if (cnt <= 3) console.warn(`IO ${dir} unknown port 0x${port.toString(16).padStart(4,'0')}` + (val !== undefined ? ` = 0x${val.toString(16).padStart(2,'0')}` : ''));
  }

  read16(port) {
    return this.read8(port) | (this.read8(port + 1) << 8);
  }

  write16(port, val) {
    this.write8(port, val & 0xFF);
    this.write8(port + 1, (val >> 8) & 0xFF);
  }
}
