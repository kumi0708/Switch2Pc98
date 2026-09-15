'use strict';

// PC-98 BIOS simulation
// Installs INT vectors and handles INT calls via trap mechanism
class BIOS {
  constructor(mem, io, cpu, fdc, kbd, video) {
    this.mem   = mem;
    this.io    = io;
    this.cpu   = cpu;
    this.fdc   = fdc;
    this.kbd   = kbd;
    this.video = video;

    this._diskBuf = 0; // DMA buffer address

    // Magic address for BIOS hook: 0xF0000 onwards
    this.HOOK_BASE = 0xF0000;
    // Timer counter at BIOS data area
    this.MEM_TIMER  = 0x05C4;
    this.MEM_KBHEAD = 0x0524;
    this.MEM_KBTAIL = 0x0526;
    this.MEM_KBBUF  = 0x0502;
  }

  install() {
    // Set up interrupt vectors (4 bytes each: IP, CS)
    const setVec = (n, cs, ip) => {
      this.mem.write16(n * 4,     ip);
      this.mem.write16(n * 4 + 2, cs);
    };

    // BIOS segment = 0xF000
    const BS = 0xF000;

    // Default stubs: 0x0100 + i (1 byte IRET each)
    for (let i = 0; i < 256; i++) {
      const off = 0x0100 + i;
      this.mem.write8(this.HOOK_BASE + off, 0xCF); // IRET
      setVec(i, BS, off);
    }

    // INT 08h: Timer IRQ
    this._installHook(0x08, BS, () => {
      const cnt = this.mem.read16(this.MEM_TIMER);
      this.mem.write16(this.MEM_TIMER, (cnt + 1) & 0xFFFF);
      // EOI
      this.io.write8(0x20, 0x20);
    });

    // INT 1Ch: Timer user hook (default: IRET)
    setVec(0x1C, BS, 0x0100 + 0x1C * 2);

    // INT 1Bh: Disk BIOS
    this._installHook(0x1B, BS, () => this._int1b());

    // INT 18h: Keyboard BIOS
    this._installHook(0x18, BS, () => this._int18());

    // INT 19h: Keyboard (wait)
    this._installHook(0x19, BS, () => this._int18());

    // INT 10h: (not used on PC-98 normally, but some programs use it)
    this._installHook(0x10, BS, () => {}); // ignore

    // INT 21h: DOS interrupt (we simulate basic DOS services)
    this._installHook(0x21, BS, () => this._int21());

    // INT 20h: DOS terminate
    this._installHook(0x20, BS, () => {
      this.cpu.halted = true;
    });

    // INT 27h: TSR terminate (treat as halt)
    this._installHook(0x27, BS, () => {
      this.cpu.halted = true;
    });

    // Initialize BIOS data area
    this._initBDA();
  }

  _installHook(intNum, cs, fn) {
    // Hook stubs at 0x0300 + intNum*2 (no overlap with default stubs at 0x100-0x1FF)
    const off = 0x0300 + intNum * 2;
    this.mem.write16(intNum * 4,     off);
    this.mem.write16(intNum * 4 + 2, cs);
    this.mem.write8(this.HOOK_BASE + off,     0xF4); // HLT
    this.mem.write8(this.HOOK_BASE + off + 1, intNum & 0xFF);
    this._hooks = this._hooks || {};
    this._hooks[intNum] = fn;
  }

  _initBDA() {
    const m = this.mem;
    // Equipment flags
    m.write8(0x480, 0x11); // SYS_TYPE: 2HD drive equipped
    m.write8(0x482, 0x03); // 2 FDD
    // Keyboard buffer pointers
    m.write16(this.MEM_KBHEAD, this.MEM_KBBUF);
    m.write16(this.MEM_KBTAIL, this.MEM_KBBUF);
    // Timer counter
    m.write16(this.MEM_TIMER, 0);
    // Disk result area
    m.write8(0x584, 0x00); // MEMB_DISK_BOOT

    // Conventional memory size: 640KB
    m.write16(0x0413, 640); // standard BIOS memory size word

    // NEC copyright string (some games check this)
    const necStr = "Copyright (C) 1983 by NEC Corporation";
    for (let i = 0; i < necStr.length; i++) {
      m.write8(0xFE800 + i, necStr.charCodeAt(i));
    }
    m.write8(0xFE800 + necStr.length, 0);
  }

  // Called when CPU executes HLT at a BIOS hook address
  handleHLT() {
    const pc = this.cpu.seg2phys(this.cpu.cs, this.cpu.ip);
    const intNum = this.mem.read8(pc);
    if (this._hooks && this._hooks[intNum]) {
      this._hooks[intNum]();
      this.cpu.ip++; // skip the intNum byte
      // IRET
      this.cpu.ip    = this.cpu.pop();
      this.cpu.cs    = this.cpu.pop();
      this.cpu.flags = this.cpu.pop() | 0x0002;
      this.cpu.halted= false;
      return true;
    }
    return false;
  }

