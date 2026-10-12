#!/usr/bin/env python3
"""Generate the PWA / home-screen icons for Jarvis.

Pure standard library (zlib + struct) so it runs anywhere with Python 3 and
adds no dependency to the project. Re-run it whenever the orb look changes:

    python3 tools/make-icons.py
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent
BG = (0x0A, 0x0C, 0x14)          # --bg from the app
ACCENT = (0x4F, 0x8C, 0xFF)      # --accent from the app
CYAN = (0x9E, 0xE0, 0xFF)
VIOLET = (0xB1, 0x8C, 0xFF)


def lerp(a, b, t):
    t = max(0.0, min(1.0, t))
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def smoothstep(edge0, edge1, x):
    if edge1 == edge0:
        return 0.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def render(size, orb_ratio):
    """RGBA bytearray of a glowing orb on the dark background."""
    buf = bytearray(size * size * 4)
    cx = cy = (size - 1) / 2.0
    r = orb_ratio * size
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy)
            core = 1.0 - smoothstep(r * 0.62, r * 1.04, d)
            halo = math.exp(-((d / (r * 1.85)) ** 2)) * 0.6
            rim = math.exp(-(((d - r * 1.02) ** 2) / (2 * (size * 0.03) ** 2))) * 0.32
            t = min(d / r, 1.0)
            col = mix(CYAN, ACCENT, t)
            if d > r * 0.9:
                col = mix(col, VIOLET, smoothstep(r * 0.9, r * 1.25, d) * 0.85)
            a = min(1.0, core * 0.92 + halo + rim)
            # composite over the dark background
            rr = lerp(BG[0], col[0], a)
            gg = lerp(BG[1], col[1], a)
            bb = lerp(BG[2], col[2], a)
            i = (y * size + x) * 4
            buf[i] = int(round(rr))
            buf[i + 1] = int(round(gg))
            buf[i + 2] = int(round(bb))
            buf[i + 3] = 255
    return buf


def downscale(buf, src, dst):
    """Box-filter downscale of an RGBA buffer."""
    out = bytearray(dst * dst * 4)
    f = src / dst
    for y in range(dst):
        y0, y1 = int(y * f), max(int(y * f) + 1, int((y + 1) * f))
        for x in range(dst):
            x0, x1 = int(x * f), max(int(x * f) + 1, int((x + 1) * f))
            n = (x1 - x0) * (y1 - y0)
            acc = [0, 0, 0, 0]
            for yy in range(y0, y1):
                base = yy * src
                for xx in range(x0, x1):
                    i = (base + xx) * 4
                    acc[0] += buf[i]
                    acc[1] += buf[i + 1]
                    acc[2] += buf[i + 2]
                    acc[3] += buf[i + 3]
            o = (y * dst + x) * 4
            for k in range(4):
                out[o + k] = acc[k] // n
    return out


def write_png(path, buf, size):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter: none
        raw += buf[y * stride : (y + 1) * stride]

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    path.write_bytes(png)
    return len(png)


def main():
    master = 512
    # 'any' purpose: orb with breathing room
    normal = render(master, 0.30)
    # 'maskable' purpose: keep the orb inside the 80% safe zone (0.40 * 0.8 / 2 = 0.16... use 0.24 radius)
    maskable = render(master, 0.24)

    jobs = [
        ('icon-512.png', normal, master),
        ('icon-192.png', normal, 192),
        ('apple-touch-icon.png', normal, 180),
        ('icon-maskable-512.png', maskable, master),
    ]
    for name, buf, size in jobs:
        out = buf if size == master else downscale(buf, master, size)
        n = write_png(OUT / name, out, size)
        print(f'{name:24} {size}x{size}  {n // 1024} KB')


if __name__ == '__main__':
    main()
