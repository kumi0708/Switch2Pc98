'use strict';

class Memory {
  constructor() {
    this.data = new Uint8Array(0x100000); // 1MB
    // BIOS data area callbacks for special memory ranges
    this._ioHandlers = { read: {}, write: {} };
  }

  mapIO(start, end, readFn, writeFn) {
    for (let a = start; a <= end; a += 2) {
      if (readFn)  this._ioHandlers.read[a]  = readFn;
      if (writeFn) this._ioHandlers.write[a] = writeFn;
    }
  }

  read8(addr) {
    addr &= 0xFFFFF;
    return this.data[addr];
  }

  write8(addr, val) {
    addr &= 0xFFFFF;
    val &= 0xFF;
    this.data[addr] = val;
  }

  read16(addr) {
    addr &= 0xFFFFF;
    return this.data[addr] | (this.data[(addr + 1) & 0xFFFFF] << 8);
  }

  write16(addr, val) {
    addr &= 0xFFFFF;
    this.data[addr] = val & 0xFF;
    this.data[(addr + 1) & 0xFFFFF] = (val >> 8) & 0xFF;
  }

  // Bulk load (for ROM/disk)
  load(addr, src, len) {
    len = len || src.length;
    for (let i = 0; i < len; i++) {
      this.data[(addr + i) & 0xFFFFF] = src[i];
    }
  }

  // Read null-terminated string
  readStr(addr) {
    let s = '';
    while (true) {
      const c = this.read8(addr++);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  reset() {
    this.data.fill(0);
  }
}
