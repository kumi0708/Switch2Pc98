'use strict';

// PC-98 Keyboard Controller (8251A)
// Port 0x41: key data, Port 0x43: status/command, Port 0x43D: keyboard mode
class Keyboard {
  constructor(io, pic) {
    this.pic  = pic;
    this._buf = [];
    this._shift = false;
    this._ctrl  = false;
    this._alt   = false;
    // Pressed-key bitmap: 16 groups × 8 keys (indexed by scan code)
    this._keyState = new Uint8Array(16);

    io.register(0x41, () => this._readKey(), (p,v) => {});
    // 8251 status: bit1 = RxRDY (data available), bit0 = TxRDY (always ready)
    io.register(0x43, () => (this._buf.length > 0 ? 0x02 : 0x00) | 0x01, (p,v) => {});
    io.register(0x43D, null, (p,v) => {}); // keyboard control

    // BIOS keyboard buffer is at 0x0502 (PC-98)
    this._biosHead = 0x0524; // MEMW_KB_BUF_HEAD
    this._biosTail = 0x0526; // MEMW_KB_BUF_TAIL
    this._biosBuf  = 0x0502; // MEMW_KB_BUF (16-word ring buffer)
    this._mem      = null;   // set by pc98.js

    // PC-98 key code table
    this._keyMap = this._buildKeyMap();
  }

  setMem(mem) { this._mem = mem; }

  _buildKeyMap() {
    // Browser keyCode → PC-98 scan code mapping
    return {
      'Escape': 0x01, 'F1': 0x62, 'F2': 0x63, 'F3': 0x64, 'F4': 0x65,
      'F5': 0x66, 'F6': 0x67, 'F7': 0x68, 'F8': 0x69, 'F9': 0x6A, 'F10': 0x6B,
      'Digit1': 0x01, 'Digit2': 0x02, 'Digit3': 0x03, 'Digit4': 0x04,
      'Digit5': 0x05, 'Digit6': 0x06, 'Digit7': 0x07, 'Digit8': 0x08,
      'Digit9': 0x09, 'Digit0': 0x0A,
      'KeyQ': 0x10, 'KeyW': 0x11, 'KeyE': 0x12, 'KeyR': 0x13, 'KeyT': 0x14,
      'KeyY': 0x15, 'KeyU': 0x16, 'KeyI': 0x17, 'KeyO': 0x18, 'KeyP': 0x19,
      'KeyA': 0x1D, 'KeyS': 0x1E, 'KeyD': 0x1F, 'KeyF': 0x20, 'KeyG': 0x21,
      'KeyH': 0x22, 'KeyJ': 0x23, 'KeyK': 0x24, 'KeyL': 0x25,
      'KeyZ': 0x29, 'KeyX': 0x2A, 'KeyC': 0x2B, 'KeyV': 0x2C,
      'KeyB': 0x2D, 'KeyN': 0x2E, 'KeyM': 0x2F,
      'Space': 0x34, 'Enter': 0x1C, 'Backspace': 0x0E,
      'Tab': 0x0F, 'Delete': 0x39, 'Insert': 0x38,
      'Home': 0x3E, 'End': 0x3F, 'PageUp': 0x37, 'PageDown': 0x36,
      'ArrowUp': 0x3A, 'ArrowDown': 0x3D, 'ArrowLeft': 0x3B, 'ArrowRight': 0x3C,
      'Minus': 0x0B, 'Equal': 0x0C, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
      'Semicolon': 0x26, 'Quote': 0x27, 'Backslash': 0x28,
      'Comma': 0x30, 'Period': 0x31, 'Slash': 0x32,
    };
  }

  onKeyDown(e) {
    if (e.key === 'Shift')   { this._shift = true; return; }
    if (e.key === 'Control') { this._ctrl  = true; return; }
    if (e.key === 'Alt')     { this._alt   = true; return; }

    const code = this._keyMap[e.code];
    if (code === undefined) return;

    this._keyState[(code >> 3) & 0x0F] |= 1 << (code & 7);

    // ASCII for buffer-based reads (INT 18h AH=0 etc.)
    const ascii = (e.key && e.key.length === 1) ? (e.key.charCodeAt(0) & 0xFF)
      : e.key === 'Enter' ? 0x0D : e.key === 'Escape' ? 0x1B
      : e.key === 'Backspace' ? 0x08 : e.key === 'Tab' ? 0x09 : 0;

    this._buf.push({ scan: code & 0xFF, ascii });
    if (this._buf.length > 16) this._buf.shift();
    this.pic.raise(1); // IRQ1 → keyboard
  }

  onKeyUp(e) {
    if (e.key === 'Shift')   { this._shift = false; }
    if (e.key === 'Control') { this._ctrl  = false; }
    if (e.key === 'Alt')     { this._alt   = false; }
    const code = this._keyMap[e.code];
    if (code !== undefined) this._keyState[(code >> 3) & 0x0F] &= ~(1 << (code & 7));
  }

  // INT 18h AH=04: bitmap of pressed keys in group g
  senseGroup(g) {
    return this._keyState[g & 0x0F];
  }

  _readKey() {
    if (this._buf.length > 0) return this._buf.shift().scan & 0xFF;
    return 0;
  }

  reset() {
    this._buf   = [];
    this._shift = this._ctrl = this._alt = false;
    this._keyState.fill(0);
  }
}
