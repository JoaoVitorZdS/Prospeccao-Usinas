#!/usr/bin/env python3
"""Gera os ícones do PWA sem dependência externa (só stdlib).

Uso:  python3 icons/gen-icons.py
Saída: icon-192.png, icon-512.png, icon-maskable-512.png, favicon-32.png
"""
import os
import struct
import zlib

BG = (0x0E, 0x1B, 0x2E)      # navy profundo
FG = (0xF7, 0xB5, 0x2B)      # âmbar
ACCENT = (0x3D, 0xDC, 0x97)  # verde (traço de base)

# Raio (bolt) em coordenadas normalizadas 0..1
BOLT = [
    (0.585, 0.055), (0.235, 0.560), (0.455, 0.560),
    (0.398, 0.945), (0.762, 0.430), (0.535, 0.430),
]
# Traço de base (linha do "solo") — dá leitura de usina/geração
BASE = [(0.20, 0.845), (0.30, 0.845), (0.30, 0.895), (0.20, 0.895)]
BASE2 = [(0.62, 0.845), (0.80, 0.845), (0.80, 0.895), (0.62, 0.895)]

SS = 3  # supersampling por eixo (3x3 = 9 amostras/px)


def in_poly(pts, x, y):
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def in_rrect(x, y, r):
    """Quadrado 0..1 com cantos arredondados de raio r."""
    if x < 0 or x > 1 or y < 0 or y > 1:
        return False
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def blend(dst, src, a):
    return tuple(int(round(d + (s - d) * a)) for d, s in zip(dst, src))


def render(size, maskable=False):
    radius = 0.0 if maskable else 0.22
    # área útil: maskable precisa caber na safe zone (80% central)
    scale = 0.72 if maskable else 1.0
    off = (1 - scale) / 2
    px = bytearray()
    inv = 1.0 / size
    step = inv / SS
    half = step / 2
    for py in range(size):
        px.append(0)  # filter type 0
        for pxi in range(size):
            cov_bg = 0
            cov_fg = 0
            cov_ac = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = pxi * inv + sx * step + half
                    y = py * inv + sy * step + half
                    if maskable or in_rrect(x, y, radius):
                        cov_bg += 1
                    gx = (x - off) / scale
                    gy = (y - off) / scale
                    if in_poly(BOLT, gx, gy):
                        cov_fg += 1
                    elif in_poly(BASE, gx, gy) or in_poly(BASE2, gx, gy):
                        cov_ac += 1
            total = SS * SS
            a_bg = cov_bg / total
            if a_bg == 0:
                px += bytes((0, 0, 0, 0))
                continue
            color = BG
            if cov_fg:
                color = blend(color, FG, cov_fg / total)
            if cov_ac:
                color = blend(color, ACCENT, cov_ac / total)
            px += bytes((color[0], color[1], color[2], int(round(a_bg * 255))))
    return bytes(px)


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size, raw):
    hdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', hdr)
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(png)
    print('%-28s %6.1f KiB' % (os.path.basename(path), len(png) / 1024))


if __name__ == '__main__':
    here = os.path.dirname(os.path.abspath(__file__))
    for size in (192, 512):
        write_png(os.path.join(here, 'icon-%d.png' % size), size, render(size))
    write_png(os.path.join(here, 'icon-maskable-512.png'), 512,
              render(512, maskable=True))
    write_png(os.path.join(here, 'favicon-32.png'), 32, render(32))
