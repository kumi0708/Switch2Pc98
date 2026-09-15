'use strict';

// NEC V30 / 8086 CPU emulator
class CPU {
  constructor(mem, io) {
    this.mem = mem;
    this.io  = io;

    // Registers
    this.ax = 0; this.bx = 0; this.cx = 0; this.dx = 0;
    this.si = 0; this.di = 0; this.bp = 0; this.sp = 0;
    this.ip = 0;
    this.cs = 0xF000; this.ds = 0; this.es = 0; this.ss = 0;
    this.flags = 0x0002;

    this.halted    = false;
    this.segOvr    = -1;   // segment override: -1=none 0=ES 1=CS 2=SS 3=DS
    this.repPrefix = 0;    // 0=none 0xF2=REPNE 0xF3=REP

    this._interruptQueue = [];
    this.totalCycles = 0;
  }

  // ── Register helpers ───────────────────────────────────────────────
  get al() { return  this.ax & 0xFF; }
  get ah() { return (this.ax >> 8) & 0xFF; }
  get bl() { return  this.bx & 0xFF; }
  get bh() { return (this.bx >> 8) & 0xFF; }
  get cl() { return  this.cx & 0xFF; }
  get ch() { return (this.cx >> 8) & 0xFF; }
  get dl() { return  this.dx & 0xFF; }
  get dh() { return (this.dx >> 8) & 0xFF; }

  set al(v) { this.ax = (this.ax & 0xFF00) | (v & 0xFF); }
  set ah(v) { this.ax = (this.ax & 0x00FF) | ((v & 0xFF) << 8); }
  set bl(v) { this.bx = (this.bx & 0xFF00) | (v & 0xFF); }
  set bh(v) { this.bx = (this.bx & 0x00FF) | ((v & 0xFF) << 8); }
  set cl(v) { this.cx = (this.cx & 0xFF00) | (v & 0xFF); }
  set ch(v) { this.cx = (this.cx & 0x00FF) | ((v & 0xFF) << 8); }
  set dl(v) { this.dx = (this.dx & 0xFF00) | (v & 0xFF); }
  set dh(v) { this.dx = (this.dx & 0x00FF) | ((v & 0xFF) << 8); }

  // Flags
  get CF() { return (this.flags >> 0) & 1; }
  get PF() { return (this.flags >> 2) & 1; }
  get AF() { return (this.flags >> 4) & 1; }
  get ZF() { return (this.flags >> 6) & 1; }
  get SF() { return (this.flags >> 7) & 1; }
  get TF() { return (this.flags >> 8) & 1; }
  get IF() { return (this.flags >> 9) & 1; }
  get DF() { return (this.flags >> 10) & 1; }
  get OF() { return (this.flags >> 11) & 1; }

  set CF(v) { this.flags = (this.flags & ~0x001) | (v ? 1 : 0); }
  set PF(v) { this.flags = (this.flags & ~0x004) | (v ? 4 : 0); }
  set AF(v) { this.flags = (this.flags & ~0x010) | (v ? 0x10 : 0); }
  set ZF(v) { this.flags = (this.flags & ~0x040) | (v ? 0x40 : 0); }
  set SF(v) { this.flags = (this.flags & ~0x080) | (v ? 0x80 : 0); }
  set TF(v) { this.flags = (this.flags & ~0x100) | (v ? 0x100 : 0); }
  set IF(v) { this.flags = (this.flags & ~0x200) | (v ? 0x200 : 0); }
  set DF(v) { this.flags = (this.flags & ~0x400) | (v ? 0x400 : 0); }
  set OF(v) { this.flags = (this.flags & ~0x800) | (v ? 0x800 : 0); }

  // ── Address helpers ────────────────────────────────────────────────
  seg2phys(seg, off) { return ((seg << 4) + (off & 0xFFFF)) & 0xFFFFF; }

  effSeg(def) {
    if (this.segOvr < 0) return def;
    return [this.es, this.cs, this.ss, this.ds][this.segOvr];
  }

  // ── Memory access ──────────────────────────────────────────────────
  rb(addr)      { return this.mem.read8(addr); }
  rw(addr)      { return this.mem.read16(addr); }
  wb(addr, v)   { this.mem.write8(addr, v); }
  ww(addr, v)   { this.mem.write16(addr, v); }

  // ── Fetch from CS:IP ───────────────────────────────────────────────
  nextB() {
    const v = this.rb(this.seg2phys(this.cs, this.ip));
    this.ip = (this.ip + 1) & 0xFFFF;
    return v;
  }
  nextW() {
    const lo = this.rb(this.seg2phys(this.cs, this.ip));
    this.ip = (this.ip + 1) & 0xFFFF;
    const hi = this.rb(this.seg2phys(this.cs, this.ip));
    this.ip = (this.ip + 1) & 0xFFFF;
    return lo | (hi << 8);
  }
  nextSB() { const v = this.nextB(); return v >= 0x80 ? v - 0x100 : v; }
  nextSW() { const v = this.nextW(); return v >= 0x8000 ? v - 0x10000 : v; }

  // ── Reg accessors ──────────────────────────────────────────────────
  getReg8(r) {
    switch (r) {
      case 0: return this.al; case 1: return this.cl;
      case 2: return this.dl; case 3: return this.bl;
      case 4: return this.ah; case 5: return this.ch;
      case 6: return this.dh; case 7: return this.bh;
    }
    return 0;
  }
  setReg8(r, v) {
    v &= 0xFF;
    switch (r) {
      case 0: this.al = v; break; case 1: this.cl = v; break;
      case 2: this.dl = v; break; case 3: this.bl = v; break;
      case 4: this.ah = v; break; case 5: this.ch = v; break;
      case 6: this.dh = v; break; case 7: this.bh = v; break;
    }
  }
  getReg16(r) {
    switch (r) {
      case 0: return this.ax; case 1: return this.cx;
      case 2: return this.dx; case 3: return this.bx;
      case 4: return this.sp; case 5: return this.bp;
      case 6: return this.si; case 7: return this.di;
    }
    return 0;
  }
  setReg16(r, v) {
    v &= 0xFFFF;
    switch (r) {
      case 0: this.ax = v; break; case 1: this.cx = v; break;
      case 2: this.dx = v; break; case 3: this.bx = v; break;
      case 4: this.sp = v; break; case 5: this.bp = v; break;
      case 6: this.si = v; break; case 7: this.di = v; break;
    }
  }
  getSReg(r) {
    switch (r) {
      case 0: return this.es; case 1: return this.cs;
      case 2: return this.ss; case 3: return this.ds;
    }
    return 0;
  }
  setSReg(r, v) {
    v &= 0xFFFF;
    switch (r) {
      case 0: this.es = v; break; case 1: this.cs = v; break;
      case 2: this.ss = v; break; case 3: this.ds = v; break;
    }
  }

