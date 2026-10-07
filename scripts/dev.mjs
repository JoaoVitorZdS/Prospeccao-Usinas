#!/usr/bin/env node
// Servidor estático de desenvolvimento do WattScout — sem dependências, sem build.
//
// Uso:   pnpm dev            (http://localhost:8080)
//        pnpm dev -- --port 3000 --open
//        PORT=3000 pnpm dev
//
// Por que existe: o app usa módulos ES e service worker, que não funcionam em file://.
// `localhost` conta como contexto seguro, então o service worker e o login funcionam aqui.
// Tudo sai com `Cache-Control: no-store` para você sempre ver a última edição.

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const RAIZ = resolve(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
const valorDe = (nome) => {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORTA = Number(valorDe('--port') || process.env.PORT || 8080);
const HOST = valorDe('--host') || process.env.HOST || '127.0.0.1';
const ABRIR = args.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// Pastas que nunca devem ser servidas, mesmo em desenvolvimento.
const BLOQUEADAS = ['.git', 'node_modules', 'mcp/dados'];

function resolverArquivo(urlPath) {
  let caminho;
  try {
    caminho = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (caminho.includes('\0')) return null;
  const alvo = normalize(join(RAIZ, caminho));
  if (alvo !== RAIZ && !alvo.startsWith(RAIZ + sep)) return null; // fuga da raiz
  const relativo = alvo.slice(RAIZ.length + 1).split(sep).join('/');
  if (BLOQUEADAS.some((b) => relativo === b || relativo.startsWith(`${b}/`))) return null;
  try {
    const st = statSync(alvo);
    if (st.isDirectory()) {
      const indice = join(alvo, 'index.html');
      return statSync(indice).isFile() ? indice : null;
    }
    return st.isFile() ? alvo : null;
  } catch {
    return null;
  }
}

const servidor = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const arquivo = resolverArquivo(req.url || '/');
  if (!arquivo) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('404 — não encontrado\n');
    console.log(`  404 ${req.url}`);
    return;
  }
  const cabecalhos = {
    'Content-Type': MIME[extname(arquivo).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (arquivo.endsWith(`${sep}sw.js`)) cabecalhos['Service-Worker-Allowed'] = '/';
  res.writeHead(200, cabecalhos);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(arquivo).on('error', () => res.destroy()).pipe(res);
});

servidor.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nA porta ${PORTA} já está em uso. Tente: pnpm dev -- --port ${PORTA + 1}\n`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

servidor.listen(PORTA, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORTA}`;
  console.log(`\n  WattScout (dev) → ${url}\n  Ctrl+C para parar.\n`);
  if (ABRIR) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }
});
