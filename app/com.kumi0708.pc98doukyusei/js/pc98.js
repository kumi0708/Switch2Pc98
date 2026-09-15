'use strict';

// PC-98 System Integration
class PC98 {
  constructor(canvas) {
    this.mem   = new Memory();
    this.io    = new IO();
    this.cpu   = new CPU(this.mem, this.io);
    this.pic   = new PIC(this.io, this.cpu);
    this.pit   = new PIT(this.io, this.pic);
    this.fdc   = new FDC(this.io, this.pic, this.mem);
    this.video = new Video(canvas, this.mem, this.io);
    this.kbd   = new Keyboard(this.io, this.pic);
    this.mouse = new Mouse(this.io);
    this.bios  = new BIOS(this.mem, this.io, this.cpu, this.fdc, this.kbd, this.video);

    this.kbd.setMem(this.mem);
    this.video.getCycles = () => this.cpu.totalCycles;
    this._mouseCycles = 0;
    this._vsyncCycles = 0;
    this._running  = false;
    this._rafId    = null;
    this._frameCount = 0;
    this._lastFPS  = 0;
    this._lastTime = 0;
    this._speedMultiplier = 1.0;

    this._setupMemoryMap();
    this._setupDMA();
    this.reset();
  }

  _setupMemoryMap() {
    const mem = this.mem;
    const video = this.video;

    // Intercept GVRAM reads/writes (A8000-BFFFF)
    const origRead8  = mem.read8.bind(mem);
    const origWrite8 = mem.write8.bind(mem);

    mem.read8 = (addr) => {
      addr &= 0xFFFFF;
      if ((addr >= 0xA8000 && addr < 0xC0000) || (addr >= 0xE0000 && addr < 0xE8000)) {
        return video.readGVRAM(addr);
      }
      return origRead8(addr);
    };

    mem.write8 = (addr, val) => {
      addr &= 0xFFFFF;
      val &= 0xFF;
      if ((addr >= 0xA8000 && addr < 0xC0000) || (addr >= 0xE0000 && addr < 0xE8000)) {
        origWrite8(addr, val);
        video.writeGVRAM(addr, val);
        return;
      }
      origWrite8(addr, val);
    };

    mem.read16 = (addr) => {
      return mem.read8(addr) | (mem.read8(addr + 1) << 8);
    };
    mem.write16 = (addr, val) => {
      mem.write8(addr, val & 0xFF);
      mem.write8(addr + 1, (val >> 8) & 0xFF);
    };
  }

  _setupDMA() {
    const io = this.io;
    const fdc = this.fdc;

    // DMA registers (simplified)
    // PC-98 DMA for FDD: channel 2
    // PC-98 8237A sits on ODD ports 0x01-0x1F (even ports belong to the PICs)
    const dmaState = {
      addr: [0, 0, 0, 0],
      count: [0, 0, 0, 0],
      page: [0, 0, 0, 0],
      lowByte: [true, true, true, true],
    };

    // DMA address/count ports: ch addr = 0x01+ch*4, ch count = 0x03+ch*4
    for (let ch = 0; ch < 4; ch++) {
      const c = ch;
      io.register(0x01 + c * 4, () => dmaState.addr[c] & 0xFF, (p, v) => {
        if (dmaState.lowByte[c]) { dmaState.addr[c] = (dmaState.addr[c] & 0xFF00) | v; dmaState.lowByte[c] = false; }
        else {
          dmaState.addr[c] = (dmaState.addr[c] & 0x00FF) | (v << 8); dmaState.lowByte[c] = true;
          fdc.setDMA((dmaState.page[c] << 16) | dmaState.addr[c], dmaState.count[c]);
        }
      });
      io.register(0x03 + c * 4, () => dmaState.count[c] & 0xFF, (p, v) => {
        if (dmaState.lowByte[c]) { dmaState.count[c] = (dmaState.count[c] & 0xFF00) | v; dmaState.lowByte[c] = false; }
        else {
          dmaState.count[c] = (dmaState.count[c] & 0x00FF) | (v << 8); dmaState.lowByte[c] = true;
          if (c === 2) fdc.setDMA((dmaState.page[c] << 16) | dmaState.addr[c], dmaState.count[c]);
        }
      });
    }

    // DMA control ports: 0x19 = flip-flop reset (resets low/high byte toggle)
    io.register(0x11, null, (p,v) => {});
    io.register(0x13, null, (p,v) => {});
    io.register(0x15, null, (p,v) => {});
    io.register(0x17, null, (p,v) => {}); // mask register
    io.register(0x19, null, (p,v) => { dmaState.lowByte.fill(true); }); // flip-flop reset
    io.register(0x1D, null, (p,v) => {});
    io.register(0x1F, null, (p,v) => {});

    // DMA page registers: page written separately, must also trigger setDMA
    // (game may write page AFTER address hi-byte, so re-sync when page changes)
    io.register(0x1B, null, (p,v) => {
      dmaState.page[2] = v;
      fdc.setDMA((dmaState.page[2] << 16) | dmaState.addr[2], dmaState.count[2]);
    });
    io.register(0x27, null, (p,v) => {});

    // PIC ports
    // (Already registered in PIC constructor)

    // System I/O (misc)
    io.register(0x0F0, null, (p,v) => {}); // coprocessor
    io.register(0x0F2, null, (p,v) => {});
    io.register(0x9C,  null, (p,v) => {}); // NMI mask
    io.register(0x9E,  null, (p,v) => {}); // wait

    // Sound (OPN: YM2608) - stub
    io.register(0x88, () => 0, (p,v) => {}); // OPN address
    io.register(0x8A, () => 0, (p,v) => {}); // OPN data
    io.register(0x188, () => 0, (p,v) => {}); // OPNA (86 board) address
    io.register(0x18A, () => 0, (p,v) => {}); // OPNA data
    io.register(0x18C, () => 0, (p,v) => {});
    io.register(0x18E, () => 0, (p,v) => {});

    // Calendar (not critical)
    io.register(0x20, () => 0x20, null); // already handled by PIC
    io.register(0x70, () => 0, (p,v) => {});
    io.register(0x71, null, null); // already handled by PIT (but may conflict)

    // Mouse interrupt interval timer
    io.register(0xBFDB, null, (p,v) => {});

    // Misc system ports
    io.register(0x30, () => 0, (p,v) => {}); // ?
    io.register(0x32, null, (p,v) => {}); // BEEP
    io.register(0x33, () => 0, null);
    io.register(0x37, () => 0, null);
    io.register(0x4A, () => 0x80, null); // EMS?
    io.register(0x43D, null, (p,v) => {}); // kbd mode
    io.register(0x43F, () => 0, null);
  }

