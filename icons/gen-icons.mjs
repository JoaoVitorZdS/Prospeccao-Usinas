#!/usr/bin/env node
// Gera os ícones do PWA WattScout sem dependência externa (só Node).
//
// Uso:    node icons/gen-icons.mjs
// Saída:  icon-192.png, icon-512.png, icon-maskable-512.png, favicon-32.png
//
// Marca: um sol (energia solar) com um raio recortado (geração) e um anel de
// "radar" em volta (scout). Desenho próprio — não reproduz marca de terceiros.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = [0x06, 0x39, 0x40];      // kale-900 do Garden — fundo
const SOL = [0xFC, 0xA3, 0x47];     // yellow-400 — disco solar
const ANEL = [0x4A, 0x99, 0x99];    // kale-600 — anel de radar

// Raio (bolt) em coordenadas normalizadas 0..1, centrado no disco
const BOLT = [
  [0.545, 0.285], [0.395, 0.520], [0.490, 0.520],
  [0.455, 0.715], [0.610, 0.470], [0.515, 0.470],
];

const SS = 3; // supersampling por eixo (3x3 = 9 amostras por pixel)

function dentroPoligono(pts, x, y) {
  let dentro = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function dentroRetanguloArredondado(x, y, r) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const misturar = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function renderizar(tamanho, maskable = false) {
  const raio = maskable ? 0 : 0.22;
  const escala = maskable ? 0.72 : 1; // maskable: conteúdo na safe zone central
  const desloc = (1 - escala) / 2;
  const linhas = [];
  const passo = 1 / tamanho / SS;
  for (let py = 0; py < tamanho; py++) {
    const linha = Buffer.alloc(1 + tamanho * 4); // byte 0 = filtro 0
    for (let px = 0; px < tamanho; px++) {
      let covFundo = 0, covSol = 0, covAnel = 0, covBolt = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px / tamanho + sx * passo + passo / 2;
          const y = py / tamanho + sy * passo + passo / 2;
          if (maskable || dentroRetanguloArredondado(x, y, raio)) covFundo++;
          const gx = (x - desloc) / escala;
          const gy = (y - desloc) / escala;
          const d = Math.hypot(gx - 0.5, gy - 0.5);
          if (d <= 0.30) {
            covSol++;
            if (dentroPoligono(BOLT, gx, gy)) covBolt++;
          } else if (d >= 0.37 && d <= 0.405) covAnel++;
        }
      }
      const total = SS * SS;
      const aFundo = covFundo / total;
      const o = 1 + px * 4;
      if (aFundo === 0) continue; // transparente
      let cor = BG;
      if (covAnel) cor = misturar(cor, ANEL, covAnel / total);
      if (covSol) cor = misturar(cor, SOL, covSol / total);
      if (covBolt) cor = misturar(cor, BG, covBolt / total);
      linha[o] = cor[0]; linha[o + 1] = cor[1]; linha[o + 2] = cor[2];
      linha[o + 3] = Math.round(aFundo * 255);
    }
    linhas.push(linha);
  }
  return Buffer.concat(linhas);
}

// CRC32 (PNG) — tabela calculada uma vez
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function bloco(tag, dados) {
  const comp = Buffer.alloc(4);
  comp.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tag, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([comp, corpo, crc]);
}

function escreverPng(caminho, tamanho, bruto) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tamanho, 0);
  ihdr.writeUInt32BE(tamanho, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    bloco('IHDR', ihdr),
    bloco('IDAT', deflateSync(bruto, { level: 9 })),
    bloco('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(caminho, png);
  console.log(`${basename(caminho).padEnd(24)} ${(png.length / 1024).toFixed(1)} KiB`);
}

const aqui = dirname(fileURLToPath(import.meta.url));
for (const t of [192, 512]) escreverPng(join(aqui, `icon-${t}.png`), t, renderizar(t));
escreverPng(join(aqui, 'icon-maskable-512.png'), 512, renderizar(512, true));
escreverPng(join(aqui, 'favicon-32.png'), 32, renderizar(32));
