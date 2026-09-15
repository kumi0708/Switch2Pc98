'use strict';

// PC-98 Video System
// - Text VRAM:  0xA0000-0xA3FFF (character codes + attributes, 80×25)
// - GVRAM:      0xA8000-0xBFFFF (4 planes, 640×400 pixels)
// - CRT controller at 0xC0-0xCF, 0xD0-0xD5
class Video {
  // Optional pre-rendered CG ROM bytes (Uint8Array); null = rasterize via canvas font
  static cgrom = null;

  constructor(canvas, mem, io) {
    this.mem    = mem;
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.imgData= this.ctx.createImageData(640, 400);

    // GVRAM: 4 planes × 2 pages. Each page is a 32KB window (640×400/8 = 32000
    // bytes used); page 1 lives at offset 0x8000 within each plane array.
    // Port 0xA6 selects the CPU-access page, 0xA4 the displayed page.
    this.plane  = [
      new Uint8Array(65536), // Blue  (plane 0)
      new Uint8Array(65536), // Red   (plane 1)
      new Uint8Array(65536), // Green (plane 2)
      new Uint8Array(65536), // Intensity (plane 3)
    ];
    this._dispPage = 0; // port 0xA4: displayed page
    this._accPage  = 0; // port 0xA6: CPU access page

    // Text VRAM maps
    // PC-98 text: 0xA0000-0xA1FFF = character codes (word-addressed, 80 cols × 25 rows)
    //             0xA2000-0xA3FFF = attributes
    // Each text cell: code at A0000 + (row*80+col)*2, attr at A2000 + same

    this._grcgMode   = 0;     // port 0x7C: bit7=on, bit6=TDW/RMW, bits0-3=plane protect
    this._grcgTile   = new Uint8Array(4);
    this._grcgTileIdx= 0;
    this._palette    = new Uint32Array(16); // canvas Uint32 (0xAABBGGRR)
    this._initPalette();

    this._mode16     = true;  // 16-color mode (port 0x6A bit0)
    this._palIdx     = 0;
    this._palR = new Uint8Array(16);
    this._palG = new Uint8Array(16);
    this._palB = new Uint8Array(16);

    // Cycle source for VSYNC timing (injected by pc98.js); fallback counter
    this.getCycles = null;
    this._statusReads = 0;

    // GDC status (text 0x60, graphics 0xA0): bit5=VSYNC, bit2=FIFO empty
    const gdcStatus = () => 0x04 | (this._vsyncActive() ? 0x20 : 0);
    io.register(0x60, gdcStatus, (p,v) => {});  // text GDC param/status
    io.register(0x62, () => 0x04, (p,v) => {}); // text GDC command
    io.register(0xA0, gdcStatus, (p,v) => {});  // graphics GDC param/status
    io.register(0xA2, () => 0x04, (p,v) => {}); // graphics GDC command
    io.register(0x64, null, (p,v) => {});       // CRT interrupt reset

    // Mode flip-flops
    io.register(0x68, null, (p,v) => {});
    io.register(0x6A, null, (p,v) => { if (v === 0x01) this._mode16 = true; else if (v === 0x00) this._mode16 = false; });

    // GRCG: mode 0x7C, tile 0x7E
    io.register(0x7C, () => this._grcgMode, (p,v) => { this._grcgMode = v; this._grcgTileIdx = 0; });
    io.register(0x7E, null, (p,v) => { this._grcgTile[this._grcgTileIdx] = v; this._grcgTileIdx = (this._grcgTileIdx + 1) & 3; });

    // Page select: 0xA4 = displayed page, 0xA6 = CPU access page
    io.register(0xA4, () => this._dispPage, (p,v) => { this._dispPage = v & 1; this._dirty = true; });
    io.register(0xA6, () => this._accPage,  (p,v) => { this._accPage  = v & 1; });

    // CG ROM (kanji font) access: 0xA1=JIS 2nd byte-0x20, 0xA3=JIS 1st byte-0x20,
    // 0xA5=line select (bit5: 0=left half, 1=right half), 0xA9=font data
    this._cgLo = 0; this._cgHi = 0; this._cgLine = 0;
    this._cgCache = new Map();
    io.register(0xA1, () => this._cgLo, (p,v) => { this._cgLo = v; });
    io.register(0xA3, () => this._cgHi, (p,v) => { this._cgHi = v; });
    io.register(0xA5, () => this._cgLine, (p,v) => { this._cgLine = v; });
    io.register(0xA9, () => this._readCG(), (p,v) => {});

    // Analog palette: 0xA8=index, 0xAA=green, 0xAC=red, 0xAE=blue (4-bit each)
    io.register(0xA8, () => this._palIdx, (p,v) => { this._palIdx = v & 0x0F; });
    io.register(0xAA, () => this._palG[this._palIdx], (p,v) => { this._palG[this._palIdx] = v & 0x0F; this._updatePalette(this._palIdx); });
    io.register(0xAC, () => this._palR[this._palIdx], (p,v) => { this._palR[this._palIdx] = v & 0x0F; this._updatePalette(this._palIdx); });
    io.register(0xAE, () => this._palB[this._palIdx], (p,v) => { this._palB[this._palIdx] = v & 0x0F; this._updatePalette(this._palIdx); });

    // EGC (Enhanced Graphic Controller) at 0x4A0-0x4AE (16-bit registers)
    // Used for hardware-accelerated VRAM blits (bit-aligned copy, ROP, pattern fill, etc.)
    this._egcRegs = new Uint16Array(8);   // 0x4A0,4A2,4A4,4A6,4A8,4AA,4AC,4AE
    this._egcLatch= new Uint8Array(4);    // 4-plane read latch
    this._egcEnabled = false;
    this._egcLogCount = 0;
    for (let i = 0; i < 8; i++) {
      const regIdx = i;
      const port = 0x4A0 + i * 2;
      io.register(port,
        () => this._egcRegs[regIdx] & 0xFF,
        (p, v) => {
          this._egcRegs[regIdx] = (this._egcRegs[regIdx] & 0xFF00) | v;
          this._egcOnWrite(regIdx);
        });
      io.register(port + 1,
        () => (this._egcRegs[regIdx] >> 8) & 0xFF,
        (p, v) => {
          this._egcRegs[regIdx] = (this._egcRegs[regIdx] & 0x00FF) | (v << 8);
          this._egcOnWrite(regIdx);
        });
    }

    // 8-color digital palette
    this._digitalPal = [
      0xFF000000, 0xFF0000AA, 0xFF00AA00, 0xFF00AAAA,
      0xFFAA0000, 0xFFAA00AA, 0xFFAA5500, 0xFFAAAAAA,
      0xFF555555, 0xFF5555FF, 0xFF55FF55, 0xFF55FFFF,
      0xFFFF5555, 0xFFFF55FF, 0xFFFFFF55, 0xFFFFFFFF,
    ];
    this._palette.set(this._digitalPal);

    // Font ROM (16x16 kanji or 8x16 ANK)
    this._font = null;
    this._buildDefaultFont();

    // VRAM write intercept
    this._setupVRAMHooks();

    this._showText = true;
    this._showGraph= true;
    this._dirty    = true;
  }

