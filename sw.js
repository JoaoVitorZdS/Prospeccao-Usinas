// sw.js — service worker "Nível 0" (seção 8 do plano): app shell cacheado,
// abre offline sem tela de erro, escrita continua bloqueada pelo próprio app
// quando offline (banner de conectividade em app.js). Sem fila de sync — Níveis
// 2–3 custam mais que o resto do CRM somado e só entram com dor medida.
//
// Escrito à mão em vez de Serwist/Workbox de propósito: esta versão autocontida
// não tem passo de build (sem Next.js/Turbopack), então um SW hand-rolled é o
// que fica sem dependência nenhuma. Se a versão Next.js do plano nascer depois,
// troca por `@serwist/turbopack` sem mudar o contrato de cache abaixo.

const VERSAO = 'lex-prospecta-v3';
const CACHE_SHELL = `${VERSAO}-shell`;

const ARQUIVOS_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './vendor/supabase-js-2.112.3.umd.js',
  './js/supabase-config.js',
  './js/app.js',
  './js/util.js',
  './js/seed.js',
  './js/db.js',
  './js/parse.js',
  './js/aneel.js',
  './js/enriquecer.js',
  './js/exporta.js',
  './js/ui.js',
  './js/views/fila.js',
  './js/views/conversas.js',
  './js/views/descobrir.js',
  './js/views/importar.js',
  './js/views/painel.js',
  './js/views/exportar.js',
  './js/views/config.js',
  './js/views/cockpit.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE_SHELL);
    // addAll aborta tudo se um item falhar; adiciona um a um para não perder o shell inteiro por 1 arquivo
    await Promise.all(ARQUIVOS_SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); } catch { /* segue sem esse arquivo */ }
    }));
  })());
  // não chama skipWaiting aqui — só troca de versão quando o usuário confirma (ver 'pular-espera')
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes
      .filter((n) => n.startsWith('lex-prospecta-') && n !== CACHE_SHELL)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (ev) => {
  if (ev.data === 'pular-espera') self.skipWaiting();
});

/** Navegação (abrir o app): shell primeiro, sempre — é o que garante abrir offline. */
async function respostaNavegacao(req) {
  const cache = await caches.open(CACHE_SHELL);
  try {
    const rede = await fetch(req);
    if (rede.ok) cache.put('./index.html', rede.clone());
    return rede;
  } catch {
    return (await cache.match('./index.html')) || Response.error();
  }
}

/** Estáticos do próprio app: cache-first, atualiza em segundo plano (stale-while-revalidate). */
async function respostaEstatico(req) {
  const cache = await caches.open(CACHE_SHELL);
  const doCache = await cache.match(req);
  const buscaRede = fetch(req).then((rede) => {
    if (rede.ok) cache.put(req, rede.clone());
    return rede;
  }).catch(() => null);
  return doCache || (await buscaRede) || Response.error();
}

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return; // POST/PATCH (Supabase, enriquecimento de CNPJ) sempre vai direto à rede

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase/OpenCNPJ/BrasilAPI: não interceptar

  if (req.mode === 'navigate') {
    ev.respondWith(respostaNavegacao(req));
    return;
  }
  if (ARQUIVOS_SHELL.some((a) => url.pathname.endsWith(a.replace('./', '/')))
    || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.png')) {
    ev.respondWith(respostaEstatico(req));
  }
});
