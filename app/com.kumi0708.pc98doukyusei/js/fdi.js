'use strict';

// FDI disk image format parser
// Header: 4096 bytes (offset 0x1000), then raw sector data
// Layout: tracks * sides * sectors * sector_size
class FDI {
  constructor(buffer) {
    const u8 = new Uint8Array(buffer);
    const u32 = (off) => u8[off]|(u8[off+1]<<8)|(u8[off+2]<<16)|(u8[off+3]<<24);

    this.headerSize   = u32(8);   // 0x1000 = 4096
    this.diskSize     = u32(12);  // raw data size
    this.sectorSize   = u32(16);  // bytes per sector (1024 for 2HD)
    this.sectorsPerTrk= u32(20);  // sectors per track
    this.sides        = u32(24);  // number of sides
    this.tracks       = u32(28);  // tracks per side

    // Defaults for standard 2HD if header seems zero
    if (!this.sectorSize)    this.sectorSize    = 1024;
    if (!this.sectorsPerTrk) this.sectorsPerTrk = 8;
    if (!this.sides)         this.sides         = 2;
    if (!this.tracks)        this.tracks        = 77;
    if (!this.headerSize)    this.headerSize    = 4096;

    // Extract raw disk data
    this.data = u8.slice(this.headerSize);
    this.writeProtect = false;
  }

  // Compute byte offset for given CHS (0-based cylinder, 0-based head, 1-based sector)
  _offset(cylinder, head, sector) {
    const trackIdx = cylinder * this.sides + head;
    const secIdx   = sector - 1; // sectors are 1-based
    return (trackIdx * this.sectorsPerTrk + secIdx) * this.sectorSize;
  }

  // Read one sector into dst Uint8Array
  readSector(cylinder, head, sector, dst) {
    const off = this._offset(cylinder, head, sector);
    if (off + this.sectorSize > this.data.length) return false;
    dst.set(this.data.subarray(off, off + this.sectorSize));
    return true;
  }

  // Write one sector from src Uint8Array
  writeSector(cylinder, head, sector, src) {
    if (this.writeProtect) return false;
    const off = this._offset(cylinder, head, sector);
    if (off + this.sectorSize > this.data.length) return false;
    this.data.set(src.subarray(0, this.sectorSize), off);
    return true;
  }

  isValid() {
    return this.data && this.data.length > 0;
  }

  get typeStr() {
    if (this.sides === 2 && this.tracks === 77 && this.sectorSize === 1024) return '2HD';
    if (this.sides === 2 && this.tracks === 80 && this.sectorSize === 512)  return '2DD';
    return 'FDI';
  }
}