  // Called whenever an EGC register is written
  _egcOnWrite(regIdx) {
    // reg[0]=0x4A0: access control; if any write → EGC is being used
    if (regIdx === 0) {
      const was = this._egcEnabled;
      this._egcEnabled = (this._egcRegs[0] !== 0);
      if (!was && this._egcEnabled && this._egcLogCount < 20) {
        this._egcLogCount++;
        const regs = Array.from(this._egcRegs).map(r => '0x'+r.toString(16).padStart(4,'0'));
        console.log('[EGC] enabled, regs:', regs.join(' '));
      }
    }
  }

  // Debug: return per-plane statistics (call from browser console: pc98.video.debugPlanes())
  debugPlanes() {
    const r = {};
    for (let pg = 0; pg < 2; pg++) {
      for (let p = 0; p < 4; p++) {
        let nonZero = 0, sum = 0;
        const base = pg << 15;
        for (let i = 0; i < 32000; i++) { const v = this.plane[p][base + i]; if (v) nonZero++; sum = (sum + v) & 0xFFFF; }
        r[`pg${pg}p${p}`] = { nonZero, sum: '0x'+sum.toString(16) };
      }
    }
    console.log('VRAM planes:', JSON.stringify(r), 'disp=', this._dispPage, 'acc=', this._accPage);
    return r;
  }