  // ── ModRM decoder ──────────────────────────────────────────────────
  // Returns { addr, isReg, reg } where addr is physical address for memory operands
  decRM(modrm) {
    const mod = (modrm >> 6) & 3;
    const rm  = modrm & 7;
    if (mod === 3) return { isReg: true, reg: rm, addr: 0 };

    let ea = 0, seg = this.ds;
    switch (rm) {
      case 0: ea = (this.bx + this.si) & 0xFFFF; break;
      case 1: ea = (this.bx + this.di) & 0xFFFF; break;
      case 2: ea = (this.bp + this.si) & 0xFFFF; seg = this.ss; break;
      case 3: ea = (this.bp + this.di) & 0xFFFF; seg = this.ss; break;
      case 4: ea = this.si; break;
      case 5: ea = this.di; break;
      case 6:
        if (mod === 0) { ea = this.nextW(); seg = this.ds; }
        else           { ea = this.bp; seg = this.ss; }
        break;
      case 7: ea = this.bx; break;
    }
    if (mod === 1) ea = (ea + this.nextSB()) & 0xFFFF;
    else if (mod === 2) ea = (ea + this.nextSW()) & 0xFFFF;

    seg = this.effSeg(seg);
    return { isReg: false, reg: 0, addr: this.seg2phys(seg, ea), ea: ea & 0xFFFF };
  }

  getRM8(e)    { return e.isReg ? this.getReg8(e.reg)  : this.rb(e.addr); }
  setRM8(e, v) { if (e.isReg) this.setReg8(e.reg, v);  else this.wb(e.addr, v); }
  getRM16(e)   { return e.isReg ? this.getReg16(e.reg) : this.rw(e.addr); }
  setRM16(e,v) { if (e.isReg) this.setReg16(e.reg, v); else this.ww(e.addr, v); }

  // ── Flags ──────────────────────────────────────────────────────────
  parity(v) {
    v ^= v >> 4; v ^= v >> 2; v ^= v >> 1;
    return (~v) & 1;
  }
  szp8(v)  { this.ZF = !(v & 0xFF); this.SF = !!(v & 0x80);  this.PF = this.parity(v & 0xFF); }
  szp16(v) { this.ZF = !(v & 0xFFFF); this.SF = !!(v & 0x8000); this.PF = this.parity(v & 0xFF); }

  // ── ALU ────────────────────────────────────────────────────────────
  ADD8(a, b)  { const r = a+b; this.CF=r>0xFF; this.AF=!!((a^b^r)&0x10); this.OF=!!((~(a^b)&(a^r))&0x80);  this.szp8(r);  return r&0xFF; }
  ADD16(a,b)  { const r = a+b; this.CF=r>0xFFFF; this.AF=!!((a^b^r)&0x10); this.OF=!!((~(a^b)&(a^r))&0x8000); this.szp16(r); return r&0xFFFF; }
  ADC8(a, b)  { const c=this.CF,r=a+b+c; this.CF=r>0xFF; this.AF=!!((a^b^r)&0x10); this.OF=!!((~(a^b)&(a^r))&0x80);  this.szp8(r);  return r&0xFF; }
  ADC16(a,b)  { const c=this.CF,r=a+b+c; this.CF=r>0xFFFF; this.AF=!!((a^b^r)&0x10); this.OF=!!((~(a^b)&(a^r))&0x8000); this.szp16(r); return r&0xFFFF; }
  SUB8(a, b)  { const r = a-b; this.CF=r<0; this.AF=!!((a^b^r)&0x10); this.OF=!!(((a^b)&(a^r))&0x80);  this.szp8(r);  return r&0xFF; }
  SUB16(a,b)  { const r = a-b; this.CF=r<0; this.AF=!!((a^b^r)&0x10); this.OF=!!(((a^b)&(a^r))&0x8000); this.szp16(r); return r&0xFFFF; }
  SBB8(a, b)  { const c=this.CF,r=a-b-c; this.CF=r<0; this.AF=!!((a^b^r)&0x10); this.OF=!!(((a^b)&(a^r))&0x80);  this.szp8(r);  return r&0xFF; }
  SBB16(a,b)  { const c=this.CF,r=a-b-c; this.CF=r<0; this.AF=!!((a^b^r)&0x10); this.OF=!!(((a^b)&(a^r))&0x8000); this.szp16(r); return r&0xFFFF; }
  AND8(a, b)  { const r=a&b; this.CF=0;this.OF=0;this.AF=0; this.szp8(r);  return r; }
  AND16(a,b)  { const r=a&b; this.CF=0;this.OF=0;this.AF=0; this.szp16(r); return r; }
  OR8(a,  b)  { const r=a|b; this.CF=0;this.OF=0;this.AF=0; this.szp8(r);  return r; }
  OR16(a, b)  { const r=a|b; this.CF=0;this.OF=0;this.AF=0; this.szp16(r); return r; }
  XOR8(a, b)  { const r=a^b; this.CF=0;this.OF=0;this.AF=0; this.szp8(r);  return r; }
  XOR16(a,b)  { const r=a^b; this.CF=0;this.OF=0;this.AF=0; this.szp16(r); return r; }
  CMP8(a, b)  { this.SUB8(a,b); }
  CMP16(a,b)  { this.SUB16(a,b); }
  TEST8(a,b)  { this.AND8(a,b); }
  TEST16(a,b) { this.AND16(a,b); }

  INC8(v)  { const r=(v+1)&0xFF;   const wasOF=this.CF; this.OF=r===0x80;  this.AF=!(v&0x0F); this.szp8(r);  this.CF=wasOF; return r; }
  INC16(v) { const r=(v+1)&0xFFFF; const wasOF=this.CF; this.OF=r===0x8000;this.AF=!(v&0x000F);this.szp16(r);this.CF=wasOF; return r; }
  DEC8(v)  { const r=(v-1)&0xFF;   const wasOF=this.CF; this.OF=v===0x80;  this.AF=!(v&0x0F); this.szp8(r);  this.CF=wasOF; return r; }
  DEC16(v) { const r=(v-1)&0xFFFF; const wasOF=this.CF; this.OF=v===0x8000;this.AF=!(v&0x000F);this.szp16(r);this.CF=wasOF; return r; }
  NEG8(v)  { return this.SUB8(0, v); }
  NEG16(v) { return this.SUB16(0, v); }
  NOT8(v)  { return (~v)&0xFF; }
  NOT16(v) { return (~v)&0xFFFF; }