  // ── INT 1Bh: Disk BIOS ────────────────────────────────────────────
  // PC-98 calling convention:
  //   AH = function (bits 0-3) + mode flags (bit6=MFM, bit4=MT)
  //   AL = drive (bits 0-1) | flags (bit7=2HD, bit2=head select)
  //   BX = byte count for read/write
  //   CL = cylinder, CH = sector size code (N: 0=128,1=256,2=512,3=1024)
  //   DL = sector (R), DH = head
  //   ES:BP = buffer address
  _int1b() {
    const ah    = this.cpu.ah;
    const al    = this.cpu.al;
    const func  = ah & 0x0F;
    const drive = al & 0x03;
    const C     = this.cpu.cl;
    const H     = this.cpu.dh;
    const R     = this.cpu.dl;
    const N     = this.cpu.ch;
    const secSize  = 128 << Math.min(N, 3);
    const bufSize  = this.cpu.bx;
    const bufAddr  = this.cpu.seg2phys(this.cpu.es, this.cpu.bp);
    const fdi      = this.fdc.disk[drive];

    switch (func) {
      case 0x00: // Seek / Reset
        this.cpu.ah = 0; this.cpu.CF = 0;
        break;

      case 0x01: // Verify
        this.cpu.ah = 0; this.cpu.CF = 0;
        break;

      case 0x06: // Read data (normal)
      case 0x02: // Read deleted data
      {
        if (!fdi) { this.cpu.ah = 0x10; this.cpu.CF = 1; break; }
        let bytesLeft = bufSize;
        let curR  = R;
        let curC  = C;
        let curH  = H;
        let addr  = bufAddr;

        while (bytesLeft > 0) {
          const buf = new Uint8Array(secSize);
          if (!fdi.readSector(curC, curH, curR, buf)) {
            this.cpu.ah = 0x04; this.cpu.CF = 1; return;
          }
          const n = Math.min(secSize, bytesLeft);
          for (let i = 0; i < n; i++) this.mem.write8(addr + i, buf[i]);
          addr += n;
          bytesLeft -= n;
          curR++;
          if (curR > fdi.sectorsPerTrk) {
            curR = 1;
            curH ^= 1;
            if (curH === 0) curC++;
          }
        }
        if (this.video) this.video._fddActivity = Date.now();
        this.cpu.ah = 0; this.cpu.CF = 0;
        break;
      }

      case 0x05: // Write data
      {
        if (!fdi || fdi.writeProtect) { this.cpu.ah = 0x03; this.cpu.CF = 1; break; }
        let bytesLeft = bufSize;
        let curR = R;
        let curC = C;
        let curH = H;
        let addr = bufAddr;
        while (bytesLeft > 0) {
          const buf = new Uint8Array(secSize);
          const n = Math.min(secSize, bytesLeft);
          for (let i = 0; i < n; i++) buf[i] = this.mem.read8(addr + i);
          fdi.writeSector(curC, curH, curR, buf);
          addr += n; bytesLeft -= n; curR++;
          if (curR > fdi.sectorsPerTrk) { curR = 1; curH ^= 1; if (curH === 0) curC++; }
        }
        this.cpu.ah = 0; this.cpu.CF = 0;
        break;
      }

      case 0x03: // Motor on/off
      case 0x04: // Sense drive status
        this.cpu.ah = fdi ? 0x00 : 0x10;
        this.cpu.CF = fdi ? 0 : 1;
        break;

      case 0x0A: // Read ID
        if (!fdi) { this.cpu.ah = 0x10; this.cpu.CF = 1; break; }
        this.cpu.cl = C; this.cpu.dh = H; this.cpu.dl = 1; this.cpu.ch = N;
        this.cpu.ah = 0; this.cpu.CF = 0;
        break;

      case 0x0D: // Format track
        this.cpu.ah = 0; this.cpu.CF = 0;
        break;

      default:
        this.cpu.ah = 0; this.cpu.CF = 0;
        break;
    }
  }

  // ── INT 18h/19h: Keyboard BIOS ────────────────────────────────────
  _int18() {
    const ah = this.cpu.ah;
    switch (ah) {
      case 0x00: { // Read key (blocking)
        const k = (this.kbd && this.kbd._buf.length > 0) ? this.kbd._buf.shift() : null;
        if (k) {
          this.cpu.ah = k.scan;
          this.cpu.al = k.ascii;
        } else {
          this.cpu.ax = 0;
        }
        break;
      }
      case 0x01: { // Check key buffer (peek, non-destructive)
        const k = (this.kbd && this.kbd._buf.length > 0) ? this.kbd._buf[0] : null;
        if (k) {
          this.cpu.ZF = 0; // key available
          this.cpu.ah = k.scan;
          this.cpu.al = k.ascii;
        } else {
          this.cpu.ZF = 1; // no key
        }
        break;
      }
      case 0x02: // Shift state
        this.cpu.al = 0;
        break;
      case 0x04: // Sense key group: AL = group (0-15), returns AH = pressed-key bitmap
        this.cpu.ah = this.kbd ? this.kbd.senseGroup(this.cpu.al) : 0;
        break;
      case 0x03: case 0x05: case 0x06: case 0x07:
      case 0x08: case 0x09: case 0x0A: case 0x0B: case 0x0C:
      case 0x0D: case 0x0E: case 0x0F: case 0x10: case 0x11:
      case 0x12: case 0x13: // CRT/keyboard setup - return clean state
        this.cpu.bh = 0; // indicate buffer empty / done
        this.cpu.CF = 0;
        break;
    }
  }