  _initPalette() {
    this._palette.set([
      0xFF000000, 0xFF0000AA, 0xFF00AA00, 0xFF00AAAA,
      0xFFAA0000, 0xFFAA00AA, 0xFFAA5500, 0xFFAAAAAA,
      0xFF555555, 0xFF5555FF, 0xFF55FF55, 0xFF55FFFF,
      0xFFFF5555, 0xFFFF55FF, 0xFFFFFF55, 0xFFFFFFFF,
    ]);
  }

  // VSYNC simulation: ~56.4Hz frame = ~177240 CPU cycles at 10MHz.
  // VSYNC active during the last ~4% of each frame.
  _vsyncActive() {
    if (this.getCycles) {
      const pos = this.getCycles() % 177240;
      return pos >= 170000;
    }
    // Fallback: toggle pattern so polling loops always see both edges
    this._statusReads++;
    return (this._statusReads % 16) >= 13;
  }

  // CG ROM read: returns one byte of the current glyph row
  // Line register bit5: 1 = LEFT half (high bits), 0 = RIGHT half (low bits)
  _readCG() {
    const g = this._getGlyph();
    const row = this._cgLine & 0x0F;
    const w = g[row];
    // ANK (8-dot) glyphs live in the high byte regardless of half select
    if ((this._cgHi & 0x7F) === 0) return (w >> 8) & 0xFF;
    const left = !!(this._cgLine & 0x20);
    return left ? ((w >> 8) & 0xFF) : (w & 0xFF);
  }

