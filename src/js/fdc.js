'use strict';

// NEC µPD765A Floppy Disk Controller
// PC-98 ports: 0x90 (status), 0x92 (data), 0x94 (motor control)
class FDC {
  constructor(io, pic, mem) {
    this.pic  = pic;
    this.mem  = mem;
    this.disk = [null, null]; // FDI images for drive 0 and 1

    this._msr  = 0x80; // Main Status Register (RQM=1, ready)
    this._cmd  = [];   // command bytes
    this._res  = [];   // result bytes
    this._state= 'idle'; // 'idle','cmd','exec','result'
    this._buf  = new Uint8Array(1024);

    // Track/head/sector for DMA transfer
    this._C = 0; this._H = 0; this._R = 0; this._N = 0;
    this._drive  = 0;
    this._motor  = [false, false];
    this._dmaAddr= 0;
    this._dmaCount=0;
    this._intPending = false;

    io.register(0x90, () => this._readMSR(), null);
    io.register(0x92, () => this._readData(), (p,v) => this._writeData(v));
    io.register(0x94, null, (p,v) => this._writeMotor(v));
    io.register(0xBE, null, (p,v) => {}); // density select (ignore)
    io.register(0x4BE, null, (p,v) => {}); // FDD wait
  }

  mount(driveNo, fdi) {
    this.disk[driveNo] = fdi;
  }

  _readMSR() {
    let msr = 0x80; // RQM
    if (this._state === 'result' && this._res.length > 0) msr |= 0x40; // DIO=1 (output)
    if (this._state === 'cmd')    msr |= 0x10; // FDC busy
    if (this._state === 'exec')   msr |= 0x20; // exec phase
    return msr;
  }

  _readData() {
    if (this._state === 'result' && this._res.length > 0) {
      const b = this._res.shift();
      if (this._res.length === 0) {
        this._state = 'idle';
      }
      return b;
    }
    return 0;
  }

  _writeData(v) {
    if (this._state === 'idle' || this._state === 'cmd') {
      this._state = 'cmd';
      this._cmd.push(v);
      this._tryExecute();
    }
  }

  _writeMotor(v) {
    // bit0=drive0 motor, bit1=drive1 motor, bit2=drive select, bit4=?
    this._motor[0] = !!(v & 0x01);
    this._motor[1] = !!(v & 0x02);
    this._drive = (v >> 4) & 1;
  }

  _tryExecute() {
    if (!this._cmd.length) return;
    const cmd = this._cmd[0] & 0x1F;

    // Detect complete command
    const cmdLen = {
      0x03: 3, // Specify
      0x04: 2, // Sense Drive Status
      0x07: 2, // Recalibrate
      0x08: 1, // Sense Interrupt
      0x0F: 3, // Seek
      0x02: 9, // Read Track
      0x05: 9, // Write Data
      0x06: 9, // Read Data
      0x09: 9, // Write Deleted Data
      0x0A: 2, // Read ID
      0x0C: 9, // Read Deleted Data
      0x0D: 6, // Format Track
      0x11: 9, // Scan Equal
      0x19: 9, // Scan Low
      0x1D: 9, // Scan High
    };

    const needed = cmdLen[cmd] || 1;
    if (this._cmd.length < needed) return;

    this._state = 'exec';
    this._execute();
    this._cmd = [];
  }

  _execute() {
    const cmd = this._cmd[0] & 0x1F;
    const mt  = !!(this._cmd[0] & 0x80);
    const mfm = !!(this._cmd[0] & 0x40);

    switch (cmd) {
      case 0x03: // Specify
        this._state = 'idle'; return;

      case 0x04: // Sense Drive Status
        this._res = [0x28]; // ready, two-sided, disk present
        this._state = 'result'; return;

      case 0x07: // Recalibrate
        this._C = 0;
        this._sendInterrupt();
        this._state = 'idle'; return;

      case 0x08: // Sense Interrupt Status
        this._res = [0x20 | this._drive, this._C];
        this._state = 'result';
        this._intPending = false; return;

      case 0x0F: // Seek
        this._drive = this._cmd[1] & 3;
        this._C = this._cmd[2];
        this._sendInterrupt();
        this._state = 'idle'; return;

      case 0x06: case 0x0C: // Read Data / Read Deleted Data
        this._doRead(); return;

      case 0x05: case 0x09: // Write Data / Write Deleted Data
        this._doWrite(); return;

      case 0x0A: // Read ID
        this._res = [0x00, 0x00, this._C, this._H, 0x01, 0x03, 0x08, 0x00];
        this._sendInterrupt();
        this._state = 'result'; return;

      case 0x0D: // Format Track
        this._state = 'idle'; return;

      default:
        this._state = 'idle'; return;
    }
  }

  _doRead() {
    const drv = this._cmd[1] & 3;
    const C   = this._cmd[2];
    const H   = this._cmd[3];
    const R   = this._cmd[4];
    const N   = this._cmd[5];
    const EOT = this._cmd[6];
    const fdi = this.disk[drv];

    this._C = C; this._H = H; this._R = R;

    if (!fdi) {
      this._res = [0x40, 0x00, C, H, R, N];
      this._state = 'result';
      return;
    }

    const sectorSize = 128 << N; // N=3 → 1024
    const buf = new Uint8Array(sectorSize);

    // Read sectors R through EOT (real FDC multi-sector transfer).
    // Cap by DMA count so we never overflow the programmed buffer.
    const maxBytes = this._dmaCount > 0 ? this._dmaCount + 1 : sectorSize;
    let transferred = 0;
    let curR = R;
    while (curR <= EOT && transferred + sectorSize <= maxBytes) {
      const ok = fdi.readSector(C, H, curR, buf);
      if (!ok) {
        this._res = [0x40, 0x04, C, H, curR, N];
        this._state = 'result';
        return;
      }
      for (let i = 0; i < sectorSize; i++) {
        this.mem.write8(this._dmaAddr + i, buf[i]);
      }
      this._dmaAddr += sectorSize;
      transferred  += sectorSize;
      curR++;
    }

    // Status: next sector number (or EOT+1)
    this._res = [0x00, 0x00, C, H, curR, N];
    this._sendInterrupt();
    this._state = 'result';
  }

  _doWrite() {
    const drv = this._cmd[1] & 3;
    const C   = this._cmd[2];
    const H   = this._cmd[3];
    const R   = this._cmd[4];
    const N   = this._cmd[5];
    const fdi = this.disk[drv];

    if (!fdi || fdi.writeProtect) {
      this._res = [0x40, 0x02, C, H, R, N];
      this._state = 'result';
      return;
    }

    const sectorSize = 128 << N;
    const buf = new Uint8Array(sectorSize);
    const dmaAddr = this._dmaAddr;
    for (let i = 0; i < sectorSize; i++) {
      buf[i] = this.mem.read8(dmaAddr + i);
    }
    fdi.writeSector(C, H, R, buf);
    this._dmaAddr += sectorSize;

    this._res = [0x00, 0x00, C, H, R+1, N];
    this._sendInterrupt();
    this._state = 'result';
  }

  _sendInterrupt() {
    this._intPending = true;
    this.pic.raise(6); // IRQ6 → FDC
  }

  setDMA(addr, count) {
    this._dmaAddr  = addr;
    this._dmaCount = count;
  }

  reset() {
    this._cmd = [];
    this._res = [];
    this._state = 'idle';
    this._intPending = false;
  }
}