  // ── INT 21h: DOS services ─────────────────────────────────────────
  _int21() {
    const ah = this.cpu.ah;
    switch (ah) {
      case 0x00: // Terminate program
        this.cpu.halted = true;
        break;

      case 0x01: { // Read character from stdin
        const k = (this.kbd && this.kbd._buf.length > 0) ? this.kbd._buf.shift() : null;
        this.cpu.al = k ? (k.ascii & 0x7F) : 0;
        break;
      }

      case 0x02: // Write character to stdout (DL)
        break; // ignore

      case 0x06: // Direct console I/O
        if (this.cpu.dl === 0xFF) {
          // input request
          this.cpu.al = 0;
          this.cpu.ZF = 1;
        }
        break;

      case 0x07: case 0x08: // Read key without echo
        this.cpu.al = 0;
        break;

      case 0x09: { // Print string (DS:DX, $-terminated)
        let addr = this.cpu.seg2phys(this.cpu.ds, this.cpu.dx);
        while (true) {
          const c = this.mem.read8(addr++);
          if (c === 0x24 || !c) break;
        }
        break;
      }

      case 0x0A: // Buffered input
        break;

      case 0x0B: // Check stdin status
        this.cpu.al = 0;
        break;

      case 0x0C: // Flush + read
        this.cpu.al = 0;
        break;

      case 0x19: // Get current drive
        this.cpu.al = 0; // A:
        break;

      case 0x1A: { // Set DTA (DS:DX)
        this._dta = this.cpu.seg2phys(this.cpu.ds, this.cpu.dx);
        break;
      }

      case 0x25: { // Set interrupt vector (AL=int, DS:DX=handler)
        this.mem.write16(this.cpu.al * 4,     this.cpu.dx);
        this.mem.write16(this.cpu.al * 4 + 2, this.cpu.ds);
        break;
      }

      case 0x2A: // Get date
        this.cpu.cx = 1992; this.cpu.dh = 1; this.cpu.dl = 1;
        this.cpu.al = 3; // Wednesday
        break;

      case 0x2C: // Get time
        this.cpu.ch = 12; this.cpu.cl = 0;
        this.cpu.dh = 0;  this.cpu.dl = 0;
        break;

      case 0x2F: { // Get DTA
        const dta = this._dta || 0x80;
        this.cpu.es = (dta >> 4) & 0xF000;
        this.cpu.bx = dta & 0xFFFF;
        break;
      }

      case 0x30: // Get DOS version
        this.cpu.al = 3; this.cpu.ah = 30; // 3.30
        this.cpu.bh = 0xFF; // PC-98 DOS
        break;

      case 0x35: { // Get interrupt vector
        this.cpu.es = this.mem.read16(this.cpu.al * 4 + 2);
        this.cpu.bx = this.mem.read16(this.cpu.al * 4);
        break;
      }

      case 0x3C: case 0x3D: case 0x3E: // File operations - stub
        this.cpu.ax = 0;
        this.cpu.CF = 0;
        break;

      case 0x3F: { // Read file
        this.cpu.ax = 0;
        this.cpu.CF = 0;
        break;
      }

      case 0x40: { // Write file
        this.cpu.ax = this.cpu.cx;
        this.cpu.CF = 0;
        break;
      }

      case 0x41: case 0x43: case 0x45: case 0x46: // File misc
        this.cpu.ax = 0;
        this.cpu.CF = 0;
        break;

      case 0x47: { // Get current directory
        this.mem.write8(this.cpu.seg2phys(this.cpu.ds, this.cpu.si), 0);
        this.cpu.CF = 0;
        break;
      }

      case 0x48: { // Allocate memory (BX = paragraphs)
        // Simple bump allocator starting at 0x2000
        if (!this._heapTop) this._heapTop = 0x2000;
        this.cpu.ax = this._heapTop;
        this._heapTop = (this._heapTop + this.cpu.bx) & 0xFFFF;
        this.cpu.CF = 0;
        break;
      }

      case 0x49: // Free memory
        this.cpu.CF = 0;
        break;

      case 0x4A: { // Modify memory block (SETBLOCK)
        this.cpu.CF = 0;
        break;
      }

      case 0x4B: { // Load and execute program (EXEC) - stub
        this.cpu.ax = 0x08; // not found
        this.cpu.CF = 1;
        break;
      }

      case 0x4C: // Terminate with return code
        this.cpu.halted = true;
        break;

      case 0x4D: // Get return code
        this.cpu.ax = 0;
        break;

      case 0x54: // Get verify flag
        this.cpu.al = 0;
        break;

      default:
        this.cpu.ax = 0x01; // function not implemented
        this.cpu.CF = 1;
        break;
    }
  }

  reset() {
    this._hooks = {};
    this._dta   = 0;
    this._heapTop= 0x2000;
    this.install();
  }
}
