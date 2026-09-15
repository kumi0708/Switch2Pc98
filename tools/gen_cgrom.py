# Generate a PC-98 style CG ROM bitmap (cgrom.bin) from MS Gothic so the
# emulator does not depend on the runtime's fonts / TextDecoder('shift_jis').
#
# Layout:
#   0x0000 .. 0x0FFF : ANK  256 glyphs x 16 rows x 1 byte  (8x16, MSB = left)
#   0x1000 ..        : JIS X 0208 kanji 94x94 glyphs x 16 rows x 2 bytes
#                      (16x16, big-endian: byte0 = left 8 px, byte1 = right 8 px)
#                      index = (j1-0x21)*94 + (j2-0x21)
import sys
from PIL import Image, ImageDraw, ImageFont

FONT = r"C:\Windows\Fonts\msgothic.ttc"
out_path = sys.argv[1] if len(sys.argv) > 1 else "cgrom.bin"

font = ImageFont.truetype(FONT, 16, index=0)

def raster(ch, w):
    img = Image.new("L", (w, 16), 0)
    d = ImageDraw.Draw(img)
    d.text((0, 0), ch, font=font, fill=255)
    px = img.load()
    rows = []
    for y in range(16):
        bits = 0
        for x in range(w):
            if px[x, y] > 96:
                bits |= 1 << (w - 1 - x)
        rows.append(bits)
    return rows

out = bytearray()
# ---- ANK 8x16 ----
for c in range(256):
    ch = None
    if 0x20 <= c < 0x7F:
        ch = chr(c)
    elif 0xA1 <= c <= 0xDF:
        ch = chr(0xFF61 + c - 0xA1)  # halfwidth katakana
    if ch is None:
        out += bytes(16)
        continue
    rows = raster(ch, 8)
    out += bytes(r & 0xFF for r in rows)
assert len(out) == 4096

# ---- JIS X 0208 16x16 ----
count = 0
for j1 in range(0x21, 0x7F):
    for j2 in range(0x21, 0x7F):
        # JIS -> Shift_JIS
        s1 = ((j1 + 1) >> 1) + (0x70 if j1 < 0x5F else 0xB0)
        s2 = j2 + ((0x1F if j2 < 0x60 else 0x20) if (j1 & 1) else 0x7E)
        try:
            ch = bytes([s1, s2]).decode("cp932")
        except Exception:
            ch = None
        if ch is None or len(ch) != 1:
            out += bytes(32)
            continue
        rows = raster(ch, 16)
        for r in rows:
            out += bytes([(r >> 8) & 0xFF, r & 0xFF])
        count += 1

with open(out_path, "wb") as f:
    f.write(out)
print("wrote", out_path, len(out), "bytes; kanji glyphs:", count)