  // Shifts
  SHL8(v, n)  { n &= 0x1F; if(!n) return v; const r=(v<<n)&0xFF; this.CF=!!(v&(0x80>>(n-1))); this.OF=n===1&&!!(this.CF^!!(r&0x80)); this.szp8(r); return r; }
  SHL16(v,n)  { n &= 0x1F; if(!n) return v; const r=(v<<n)&0xFFFF; this.CF=!!(v&(0x8000>>(n-1))); this.OF=n===1&&!!(this.CF^!!(r&0x8000)); this.szp16(r); return r; }
  SHR8(v, n)  { n &= 0x1F; if(!n) return v; this.CF=!!(v&(1<<(n-1))); const r=(v>>>n)&0xFF; this.OF=n===1&&!!(v&0x80); this.szp8(r); return r; }
  SHR16(v,n)  { n &= 0x1F; if(!n) return v; this.CF=!!(v&(1<<(n-1))); const r=(v>>>n)&0xFFFF; this.OF=n===1&&!!(v&0x8000); this.szp16(r); return r; }
  SAR8(v, n)  { n &= 0x1F; if(!n) return v; const sv=(v>=0x80?v-0x100:v); this.CF=!!(v&(1<<(n-1))); const r=(sv>>n)&0xFF; this.OF=0; this.szp8(r); return r; }
  SAR16(v,n)  { n &= 0x1F; if(!n) return v; const sv=(v>=0x8000?v-0x10000:v); this.CF=!!(v&(1<<(n-1))); const r=(sv>>n)&0xFFFF; this.OF=0; this.szp16(r); return r; }
  ROL8(v, n)  { n = (n&0x1F)%8;  if(!n){this.CF=v&1;return v;} const r=((v<<n)|(v>>(8-n)))&0xFF;  this.CF=r&1; this.OF=n===1&&!!((r>>7^r)&1); return r; }
  ROL16(v,n)  { n = (n&0x1F)%16; if(!n){this.CF=v&1;return v;} const r=((v<<n)|(v>>(16-n)))&0xFFFF; this.CF=r&1; this.OF=n===1&&!!((r>>15^r)&1); return r; }
  ROR8(v, n)  { n = (n&0x1F)%8;  if(!n){this.CF=!!(v&0x80);return v;} const r=((v>>n)|(v<<(8-n)))&0xFF;  this.CF=!!(r&0x80); this.OF=n===1&&!!((r>>6^r>>7)&1); return r; }
  ROR16(v,n)  { n = (n&0x1F)%16; if(!n){this.CF=!!(v&0x8000);return v;} const r=((v>>n)|(v<<(16-n)))&0xFFFF; this.CF=!!(r&0x8000); this.OF=n===1&&!!((r>>14^r>>15)&1); return r; }
  RCL8(v, n)  { n = (n&0x1F)%9;  if(!n) return v; let r=v,c=this.CF; for(let i=0;i<n;i++){const nc=(r>>7)&1;r=((r<<1)|c)&0xFF;c=nc;} this.CF=c; this.OF=n===1&&!!(c^!!(r&0x80)); return r; }
  RCL16(v,n)  { n = (n&0x1F)%17; if(!n) return v; let r=v,c=this.CF; for(let i=0;i<n;i++){const nc=(r>>15)&1;r=((r<<1)|c)&0xFFFF;c=nc;} this.CF=c; this.OF=n===1&&!!(c^!!(r&0x8000)); return r; }
  RCR8(v, n)  { n = (n&0x1F)%9;  if(!n) return v; let r=v,c=this.CF; for(let i=0;i<n;i++){const nc=r&1;r=((c<<7)|(r>>1))&0xFF;c=nc;} this.CF=c; this.OF=n===1&&!!((r>>6^r>>7)&1); return r; }
  RCR16(v,n)  { n = (n&0x1F)%17; if(!n) return v; let r=v,c=this.CF; for(let i=0;i<n;i++){const nc=r&1;r=((c<<15)|(r>>1))&0xFFFF;c=nc;} this.CF=c; this.OF=n===1&&!!((r>>14^r>>15)&1); return r; }

  // MUL / DIV
  MUL8(v)  { const r=this.al*v; this.ax=r&0xFFFF; this.CF=this.OF=!!(r>>8); }
  MUL16(v) { const r=this.ax*v; this.dx=(r>>16)&0xFFFF; this.ax=r&0xFFFF; this.CF=this.OF=!!this.dx; }
  IMUL8(v) { const a=this.al>=0x80?this.al-0x100:this.al; const b=v>=0x80?v-0x100:v; const r=a*b; this.ax=r&0xFFFF; this.CF=this.OF=(r<-128||r>127)?1:0; }
  IMUL16(v){ const a=this.ax>=0x8000?this.ax-0x10000:this.ax; const b=v>=0x8000?v-0x10000:v; const r=a*b; this.dx=(r>>16)&0xFFFF; this.ax=r&0xFFFF; this.CF=this.OF=(r<-32768||r>32767)?1:0; }
  DIV8(v)  { if(!v){this.interrupt(0);return;} const r=this.ax/v|0; if(r>0xFF){this.interrupt(0);return;} this.al=r&0xFF; this.ah=this.ax%v; }
  DIV16(v) { if(!v){this.interrupt(0);return;} const num=(this.dx<<16)|this.ax; const r=num/v|0; if(r>0xFFFF){this.interrupt(0);return;} this.ax=r&0xFFFF; this.dx=num%v; }
  IDIV8(v) { if(!v){this.interrupt(0);return;} const n=this.ax>=0x8000?this.ax-0x10000:this.ax; const d=v>=0x80?v-0x100:v; const r=Math.trunc(n/d); if(r<-128||r>127){this.interrupt(0);return;} this.al=r&0xFF; this.ah=((n%d)+256)&0xFF; }
  IDIV16(v){ if(!v){this.interrupt(0);return;} const n=(this.dx<<16)|this.ax; const d=v>=0x8000?v-0x10000:v; const r=Math.trunc(n/d); if(r<-32768||r>32767){this.interrupt(0);return;} this.ax=r&0xFFFF; this.dx=((n%d)+0x10000)&0xFFFF; }

  // ── Stack ──────────────────────────────────────────────────────────
  push(v) {
    this.sp = (this.sp - 2) & 0xFFFF;
    this.ww(this.seg2phys(this.ss, this.sp), v & 0xFFFF);
  }
  pop() {
    const v = this.rw(this.seg2phys(this.ss, this.sp));
    this.sp = (this.sp + 2) & 0xFFFF;
    return v;
  }

  // ── Interrupts ─────────────────────────────────────────────────────
  interrupt(n) {
    this.halted = false;
    this.push(this.flags | 0xF002);
    this.push(this.cs);
    this.push(this.ip);
    this.IF = 0;
    this.TF = 0;
    const vec = n * 4;
    this.ip = this.rw(vec);
    this.cs = this.rw(vec + 2);
  }

  requestInterrupt(irq) {
    this._interruptQueue.push(irq);
  }

  // ── Step ───────────────────────────────────────────────────────────
  step() {
    // Check hardware interrupts
    if (this.IF && this._interruptQueue.length > 0) {
      const irq = this._interruptQueue.shift();
      this.interrupt(irq);
      this.totalCycles += 50;
      return 50;
    }

    if (this.halted) return 1;

    this.segOvr = -1;
    this.repPrefix = 0;

    let op;
    prefixLoop: while (true) {
      op = this.nextB();
      switch (op) {
        case 0x26: this.segOvr = 0; break;
        case 0x2E: this.segOvr = 1; break;
        case 0x36: this.segOvr = 2; break;
        case 0x3E: this.segOvr = 3; break;
        case 0xF0: break; // LOCK
        case 0xF2: this.repPrefix = 0xF2; break;
        case 0xF3: this.repPrefix = 0xF3; break;
        default: break prefixLoop;
      }
    }

    const cycles = this._exec(op);
    this.totalCycles += cycles;
    return cycles;
  }