  // Mount FDI image
  mountDisk(driveNo, fdi) {
    const hadDisk = !!this.fdc.disk[driveNo];
    this.fdc.mount(driveNo, fdi);
    // Disk change while running: simulate the FDC "attention" sequence.
    // The BIOS IRQ11 handler sets bit3 of the work-area status byte
    // (0:0x564 + drive*8); ELFDOS chains INT 13h (vector) and reads it to
    // set its own disk-change flags.
    if (hadDisk) {
      const addr = 0x564 + (driveNo & 3) * 8;
      this.mem.write8(addr, this.mem.read8(addr) | 0x08);
      this.cpu.requestInterrupt(0x13);
    }
  }

  reset() {
    this.mem.reset();
    this.cpu.reset();
    this.pic.reset();
    this.pit.reset();
    this.fdc.reset();
    this.video.reset();
    this.kbd.reset();
    this.mouse.reset();

    // Re-install BIOS after memory reset
    this.bios.install();

    // Boot: load first track from FDD0 into memory and jump to it
    this._bootFromFloppy();
  }

  _bootFromFloppy() {
    const fdi = this.fdc.disk[0];
    if (!fdi) return;

    // PC-98 IPL: load only sector 1 (1024 bytes for 2HD) at physical 0x1FC00
    // bootseg = 0x1FC00 >> 4 = 0x1FC0
    const BOOT_PHYS = 0x1FC00;
    const BOOT_SEG  = 0x1FC0;

    const buf = new Uint8Array(fdi.sectorSize);
    if (fdi.readSector(0, 0, 1, buf)) {
      this.mem.load(BOOT_PHYS, buf);
    }

    // CPU starts at bootseg:0000
    this.cpu.cs = BOOT_SEG;
    this.cpu.ip = 0x0000;
    this.cpu.ds = BOOT_SEG;
    this.cpu.es = 0x0000;
    this.cpu.ss = BOOT_SEG;
    this.cpu.sp = 0xFFFE;

    this.bios._dta = 0x80;
    this.mem.write8(0x480, 0x11);
    this.mem.write8(0x482, 0x03);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._loop();
  }

  stop() {
    this._running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _loop() {
    if (!this._running) return;

    const now = performance.now();
    // Target 10MHz: 10,000 cycles per ms
    const CYCLES_PER_MS = 10000;
    const MAX_DELTA_MS = 20; // cap to avoid spiral-of-death after tab switch

    if (this._lastTime === 0) this._lastTime = now;
    const elapsed = Math.min(now - this._lastTime, MAX_DELTA_MS);
    this._lastTime = now;

    const cyclesToRun = Math.floor(elapsed * CYCLES_PER_MS * this._speedMultiplier);

    let cycles = 0;
    while (cycles < cyclesToRun) {
      if (this.cpu.halted) {
        if (!this.bios.handleHLT()) break;
      }
      const c = this.cpu.step();
      cycles += c;
      this.tickDevices(c);
    }

    this.video.render();
    this._frameCount++;

    if (now - this._lastFPS >= 1000) {
      if (this.onFPS) this.onFPS(this._frameCount);
      this._frameCount = 0;
      this._lastFPS = now;
    }

    this._rafId = requestAnimationFrame(() => this._loop());
  }

  // Advance time-based devices by c CPU cycles
  tickDevices(c) {
    this.pit.tick(c);
    // Mouse interrupt: IRQ13 (slave IR5) at ~120Hz (10MHz / 120 ≈ 83333 cycles)
    this._mouseCycles += c;
    if (this._mouseCycles >= 83333) {
      this._mouseCycles -= 83333;
      this.pic.raise(13);
    }
    // CRT VSYNC interrupt: IRQ2 at ~56.4Hz (matches video frame period)
    this._vsyncCycles += c;
    if (this._vsyncCycles >= 177240) {
      this._vsyncCycles -= 177240;
      this.pic.raise(2);
    }
  }

  onKeyDown(e) { this.kbd.onKeyDown(e); }
  onKeyUp(e)   { this.kbd.onKeyUp(e);   }
}