  // Rasterize the glyph for the current CG code (16×16, Uint16Array of rows)
  _getGlyph() {
    const key = ((this._cgHi & 0xFF) << 8) | (this._cgLo & 0xFF);
    let g = this._cgCache.get(key);
    if (g) return g;
    g = new Uint16Array(16);

    let ch = null;
    // CG code format: 0xA3 = JIS 1st byte - 0x20, 0xA1 = JIS 2nd byte (raw)
    const j1 = (this._cgHi & 0x7F) + 0x20;
    const j2 = this._cgLo & 0x7F;

    // Pre-rendered CG ROM (cgrom.bin, see tools/gen_cgrom.py). Used on
    // runtimes without a Japanese canvas font / TextDecoder('shift_jis').
    const rom = Video.cgrom;
    if (rom) {
      if ((this._cgHi & 0x7F) === 0) {
        const base = (this._cgLo & 0xFF) * 16;
        for (let y = 0; y < 16; y++) g[y] = rom[base + y] << 8;
      } else if (j1 >= 0x21 && j1 <= 0x7E && j2 >= 0x21 && j2 <= 0x7E) {
        const base = 4096 + ((j1 - 0x21) * 94 + (j2 - 0x21)) * 32;
        for (let y = 0; y < 16; y++) g[y] = (rom[base + y * 2] << 8) | rom[base + y * 2 + 1];
      }
      this._cgCache.set(key, g);
      return g;
    }
    try {
      if ((this._cgHi & 0x7F) === 0) {
        // ANK (8×16): code = low byte
        const c = this._cgLo & 0xFF;
        if (c >= 0xA1 && c <= 0xDF) ch = String.fromCharCode(0xFF61 + c - 0xA1); // halfwidth kana
        else if (c >= 0x20 && c < 0x7F) ch = String.fromCharCode(c);
      } else {
        // Kanji: JIS → Shift_JIS → Unicode
        const s1 = ((j1 + 1) >> 1) + (j1 < 0x5F ? 0x70 : 0xB0);
        const s2 = j2 + ((j1 & 1) ? (j2 < 0x60 ? 0x1F : 0x20) : 0x7E);
        ch = new TextDecoder('shift_jis').decode(new Uint8Array([s1, s2]));
      }
    } catch (e) { ch = null; }

    if (ch && typeof document !== 'undefined') {
      // Browser: render with a Japanese monospace font
      if (!this._cgCanvas) {
        this._cgCanvas = document.createElement('canvas');
        this._cgCanvas.width = 16; this._cgCanvas.height = 16;
      }
      const cx = this._cgCanvas.getContext('2d', { willReadFrequently: true });
      cx.clearRect(0, 0, 16, 16);
      cx.fillStyle = '#fff';
      cx.font = '16px "MS Gothic", "Osaka-Mono", monospace';
      cx.textBaseline = 'top';
      cx.fillText(ch, 0, 0);
      const d = cx.getImageData(0, 0, 16, 16).data;
      for (let y = 0; y < 16; y++) {
        let row = 0;
        for (let x = 0; x < 16; x++) {
          if (d[(y * 16 + x) * 4 + 3] > 96) row |= 0x8000 >> x;
        }
        g[y] = row;
      }
    } else if (ch) {
      // Headless fallback: distinct box pattern per glyph
      g[1] = 0x7FFE; g[14] = 0x7FFE;
      let h = (key * 2654435761) >>> 0;
      for (let y = 2; y < 14; y++) {
        g[y] = 0x4002 | (h & 0x0FF0);
        h = (h * 16807 + 7) >>> 0;
      }
    }
    this._cgCache.set(key, g);
    return g;
  }

  _updatePalette(i) {
    const r = this._palR[i] * 17, g = this._palG[i] * 17, b = this._palB[i] * 17;
    this._palette[i] = 0xFF000000 | (b << 16) | (g << 8) | r;
    this._dirty = true;
  }

  _buildDefaultFont() {
    // Build an 8×16 ASCII font
    // Using a minimal built-in bitmap font
    this._font = new Uint8Array(256 * 16);
    const glyphs = [
      // Space (0x20)
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      // ! (0x21)
      [0,0x18,0x18,0x18,0x18,0x18,0x18,0x00,0x18,0x18,0,0,0,0,0,0],
    ];
    // Fill in basic font data for printable chars
    // Using a simple 5x7 style font encoded as 8 bytes
    this._fillFont();
  }