  _exec(op) {
    let mr, e, e2, r, r2, v, v2, seg, off, n, c;

    switch (op) {
      // ─ ADD ─
      case 0x00: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.ADD8(this.getRM8(e),this.getReg8((mr>>3)&7))); return 3;
      case 0x01: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.ADD16(this.getRM16(e),this.getReg16((mr>>3)&7))); return 3;
      case 0x02: mr=this.nextB();e=this.decRM(mr);this.setReg8((mr>>3)&7,this.ADD8(this.getReg8((mr>>3)&7),this.getRM8(e))); return 3;
      case 0x03: mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,this.ADD16(this.getReg16((mr>>3)&7),this.getRM16(e))); return 3;
      case 0x04: this.al=this.ADD8(this.al,this.nextB()); return 4;
      case 0x05: this.ax=this.ADD16(this.ax,this.nextW()); return 4;
      // ─ PUSH ES / POP ES ─
      case 0x06: this.push(this.es); return 10;
      case 0x07: this.es=this.pop(); return 8;
      // ─ OR ─
      case 0x08: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.OR8(this.getRM8(e),this.getReg8((mr>>3)&7))); return 3;
      case 0x09: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.OR16(this.getRM16(e),this.getReg16((mr>>3)&7))); return 3;
      case 0x0A: mr=this.nextB();e=this.decRM(mr);this.setReg8((mr>>3)&7,this.OR8(this.getReg8((mr>>3)&7),this.getRM8(e))); return 3;
      case 0x0B: mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,this.OR16(this.getReg16((mr>>3)&7),this.getRM16(e))); return 3;
      case 0x0C: this.al=this.OR8(this.al,this.nextB()); return 4;
      case 0x0D: this.ax=this.OR16(this.ax,this.nextW()); return 4;
      // ─ PUSH CS ─
      case 0x0E: this.push(this.cs); return 10;
      // ─ POP CS (8086 only) ─
      case 0x0F: this.cs=this.pop(); return 8;
      // ─ ADC ─
      case 0x10: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.ADC8(this.getRM8(e),this.getReg8((mr>>3)&7))); return 3;
      case 0x11: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.ADC16(this.getRM16(e),this.getReg16((mr>>3)&7))); return 3;
      case 0x12: mr=this.nextB();e=this.decRM(mr);this.setReg8((mr>>3)&7,this.ADC8(this.getReg8((mr>>3)&7),this.getRM8(e))); return 3;
      case 0x13: mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,this.ADC16(this.getReg16((mr>>3)&7),this.getRM16(e))); return 3;
      case 0x14: this.al=this.ADC8(this.al,this.nextB()); return 4;
      case 0x15: this.ax=this.ADC16(this.ax,this.nextW()); return 4;
      // ─ PUSH/POP SS ─
      case 0x16: this.push(this.ss); return 10;
      case 0x17: this.ss=this.pop(); return 8;
      // ─ SBB ─
      case 0x18: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.SBB8(this.getRM8(e),this.getReg8((mr>>3)&7))); return 3;
      case 0x19: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.SBB16(this.getRM16(e),this.getReg16((mr>>3)&7))); return 3;
      case 0x1A: mr=this.nextB();e=this.decRM(mr);this.setReg8((mr>>3)&7,this.SBB8(this.getReg8((mr>>3)&7),this.getRM8(e))); return 3;
      case 0x1B: mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,this.SBB16(this.getReg16((mr>>3)&7),this.getRM16(e))); return 3;
      case 0x1C: this.al=this.SBB8(this.al,this.nextB()); return 4;
      case 0x1D: this.ax=this.SBB16(this.ax,this.nextW()); return 4;
      // ─ PUSH/POP DS ─
      case 0x1E: this.push(this.ds); return 10;
      case 0x1F: this.ds=this.pop(); return 8;
      // ─ AND ─
      case 0x20: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.AND8(this.getRM8(e),this.getReg8((mr>>3)&7))); return 3;
      case 0x21: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.AND16(this.getRM16(e),this.getReg16((mr>>3)&7))); return 3;
      case 0x22: mr=this.nextB();e=this.decRM(mr);this.setReg8((mr>>3)&7,this.AND8(this.getReg8((mr>>3)&7),this.getRM8(e))); return 3;
      case 0x23: mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,this.AND16(this.getReg16((mr>>3)&7),this.getRM16(e))); return 3;
      case 0x24: this.al=this.AND8(this.al,this.nextB()); return 4;
      case 0x25: this.ax=this.AND16(this.ax,this.nextW()); return 4;
      // ─ DAA / DAS / AAA / AAS (BCD adjust) ─
      case 0x27: { let a=this.al; const oc=this.CF; let cf=0;
        if ((a&0xF)>9 || this.AF) { a+=6; this.AF=1; } else this.AF=0;
        if ((this.al>0x99) || oc) { a+=0x60; cf=1; }
        this.al=a&0xFF; this.CF=cf; this.szp8(this.al); return 4; }
      case 0x2F: { let a=this.al; const oa=this.al, oc=this.CF; let cf=0;
        if ((a&0xF)>9 || this.AF) { a-=6; this.AF=1; cf=oc||(oa<6)?cf:cf; } else this.AF=0;
        if (oa>0x99 || oc) { a-=0x60; cf=1; }
        this.al=a&0xFF; this.CF=cf; this.szp8(this.al); return 4; }
      case 0x37: if ((this.al&0xF)>9 || this.AF) { this.al=(this.al+6)&0xFF; this.ah=(this.ah+1)&0xFF; this.AF=1; this.CF=1; } else { this.AF=0; this.CF=0; } this.al&=0x0F; return 4;
      case 0x3F: if ((this.al&0xF)>9 || this.AF) { this.al=(this.al-6)&0xFF; this.ah=(this.ah-1)&0xFF; this.AF=1; this.CF=1; } else { this.AF=0; this.CF=0; } this.al&=0x0F; return 4;
      // ─ SUB ─
      case 0x28: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.SUB8(this.getRM8(e),this.getReg8((mr>>3)&7))); return 3;
      case 0x29: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.SUB16(this.getRM16(e),this.getReg16((mr>>3)&7))); return 3;
      case 0x2A: mr=this.nextB();e=this.decRM(mr);this.setReg8((mr>>3)&7,this.SUB8(this.getReg8((mr>>3)&7),this.getRM8(e))); return 3;
      case 0x2B: mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,this.SUB16(this.getReg16((mr>>3)&7),this.getRM16(e))); return 3;
      case 0x2C: this.al=this.SUB8(this.al,this.nextB()); return 4;
      case 0x2D: this.ax=this.SUB16(this.ax,this.nextW()); return 4;
      // ─ XOR ─
      case 0x30: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.XOR8(this.getRM8(e),this.getReg8((mr>>3)&7))); return 3;
      case 0x31: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.XOR16(this.getRM16(e),this.getReg16((mr>>3)&7))); return 3;
      case 0x32: mr=this.nextB();e=this.decRM(mr);this.setReg8((mr>>3)&7,this.XOR8(this.getReg8((mr>>3)&7),this.getRM8(e))); return 3;
      case 0x33: mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,this.XOR16(this.getReg16((mr>>3)&7),this.getRM16(e))); return 3;
      case 0x34: this.al=this.XOR8(this.al,this.nextB()); return 4;
      case 0x35: this.ax=this.XOR16(this.ax,this.nextW()); return 4;
      // ─ CMP ─
      case 0x38: mr=this.nextB();e=this.decRM(mr);this.CMP8(this.getRM8(e),this.getReg8((mr>>3)&7)); return 3;
      case 0x39: mr=this.nextB();e=this.decRM(mr);this.CMP16(this.getRM16(e),this.getReg16((mr>>3)&7)); return 3;
      case 0x3A: mr=this.nextB();e=this.decRM(mr);this.CMP8(this.getReg8((mr>>3)&7),this.getRM8(e)); return 3;
      case 0x3B: mr=this.nextB();e=this.decRM(mr);this.CMP16(this.getReg16((mr>>3)&7),this.getRM16(e)); return 3;
      case 0x3C: this.CMP8(this.al,this.nextB()); return 4;
      case 0x3D: this.CMP16(this.ax,this.nextW()); return 4;
      // ─ INC r16 ─
      case 0x40: this.ax=this.INC16(this.ax); return 2;
      case 0x41: this.cx=this.INC16(this.cx); return 2;
      case 0x42: this.dx=this.INC16(this.dx); return 2;
      case 0x43: this.bx=this.INC16(this.bx); return 2;
      case 0x44: this.sp=this.INC16(this.sp); return 2;
      case 0x45: this.bp=this.INC16(this.bp); return 2;
      case 0x46: this.si=this.INC16(this.si); return 2;
      case 0x47: this.di=this.INC16(this.di); return 2;
      // ─ DEC r16 ─
      case 0x48: this.ax=this.DEC16(this.ax); return 2;
      case 0x49: this.cx=this.DEC16(this.cx); return 2;
      case 0x4A: this.dx=this.DEC16(this.dx); return 2;
      case 0x4B: this.bx=this.DEC16(this.bx); return 2;
      case 0x4C: this.sp=this.DEC16(this.sp); return 2;
      case 0x4D: this.bp=this.DEC16(this.bp); return 2;
      case 0x4E: this.si=this.DEC16(this.si); return 2;
      case 0x4F: this.di=this.DEC16(this.di); return 2;
      // ─ PUSH r16 ─
      case 0x50: this.push(this.ax); return 11;
      case 0x51: this.push(this.cx); return 11;
      case 0x52: this.push(this.dx); return 11;
      case 0x53: this.push(this.bx); return 11;
      case 0x54: this.push(this.sp); return 11;
      case 0x55: this.push(this.bp); return 11;
      case 0x56: this.push(this.si); return 11;
      case 0x57: this.push(this.di); return 11;
      // ─ POP r16 ─
      case 0x58: this.ax=this.pop(); return 8;
      case 0x59: this.cx=this.pop(); return 8;
      case 0x5A: this.dx=this.pop(); return 8;
      case 0x5B: this.bx=this.pop(); return 8;
      case 0x5C: this.sp=this.pop(); return 8;
      case 0x5D: this.bp=this.pop(); return 8;
      case 0x5E: this.si=this.pop(); return 8;
      case 0x5F: this.di=this.pop(); return 8;
      // ─ PUSHA / POPA (80186) ─
      case 0x60: { const sp0=this.sp; this.push(this.ax);this.push(this.cx);this.push(this.dx);this.push(this.bx);this.push(sp0);this.push(this.bp);this.push(this.si);this.push(this.di); return 19; }
      case 0x61: { this.di=this.pop();this.si=this.pop();this.bp=this.pop();this.pop();this.bx=this.pop();this.dx=this.pop();this.cx=this.pop();this.ax=this.pop(); return 19; }
      // ─ BOUND (80186) - consume modrm, no fault check ─
      case 0x62: mr=this.nextB(); this.decRM(mr); return 6;
      // ─ PUSH imm / IMUL imm (80186) ─
      case 0x68: this.push(this.nextW()); return 3;
      case 0x6A: this.push(this.nextSB()&0xFFFF); return 3;
      case 0x69: { mr=this.nextB();e=this.decRM(mr);const src=this.getRM16(e);const imm=this.nextW();
        const a=src>=0x8000?src-0x10000:src; const b=imm>=0x8000?imm-0x10000:imm; const r=a*b;
        this.setReg16((mr>>3)&7, r&0xFFFF); this.CF=this.OF=(r<-32768||r>32767)?1:0; return 9; }
      case 0x6B: { mr=this.nextB();e=this.decRM(mr);const src=this.getRM16(e);const imm=this.nextSB();
        const a=src>=0x8000?src-0x10000:src; const r=a*imm;
        this.setReg16((mr>>3)&7, r&0xFFFF); this.CF=this.OF=(r<-32768||r>32767)?1:0; return 9; }
      // ─ INS / OUTS (80186 string I/O) ─
      case 0x6C: case 0x6D: case 0x6E: case 0x6F: this._strOp(op); return 8;
      // ─ Jcc short ─
      case 0x70: n=this.nextSB(); if(this.OF)  this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x71: n=this.nextSB(); if(!this.OF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x72: n=this.nextSB(); if(this.CF)  this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x73: n=this.nextSB(); if(!this.CF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x74: n=this.nextSB(); if(this.ZF)  this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x75: n=this.nextSB(); if(!this.ZF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x76: n=this.nextSB(); if(this.CF||this.ZF)   this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x77: n=this.nextSB(); if(!this.CF&&!this.ZF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x78: n=this.nextSB(); if(this.SF)  this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x79: n=this.nextSB(); if(!this.SF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x7A: n=this.nextSB(); if(this.PF)  this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x7B: n=this.nextSB(); if(!this.PF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x7C: n=this.nextSB(); if(this.SF!==this.OF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x7D: n=this.nextSB(); if(this.SF===this.OF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x7E: n=this.nextSB(); if(this.ZF||this.SF!==this.OF) this.ip=(this.ip+n)&0xFFFF; return 4;
      case 0x7F: n=this.nextSB(); if(!this.ZF&&this.SF===this.OF) this.ip=(this.ip+n)&0xFFFF; return 4;
      // ─ Grp1 imm8/16 ─
      case 0x80: { mr=this.nextB();e=this.decRM(mr);n=this.nextB();v=this.getRM8(e); this._grp1b((mr>>3)&7,e,v,n); return 4; }
      case 0x81: { mr=this.nextB();e=this.decRM(mr);n=this.nextW();v=this.getRM16(e);this._grp1w((mr>>3)&7,e,v,n); return 4; }
      case 0x82: { mr=this.nextB();e=this.decRM(mr);n=this.nextSB()&0xFF;v=this.getRM8(e);this._grp1b((mr>>3)&7,e,v,n); return 4; }
      case 0x83: { mr=this.nextB();e=this.decRM(mr);n=this.nextSB()&0xFFFF;v=this.getRM16(e);this._grp1w((mr>>3)&7,e,v,n); return 4; }
      // ─ TEST ─
      case 0x84: mr=this.nextB();e=this.decRM(mr);this.TEST8(this.getRM8(e),this.getReg8((mr>>3)&7)); return 3;
      case 0x85: mr=this.nextB();e=this.decRM(mr);this.TEST16(this.getRM16(e),this.getReg16((mr>>3)&7)); return 3;
      // ─ XCHG ─
      case 0x86: { mr=this.nextB();e=this.decRM(mr);const a=this.getRM8(e);const b=this.getReg8((mr>>3)&7);this.setRM8(e,b);this.setReg8((mr>>3)&7,a); return 4; }
      case 0x87: { mr=this.nextB();e=this.decRM(mr);const a=this.getRM16(e);const b=this.getReg16((mr>>3)&7);this.setRM16(e,b);this.setReg16((mr>>3)&7,a); return 4; }
      // ─ MOV ─
      case 0x88: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.getReg8((mr>>3)&7)); return 2;
      case 0x89: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.getReg16((mr>>3)&7)); return 2;
      case 0x8A: mr=this.nextB();e=this.decRM(mr);this.setReg8((mr>>3)&7,this.getRM8(e)); return 2;
      case 0x8B: mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,this.getRM16(e)); return 2;
      case 0x8C: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.getSReg((mr>>3)&3)); return 2;
      case 0x8D: { mr=this.nextB();e=this.decRM(mr);this.setReg16((mr>>3)&7,e.ea||0); return 2; } // LEA
      case 0x8E: mr=this.nextB();e=this.decRM(mr);this.setSReg((mr>>3)&3,this.getRM16(e)); return 2;
      // ─ POP r/m ─
      case 0x8F: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.pop()); return 8;
      // ─ NOP/XCHG AX,r ─
      case 0x90: return 3; // NOP
      case 0x91: v=this.ax;this.ax=this.cx;this.cx=v; return 3;
      case 0x92: v=this.ax;this.ax=this.dx;this.dx=v; return 3;
      case 0x93: v=this.ax;this.ax=this.bx;this.bx=v; return 3;
      case 0x94: v=this.ax;this.ax=this.sp;this.sp=v; return 3;
      case 0x95: v=this.ax;this.ax=this.bp;this.bp=v; return 3;
      case 0x96: v=this.ax;this.ax=this.si;this.si=v; return 3;
      case 0x97: v=this.ax;this.ax=this.di;this.di=v; return 3;
      // ─ CBW / CWD ─
      case 0x98: this.ax=(this.al>=0x80)?(this.al|0xFF00):(this.al&0x00FF); return 2;
      case 0x99: this.dx=(this.ax>=0x8000)?0xFFFF:0; return 5;
      // ─ CALL far ─
      case 0x9A: { off=this.nextW();seg=this.nextW();this.push(this.cs);this.push(this.ip);this.cs=seg;this.ip=off; return 28; }
      // ─ WAIT ─
      case 0x9B: return 4;
      // ─ PUSHF/POPF ─
      case 0x9C: this.push(this.flags|0xF002); return 10;
      case 0x9D: this.flags=(this.pop()|0x0002); return 8;
      // ─ SAHF/LAHF ─
      case 0x9E: this.flags=(this.flags&0xFF00)|(this.ah&0xD5)|0x02; return 4;
      case 0x9F: this.ah=(this.flags&0xFF)|0x02; return 4;
      // ─ MOV mem,AX / AX,mem ─
      case 0xA0: v=this.nextW();this.al=this.rb(this.seg2phys(this.effSeg(this.ds),v)); return 10;
      case 0xA1: v=this.nextW();this.ax=this.rw(this.seg2phys(this.effSeg(this.ds),v)); return 10;
      case 0xA2: v=this.nextW();this.wb(this.seg2phys(this.effSeg(this.ds),v),this.al); return 10;
      case 0xA3: v=this.nextW();this.ww(this.seg2phys(this.effSeg(this.ds),v),this.ax); return 10;
      // ─ String ops ─
      case 0xA4: this._strOp(0xA4); return 18;
      case 0xA5: this._strOp(0xA5); return 18;
      case 0xA6: this._strOp(0xA6); return 22;
      case 0xA7: this._strOp(0xA7); return 22;
      // ─ TEST AL/AX, imm ─
      case 0xA8: this.TEST8(this.al,this.nextB()); return 4;
      case 0xA9: this.TEST16(this.ax,this.nextW()); return 4;
      case 0xAA: this._strOp(0xAA); return 11;
      case 0xAB: this._strOp(0xAB); return 11;
      case 0xAC: this._strOp(0xAC); return 12;
      case 0xAD: this._strOp(0xAD); return 12;
      case 0xAE: this._strOp(0xAE); return 15;
      case 0xAF: this._strOp(0xAF); return 15;
      // ─ MOV AL/AX, imm ─
      case 0xB0: this.al=this.nextB(); return 4;
      case 0xB1: this.cl=this.nextB(); return 4;
      case 0xB2: this.dl=this.nextB(); return 4;
      case 0xB3: this.bl=this.nextB(); return 4;
      case 0xB4: this.ah=this.nextB(); return 4;
      case 0xB5: this.ch=this.nextB(); return 4;
      case 0xB6: this.dh=this.nextB(); return 4;
      case 0xB7: this.bh=this.nextB(); return 4;
      case 0xB8: this.ax=this.nextW(); return 4;
      case 0xB9: this.cx=this.nextW(); return 4;
      case 0xBA: this.dx=this.nextW(); return 4;
      case 0xBB: this.bx=this.nextW(); return 4;
      case 0xBC: this.sp=this.nextW(); return 4;
      case 0xBD: this.bp=this.nextW(); return 4;
      case 0xBE: this.si=this.nextW(); return 4;
      case 0xBF: this.di=this.nextW(); return 4;
      // ─ Shift/Rotate r/m, imm8 (80186) ─
      case 0xC0: { mr=this.nextB();e=this.decRM(mr);v=this.getRM8(e); n=this.nextB()&0x1F; this._shiftRot8((mr>>3)&7,e,v,n); return 5; }
      case 0xC1: { mr=this.nextB();e=this.decRM(mr);v=this.getRM16(e);n=this.nextB()&0x1F; this._shiftRot16((mr>>3)&7,e,v,n); return 5; }
      // ─ RET ─
      case 0xC2: n=this.nextW();this.ip=this.pop();this.sp=(this.sp+n)&0xFFFF; return 12;
      case 0xC3: this.ip=this.pop(); return 8;
      // ─ LES / LDS ─
      case 0xC4: { mr=this.nextB();e=this.decRM(mr);const ra=(mr>>3)&7;this.setReg16(ra,this.rw(e.addr));this.es=this.rw((e.addr+2)&0xFFFFF); return 16; }
      case 0xC5: { mr=this.nextB();e=this.decRM(mr);const ra=(mr>>3)&7;this.setReg16(ra,this.rw(e.addr));this.ds=this.rw((e.addr+2)&0xFFFFF); return 16; }
      // ─ MOV r/m, imm ─
      case 0xC6: mr=this.nextB();e=this.decRM(mr);this.setRM8(e, this.nextB()); return 10;
      case 0xC7: mr=this.nextB();e=this.decRM(mr);this.setRM16(e,this.nextW()); return 10;
      // ─ ENTER / LEAVE (80186) ─
      case 0xC8: { const size=this.nextW(); const lv=this.nextB()&0x1F;
        this.push(this.bp); const frame=this.sp;
        if (lv>0) { for (let i=1;i<lv;i++){ this.bp=(this.bp-2)&0xFFFF; this.push(this.rw(this.seg2phys(this.ss,this.bp))); } this.push(frame); }
        this.bp=frame; this.sp=(this.sp-size)&0xFFFF; return 15; }
      case 0xC9: this.sp=this.bp; this.bp=this.pop(); return 8;
      // ─ RET far ─
      case 0xCA: n=this.nextW();this.ip=this.pop();this.cs=this.pop();this.sp=(this.sp+n)&0xFFFF; return 17;
      case 0xCB: this.ip=this.pop();this.cs=this.pop(); return 15;
      // ─ INT ─
      case 0xCC: this.interrupt(3); return 52;
      case 0xCD: this.interrupt(this.nextB()); return 51;
      case 0xCE: if(this.OF) this.interrupt(4); return 4;
      // ─ IRET ─
      case 0xCF: this.ip=this.pop();this.cs=this.pop();this.flags=(this.pop()|0x0002); return 24;
      // ─ Shift/Rotate group ─
      case 0xD0: { mr=this.nextB();e=this.decRM(mr);v=this.getRM8(e); this._shiftRot8((mr>>3)&7,e,v,1); return 2; }
      case 0xD1: { mr=this.nextB();e=this.decRM(mr);v=this.getRM16(e);this._shiftRot16((mr>>3)&7,e,v,1); return 2; }
      case 0xD2: { mr=this.nextB();e=this.decRM(mr);v=this.getRM8(e); this._shiftRot8((mr>>3)&7,e,v,this.cl); return 8; }
      case 0xD3: { mr=this.nextB();e=this.decRM(mr);v=this.getRM16(e);this._shiftRot16((mr>>3)&7,e,v,this.cl); return 8; }
      // ─ AAM / AAD ─
      case 0xD4: n=this.nextB();if(!n){this.interrupt(0);return 4;} this.ah=(this.al/n)|0;this.al=this.al%n;this.szp8(this.al); return 83;
      case 0xD5: n=this.nextB();this.al=(this.ah*n+this.al)&0xFF;this.ah=0;this.szp8(this.al); return 60;
      case 0xD6: this.al=this.CF?0xFF:0; return 2; // SALC (undocumented)
      case 0xD7: this.al=this.rb(this.seg2phys(this.effSeg(this.ds),(this.bx+this.al)&0xFFFF)); return 11; // XLAT
      // ─ ESC (FPU): consume modrm/displacement, no-op ─
      case 0xD8: case 0xD9: case 0xDA: case 0xDB:
      case 0xDC: case 0xDD: case 0xDE: case 0xDF:
        mr=this.nextB(); this.decRM(mr); return 2;
      // ─ IN/OUT ─
      case 0xE4: this.al=this.io.read8(this.nextB()); return 10;
      case 0xE5: this.ax=this.io.read8(this.nextB()); return 10;
      case 0xE6: this.io.write8(this.nextB(),this.al); return 10;
      case 0xE7: this.io.write8(this.nextB(),this.al); return 10;
      case 0xEC: this.al=this.io.read8(this.dx); return 8;
      case 0xED: this.ax=this.io.read16(this.dx); return 8;
      case 0xEE: this.io.write8(this.dx,this.al); return 8;
      case 0xEF: this.io.write16(this.dx,this.ax); return 8;
      // ─ CALL near / JMP ─
      case 0xE8: n=this.nextSW();this.push(this.ip);this.ip=(this.ip+n)&0xFFFF; return 19;
      case 0xE9: { const d=this.nextSW(); this.ip=(this.ip+d)&0xFFFF; return 15; }
      case 0xEA: { off=this.nextW();seg=this.nextW();this.cs=seg;this.ip=off; return 15; }
      case 0xEB: { const d=this.nextSB(); this.ip=(this.ip+d)&0xFFFF; return 15; }
      // ─ LOOP ─
      case 0xE0: n=this.nextSB();this.cx=(this.cx-1)&0xFFFF;if(this.cx&&!this.ZF)this.ip=(this.ip+n)&0xFFFF; return 6;
      case 0xE1: n=this.nextSB();this.cx=(this.cx-1)&0xFFFF;if(this.cx&&this.ZF) this.ip=(this.ip+n)&0xFFFF; return 6;
      case 0xE2: n=this.nextSB();this.cx=(this.cx-1)&0xFFFF;if(this.cx)          this.ip=(this.ip+n)&0xFFFF; return 6;
      case 0xE3: n=this.nextSB();if(!this.cx) this.ip=(this.ip+n)&0xFFFF; return 6;
      // ─ HLT ─
      case 0xF4: this.halted=true; return 2;
      // ─ CMC ─
      case 0xF5: this.CF^=1; return 2;
      // ─ Grp3 ─
      case 0xF6: { mr=this.nextB();e=this.decRM(mr);this._grp3b((mr>>3)&7,e); return 4; }
      case 0xF7: { mr=this.nextB();e=this.decRM(mr);this._grp3w((mr>>3)&7,e); return 4; }
      // ─ Flags ─
      case 0xF8: this.CF=0; return 2;
      case 0xF9: this.CF=1; return 2;
      case 0xFA: this.IF=0; return 2;
      case 0xFB: this.IF=1; return 2;
      case 0xFC: this.DF=0; return 2;
      case 0xFD: this.DF=1; return 2;
      // ─ Grp4/5 ─
      case 0xFE: { mr=this.nextB();e=this.decRM(mr);const sub=(mr>>3)&7; if(sub===0)this.setRM8(e,this.INC8(this.getRM8(e))); else if(sub===1)this.setRM8(e,this.DEC8(this.getRM8(e))); return 3; }
      case 0xFF: { mr=this.nextB();e=this.decRM(mr);this._grp5((mr>>3)&7,e); return 5; }
      default:
        // Unknown opcode - skip (record for debugging if hook installed)
        if (this.unknownOps) {
          this.unknownOps.set(op, (this.unknownOps.get(op) || 0) + 1);
          if (this.unknownOpsAt && this.unknownOpsAt.size < 50)
            this.unknownOpsAt.add(`${op.toString(16)}@${this.cs.toString(16)}:${(this.ip-1).toString(16)}`);
        }
        return 4;
    }
  }

  _grp1b(sub, e, v, n) {
    switch (sub) {
      case 0: this.setRM8(e, this.ADD8(v, n)); break;
      case 1: this.setRM8(e, this.OR8(v, n));  break;
      case 2: this.setRM8(e, this.ADC8(v, n)); break;
      case 3: this.setRM8(e, this.SBB8(v, n)); break;
      case 4: this.setRM8(e, this.AND8(v, n)); break;
      case 5: this.setRM8(e, this.SUB8(v, n)); break;
      case 6: this.setRM8(e, this.XOR8(v, n)); break;
      case 7: this.CMP8(v, n);                 break;
    }
  }
  _grp1w(sub, e, v, n) {
    switch (sub) {
      case 0: this.setRM16(e,this.ADD16(v,n)); break;
      case 1: this.setRM16(e,this.OR16(v,n));  break;
      case 2: this.setRM16(e,this.ADC16(v,n)); break;
      case 3: this.setRM16(e,this.SBB16(v,n)); break;
      case 4: this.setRM16(e,this.AND16(v,n)); break;
      case 5: this.setRM16(e,this.SUB16(v,n)); break;
      case 6: this.setRM16(e,this.XOR16(v,n)); break;
      case 7: this.CMP16(v,n);                 break;
    }
  }
  _shiftRot8(sub, e, v, n) {
    let r;
    switch (sub) {
      case 0: r=this.ROL8(v,n); break; case 1: r=this.ROR8(v,n); break;
      case 2: r=this.RCL8(v,n); break; case 3: r=this.RCR8(v,n); break;
      case 4: case 6: r=this.SHL8(v,n); break;
      case 5: r=this.SHR8(v,n); break; case 7: r=this.SAR8(v,n); break;
      default: r=v;
    }
    this.setRM8(e, r);
  }
  _shiftRot16(sub, e, v, n) {
    let r;
    switch (sub) {
      case 0: r=this.ROL16(v,n); break; case 1: r=this.ROR16(v,n); break;
      case 2: r=this.RCL16(v,n); break; case 3: r=this.RCR16(v,n); break;
      case 4: case 6: r=this.SHL16(v,n); break;
      case 5: r=this.SHR16(v,n); break; case 7: r=this.SAR16(v,n); break;
      default: r=v;
    }
    this.setRM16(e, r);
  }
  _grp3b(sub, e) {
    const v = this.getRM8(e);
    switch (sub) {
      case 0: case 1: this.TEST8(v, this.nextB()); break;
      case 2: this.setRM8(e, this.NOT8(v)); break;
      case 3: this.setRM8(e, this.NEG8(v)); break;
      case 4: this.MUL8(v);  break;
      case 5: this.IMUL8(v); break;
      case 6: this.DIV8(v);  break;
      case 7: this.IDIV8(v); break;
    }
  }
  _grp3w(sub, e) {
    const v = this.getRM16(e);
    switch (sub) {
      case 0: case 1: this.TEST16(v, this.nextW()); break;
      case 2: this.setRM16(e,this.NOT16(v)); break;
      case 3: this.setRM16(e,this.NEG16(v)); break;
      case 4: this.MUL16(v);  break;
      case 5: this.IMUL16(v); break;
      case 6: this.DIV16(v);  break;
      case 7: this.IDIV16(v); break;
    }
  }
  _grp5(sub, e) {
    let v, off, seg;
    switch (sub) {
      case 0: this.setRM16(e,this.INC16(this.getRM16(e))); break;
      case 1: this.setRM16(e,this.DEC16(this.getRM16(e))); break;
      case 2: this.push(this.ip);this.ip=this.getRM16(e); break; // CALL near r/m
      case 3: // CALL far m16:16
        off=this.rw(e.addr); seg=this.rw((e.addr+2)&0xFFFFF);
        this.push(this.cs);this.push(this.ip);this.cs=seg;this.ip=off; break;
      case 4: this.ip=this.getRM16(e); break; // JMP near r/m
      case 5: // JMP far m16:16
        off=this.rw(e.addr); seg=this.rw((e.addr+2)&0xFFFFF);
        this.cs=seg;this.ip=off; break;
      case 6: this.push(this.getRM16(e)); break; // PUSH r/m
    }
  }

  // ── String operations ──────────────────────────────────────────────
  _strOp(op) {
    const rep = this.repPrefix;
    if (rep && !this.cx) return; // REP with CX=0: no-op
    do {
      switch (op) {
        case 0xA4: { // MOVSB
          const src=this.seg2phys(this.effSeg(this.ds),this.si);
          const dst=this.seg2phys(this.es,this.di);
          this.wb(dst, this.rb(src));
          const d=this.DF?-1:1;
          this.si=(this.si+d)&0xFFFF; this.di=(this.di+d)&0xFFFF;
          break;
        }
        case 0xA5: { // MOVSW
          const src=this.seg2phys(this.effSeg(this.ds),this.si);
          const dst=this.seg2phys(this.es,this.di);
          this.ww(dst,this.rw(src));
          const d=this.DF?-2:2;
          this.si=(this.si+d)&0xFFFF; this.di=(this.di+d)&0xFFFF;
          break;
        }
        case 0xA6: { // CMPSB
          const a=this.rb(this.seg2phys(this.effSeg(this.ds),this.si));
          const b=this.rb(this.seg2phys(this.es,this.di));
          this.SUB8(a,b);
          const d=this.DF?-1:1;
          this.si=(this.si+d)&0xFFFF; this.di=(this.di+d)&0xFFFF;
          break;
        }
        case 0xA7: { // CMPSW
          const a=this.rw(this.seg2phys(this.effSeg(this.ds),this.si));
          const b=this.rw(this.seg2phys(this.es,this.di));
          this.SUB16(a,b);
          const d=this.DF?-2:2;
          this.si=(this.si+d)&0xFFFF; this.di=(this.di+d)&0xFFFF;
          break;
        }
        case 0x6C: { // INSB
          this.wb(this.seg2phys(this.es,this.di),this.io.read8(this.dx));
          this.di=(this.di+(this.DF?-1:1))&0xFFFF;
          break;
        }
        case 0x6D: { // INSW
          const dst=this.seg2phys(this.es,this.di);
          this.wb(dst,this.io.read8(this.dx));
          this.wb(dst+1,this.io.read8(this.dx));
          this.di=(this.di+(this.DF?-2:2))&0xFFFF;
          break;
        }
        case 0x6E: { // OUTSB
          this.io.write8(this.dx,this.rb(this.seg2phys(this.effSeg(this.ds),this.si)));
          this.si=(this.si+(this.DF?-1:1))&0xFFFF;
          break;
        }
        case 0x6F: { // OUTSW
          const src=this.seg2phys(this.effSeg(this.ds),this.si);
          this.io.write8(this.dx,this.rb(src));
          this.io.write8(this.dx,this.rb(src+1));
          this.si=(this.si+(this.DF?-2:2))&0xFFFF;
          break;
        }
        case 0xAA: { // STOSB
          this.wb(this.seg2phys(this.es,this.di),this.al);
          this.di=(this.di+(this.DF?-1:1))&0xFFFF;
          break;
        }
        case 0xAB: { // STOSW
          this.ww(this.seg2phys(this.es,this.di),this.ax);
          this.di=(this.di+(this.DF?-2:2))&0xFFFF;
          break;
        }
        case 0xAC: { // LODSB
          this.al=this.rb(this.seg2phys(this.effSeg(this.ds),this.si));
          this.si=(this.si+(this.DF?-1:1))&0xFFFF;
          break;
        }
        case 0xAD: { // LODSW
          this.ax=this.rw(this.seg2phys(this.effSeg(this.ds),this.si));
          this.si=(this.si+(this.DF?-2:2))&0xFFFF;
          break;
        }
        case 0xAE: { // SCASB
          const v=this.rb(this.seg2phys(this.es,this.di));
          this.SUB8(this.al,v);
          this.di=(this.di+(this.DF?-1:1))&0xFFFF;
          break;
        }
        case 0xAF: { // SCASW
          const v=this.rw(this.seg2phys(this.es,this.di));
          this.SUB16(this.ax,v);
          this.di=(this.di+(this.DF?-2:2))&0xFFFF;
          break;
        }
      }
      if (rep) {
        this.cx = (this.cx - 1) & 0xFFFF;
        if (!this.cx) break;
        // ZF check only applies to CMPS/SCAS
        if (op === 0xA6 || op === 0xA7 || op === 0xAE || op === 0xAF) {
          if (rep === 0xF2 && this.ZF)  break; // REPNE: stop if match
          if (rep === 0xF3 && !this.ZF) break; // REPE:  stop if no match
        }
      }
    } while (rep && this.cx);
  }

  reset() {
    this.ax=this.bx=this.cx=this.dx=0;
    this.si=this.di=this.bp=0;
    this.sp=0xFFFE;
    this.ip=0xFFF0; this.cs=0xF000;
    this.ds=this.es=this.ss=0;
    this.flags=0x0002;
    this.halted=false;
    this.segOvr=-1;
    this.repPrefix=0;
    this._interruptQueue=[];
    this.totalCycles=0;
  }
}