  _fillFont() {
    // Basic 8x16 font for ASCII 0x20-0x7E
    // We encode each character as 16 bytes (rows), each byte = 8 pixels
    const data = this._font;

    // Helper: set glyph
    const sg = (c, rows) => {
      const base = c * 16;
      for (let i = 0; i < 16; i++) data[base + i] = rows[i] || 0;
    };

    // Numbers
    sg(0x30,[0,0x3C,0x66,0x6E,0x76,0x66,0x66,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x31,[0,0x18,0x38,0x18,0x18,0x18,0x18,0x18,0x7E,0,0,0,0,0,0,0]);
    sg(0x32,[0,0x3C,0x66,0x06,0x0C,0x18,0x30,0x60,0x7E,0,0,0,0,0,0,0]);
    sg(0x33,[0,0x3C,0x66,0x06,0x1C,0x06,0x06,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x34,[0,0x0C,0x1C,0x2C,0x4C,0x7E,0x0C,0x0C,0x0C,0,0,0,0,0,0,0]);
    sg(0x35,[0,0x7E,0x60,0x60,0x7C,0x06,0x06,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x36,[0,0x1C,0x30,0x60,0x7C,0x66,0x66,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x37,[0,0x7E,0x06,0x0C,0x18,0x18,0x18,0x18,0x18,0,0,0,0,0,0,0]);
    sg(0x38,[0,0x3C,0x66,0x66,0x3C,0x66,0x66,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x39,[0,0x3C,0x66,0x66,0x66,0x3E,0x06,0x0C,0x38,0,0,0,0,0,0,0]);
    // Uppercase letters
    sg(0x41,[0,0x18,0x3C,0x66,0x66,0x7E,0x66,0x66,0x66,0,0,0,0,0,0,0]);
    sg(0x42,[0,0x7C,0x66,0x66,0x7C,0x66,0x66,0x66,0x7C,0,0,0,0,0,0,0]);
    sg(0x43,[0,0x3C,0x66,0x60,0x60,0x60,0x60,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x44,[0,0x78,0x6C,0x66,0x66,0x66,0x66,0x6C,0x78,0,0,0,0,0,0,0]);
    sg(0x45,[0,0x7E,0x60,0x60,0x7C,0x60,0x60,0x60,0x7E,0,0,0,0,0,0,0]);
    sg(0x46,[0,0x7E,0x60,0x60,0x7C,0x60,0x60,0x60,0x60,0,0,0,0,0,0,0]);
    sg(0x47,[0,0x3C,0x66,0x60,0x60,0x6E,0x66,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x48,[0,0x66,0x66,0x66,0x7E,0x66,0x66,0x66,0x66,0,0,0,0,0,0,0]);
    sg(0x49,[0,0x3C,0x18,0x18,0x18,0x18,0x18,0x18,0x3C,0,0,0,0,0,0,0]);
    sg(0x4A,[0,0x1E,0x0C,0x0C,0x0C,0x0C,0x6C,0x6C,0x38,0,0,0,0,0,0,0]);
    sg(0x4B,[0,0x66,0x6C,0x78,0x70,0x78,0x6C,0x66,0x63,0,0,0,0,0,0,0]);
    sg(0x4C,[0,0x60,0x60,0x60,0x60,0x60,0x60,0x60,0x7E,0,0,0,0,0,0,0]);
    sg(0x4D,[0,0x63,0x77,0x7F,0x6B,0x63,0x63,0x63,0x63,0,0,0,0,0,0,0]);
    sg(0x4E,[0,0x63,0x73,0x7B,0x6F,0x67,0x63,0x63,0x63,0,0,0,0,0,0,0]);
    sg(0x4F,[0,0x3C,0x66,0x66,0x66,0x66,0x66,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x50,[0,0x7C,0x66,0x66,0x7C,0x60,0x60,0x60,0x60,0,0,0,0,0,0,0]);
    sg(0x51,[0,0x3C,0x66,0x66,0x66,0x66,0x6E,0x3C,0x06,0,0,0,0,0,0,0]);
    sg(0x52,[0,0x7C,0x66,0x66,0x7C,0x6C,0x66,0x66,0x63,0,0,0,0,0,0,0]);
    sg(0x53,[0,0x3C,0x66,0x60,0x3C,0x06,0x06,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x54,[0,0x7E,0x18,0x18,0x18,0x18,0x18,0x18,0x18,0,0,0,0,0,0,0]);
    sg(0x55,[0,0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x56,[0,0x66,0x66,0x66,0x66,0x66,0x3C,0x18,0x18,0,0,0,0,0,0,0]);
    sg(0x57,[0,0x63,0x63,0x63,0x6B,0x7F,0x77,0x63,0x63,0,0,0,0,0,0,0]);
    sg(0x58,[0,0x63,0x63,0x36,0x1C,0x1C,0x36,0x63,0x63,0,0,0,0,0,0,0]);
    sg(0x59,[0,0x66,0x66,0x66,0x3C,0x18,0x18,0x18,0x18,0,0,0,0,0,0,0]);
    sg(0x5A,[0,0x7E,0x06,0x0C,0x18,0x30,0x60,0x60,0x7E,0,0,0,0,0,0,0]);
    // Lowercase
    sg(0x61,[0,0,0,0x3C,0x06,0x3E,0x66,0x66,0x3E,0,0,0,0,0,0,0]);
    sg(0x62,[0,0x60,0x60,0x7C,0x66,0x66,0x66,0x66,0x7C,0,0,0,0,0,0,0]);
    sg(0x63,[0,0,0,0x3C,0x66,0x60,0x60,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x64,[0,0x06,0x06,0x3E,0x66,0x66,0x66,0x66,0x3E,0,0,0,0,0,0,0]);
    sg(0x65,[0,0,0,0x3C,0x66,0x7E,0x60,0x60,0x3C,0,0,0,0,0,0,0]);
    sg(0x66,[0,0x1C,0x30,0x30,0x7C,0x30,0x30,0x30,0x30,0,0,0,0,0,0,0]);
    sg(0x67,[0,0,0,0x3E,0x66,0x66,0x3E,0x06,0x3C,0,0,0,0,0,0,0]);
    sg(0x68,[0,0x60,0x60,0x7C,0x66,0x66,0x66,0x66,0x66,0,0,0,0,0,0,0]);
    sg(0x69,[0,0x18,0x00,0x38,0x18,0x18,0x18,0x18,0x3C,0,0,0,0,0,0,0]);
    sg(0x6A,[0,0x06,0x00,0x06,0x06,0x06,0x06,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x6B,[0,0x60,0x60,0x66,0x6C,0x78,0x6C,0x66,0x63,0,0,0,0,0,0,0]);
    sg(0x6C,[0,0x38,0x18,0x18,0x18,0x18,0x18,0x18,0x3C,0,0,0,0,0,0,0]);
    sg(0x6D,[0,0,0,0x66,0x7F,0x7F,0x6B,0x63,0x63,0,0,0,0,0,0,0]);
    sg(0x6E,[0,0,0,0x7C,0x66,0x66,0x66,0x66,0x66,0,0,0,0,0,0,0]);
    sg(0x6F,[0,0,0,0x3C,0x66,0x66,0x66,0x66,0x3C,0,0,0,0,0,0,0]);
    sg(0x70,[0,0,0,0x7C,0x66,0x66,0x7C,0x60,0x60,0,0,0,0,0,0,0]);
    sg(0x71,[0,0,0,0x3E,0x66,0x66,0x3E,0x06,0x06,0,0,0,0,0,0,0]);
    sg(0x72,[0,0,0,0x6C,0x76,0x60,0x60,0x60,0x60,0,0,0,0,0,0,0]);
    sg(0x73,[0,0,0,0x3C,0x60,0x3C,0x06,0x06,0x7C,0,0,0,0,0,0,0]);
    sg(0x74,[0,0x30,0x30,0x7C,0x30,0x30,0x30,0x30,0x1C,0,0,0,0,0,0,0]);
    sg(0x75,[0,0,0,0x66,0x66,0x66,0x66,0x66,0x3E,0,0,0,0,0,0,0]);
    sg(0x76,[0,0,0,0x66,0x66,0x66,0x3C,0x18,0x18,0,0,0,0,0,0,0]);
    sg(0x77,[0,0,0,0x63,0x63,0x6B,0x7F,0x77,0x63,0,0,0,0,0,0,0]);
    sg(0x78,[0,0,0,0x66,0x3C,0x18,0x18,0x3C,0x66,0,0,0,0,0,0,0]);
    sg(0x79,[0,0,0,0x66,0x66,0x3E,0x06,0x0C,0x78,0,0,0,0,0,0,0]);
    sg(0x7A,[0,0,0,0x7E,0x0C,0x18,0x30,0x60,0x7E,0,0,0,0,0,0,0]);
    // Space and specials
    sg(0x20,[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
    sg(0x2E,[0,0,0,0,0,0,0,0x18,0x18,0,0,0,0,0,0,0]);
    sg(0x2C,[0,0,0,0,0,0,0,0x18,0x18,0x30,0,0,0,0,0,0]);
    sg(0x3A,[0,0,0x18,0x18,0,0,0x18,0x18,0,0,0,0,0,0,0,0]);
    sg(0x3E,[0,0,0x40,0x60,0x70,0x78,0x70,0x60,0x40,0,0,0,0,0,0,0]);
    sg(0x3C,[0,0,0x02,0x06,0x0E,0x1E,0x0E,0x06,0x02,0,0,0,0,0,0,0]);
    sg(0x3D,[0,0,0,0x7E,0,0,0x7E,0,0,0,0,0,0,0,0,0]);
    sg(0x5F,[0,0,0,0,0,0,0,0,0,0xFF,0,0,0,0,0,0]);
    sg(0x2D,[0,0,0,0,0,0x7E,0,0,0,0,0,0,0,0,0,0]);
    sg(0x21,[0,0x18,0x18,0x18,0x18,0x18,0x18,0,0x18,0,0,0,0,0,0,0]);
    sg(0x22,[0,0x66,0x66,0x44,0,0,0,0,0,0,0,0,0,0,0,0]);
    sg(0x27,[0,0x30,0x30,0x10,0,0,0,0,0,0,0,0,0,0,0,0]);
    sg(0x28,[0,0x0C,0x18,0x30,0x30,0x30,0x30,0x18,0x0C,0,0,0,0,0,0,0]);
    sg(0x29,[0,0x30,0x18,0x0C,0x0C,0x0C,0x0C,0x18,0x30,0,0,0,0,0,0,0]);
    sg(0x2F,[0,0x06,0x0C,0x18,0x18,0x30,0x60,0x60,0,0,0,0,0,0,0,0]);
    sg(0x5C,[0,0x60,0x30,0x18,0x18,0x0C,0x06,0x06,0,0,0,0,0,0,0,0]);
  }

  _setupVRAMHooks() {
    // GVRAM writes at A8000-BFFFF go to our plane arrays
    // We intercept via mem write overrides in pc98.js
  }

  // Write to GVRAM (called from PC98 memory write handler)
  // Plane windows: A8000=blue(0), B0000=red(1), B8000=green(2), E0000=intensity(3)
  writeGVRAM(addr, val) {
    const bank = this._accPage << 15;
    if (this._grcgMode & 0x80) {
      // GRCG enabled: write affects all unprotected planes at the same offset
      const off = bank | (addr & 0x7FFF);
      const tdw = !!(this._grcgMode & 0x40);
      for (let p = 0; p < 4; p++) {
        if (this._grcgMode & (1 << p)) continue; // protected
        if (tdw) {
          // TDW: tile data written directly, CPU data ignored
          this.plane[p][off] = this._grcgTile[p];
        } else {
          // RMW: CPU data = bit mask; set bits take tile data
          this.plane[p][off] = (this.plane[p][off] & ~val) | (this._grcgTile[p] & val);
        }
      }
    } else {
      const p = this._planeFor(addr);
      if (p >= 0) this.plane[p][bank | (addr & 0x7FFF)] = val;
    }
    this._dirty = true;
  }

  readGVRAM(addr) {
    const bank = this._accPage << 15;
    if ((this._grcgMode & 0xC0) === 0xC0) {
      // GRCG TCR read: compare unprotected planes against tiles
      const off = bank | (addr & 0x7FFF);
      let diff = 0;
      for (let p = 0; p < 4; p++) {
        if (this._grcgMode & (1 << p)) continue;
        diff |= this.plane[p][off] ^ this._grcgTile[p];
      }
      return (~diff) & 0xFF;
    }
    const p = this._planeFor(addr);
    return p >= 0 ? this.plane[p][bank | (addr & 0x7FFF)] : 0;
  }

  _planeFor(addr) {
    if (addr >= 0xA8000 && addr < 0xB0000) return 0;
    if (addr >= 0xB0000 && addr < 0xB8000) return 1;
    if (addr >= 0xB8000 && addr < 0xC0000) return 2;
    if (addr >= 0xE0000 && addr < 0xE8000) return 3;
    return -1;
  }

  // Render frame to canvas
  render() {
    const pixels = new Uint32Array(this.imgData.data.buffer);
    const data   = this.imgData.data;

    // Graphics layer (640×400, 4 planes, displayed page only)
    const dispBase = this._dispPage << 15;
    if (this._showGraph || true) {
      for (let y = 0; y < 400; y++) {
        for (let x = 0; x < 640; x += 8) {
          const byteOff = dispBase + (y * 80) + (x >> 3);
          const b0 = this.plane[0][byteOff]; // Blue
          const b1 = this.plane[1][byteOff]; // Red
          const b2 = this.plane[2][byteOff]; // Green
          const b3 = this.plane[3][byteOff]; // Intensity
          for (let bit = 0; bit < 8; bit++) {
            const mask = 0x80 >> bit;
            const colorIdx =
              (b0 & mask ? 1 : 0) |
              (b1 & mask ? 2 : 0) |
              (b2 & mask ? 4 : 0) |
              (b3 & mask ? 8 : 0);
            const px = y * 640 + x + bit;
            pixels[px] = this._palette[colorIdx];
          }
        }
      }
    }

    // Text layer
    if (this._showText || true) {
      this._renderText(pixels);
    }

    this.ctx.putImageData(this.imgData, 0, 0);
    this._dirty = false;
  }

  _renderText(pixels) {
    // PC-98 text: 80 cols × 25 rows
    // Character codes at 0xA0000, attributes at 0xA2000
    for (let row = 0; row < 25; row++) {
      for (let col = 0; col < 80; col++) {
        const cellOff = row * 80 + col;
        const code    = this.mem.read8(0xA0000 + cellOff * 2);
        const attr    = this.mem.read8(0xA2000 + cellOff * 2);

        if (!code) continue;

        // Attribute bits: bit0=under, bit1=?, bit2=reverse, bit3=blink, bit4=?, bit7=secret
        const fg = (attr >> 5) & 7;  // simplified: bits 5-7 = color
        const bg = 0;

        const fgColor = this._textColor(fg, attr);
        const bgColor = this._textColor(bg, attr);

        const cx = col * 8;
        const cy = row * 16;

        const fontBase = code * 16;
        for (let fy = 0; fy < 16; fy++) {
          const frow = this._font[fontBase + fy] || 0;
          for (let fx = 0; fx < 8; fx++) {
            const isSet = !!(frow & (0x80 >> fx));
            const px = (cy + fy) * 640 + (cx + fx);
            if (cy + fy < 400) {
              pixels[px] = isSet ? fgColor : 0; // transparent bg
            }
          }
        }
      }
    }
  }

  _textColor(colorIdx, attr) {
    // PC-98 text colors: 0=black 1=blue 2=red 3=magenta 4=green 5=cyan 6=yellow 7=white
    const cols = [
      0x00000000, 0xFF0000AA, 0xFFAA0000, 0xFFAA00AA,
      0xFF00AA00, 0xFF00AAAA, 0xFFAAAA00, 0xFFAAAAAA,
    ];
    return cols[colorIdx & 7];
  }

  reset() {
    for (const p of this.plane) p.fill(0);
    this.mem.data.fill(0, 0xA0000, 0xA4000); // Text VRAM
    this._dispPage = 0;
    this._accPage  = 0;
    this._grcgMode = 0;
    this._grcgTileIdx = 0;
    this._grcgTile.fill(0);
    this._palIdx = 0;
    this._initPalette();
    this._dirty = true;
  }
}
