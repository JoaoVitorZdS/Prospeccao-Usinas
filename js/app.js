// app.js — bootstrap, shell e roteamento.

import { h, $, fmtNum, hojeISO } from './util.js';
import { abrir, semearConcessionarias, perfis, criarPerfil, perfilAtual,
  definirPerfilAtual, getConfig, setConfig, contar, buscarLeads } from './db.js';
import { registrarRota, renderRota, navegar, toast, modal, drawerEstaAberto, fecharDrawer,
  icone, avatar, menuSuspenso } from './ui.js';
import { viewFila } from './views/fila.js';
import { viewConversas } from './views/conversas.js';
import { viewDescobrir } from './views/descobrir.js';
import { viewBacklog } from './views/backlog.js';
import { viewImportar } from './views/importar.js';
import { viewPainel } from './views/painel.js';
import { viewExportar } from './views/exportar.js';
import { viewConfig } from './views/config.js';

// Barra lateral (rail). Os ids de rota ainda são os antigos (fila, conversas, descobrir…);
// só os rótulos mudaram — a renomeação das rotas acontece junto com cada tela refeita.
const NAV_TOPO = [
  { rota: 'fila', label: 'Leads', icone: 'leads' },
  { rota: 'conversas', label: 'Comunicações', icone: 'conversas' },
  { rota: 'descobrir', label: 'Prospecção', icone: 'prospeccao' },
  { rota: 'backlog', label: 'Mercado', icone: 'mercado' },
  { rota: 'painel', label: 'Relatórios', icone: 'relatorios' },
  { rota: 'importar', label: 'Importar', icone: 'importar' },
  { rota: 'exportar', label: 'Exportar', icone: 'exportar' },
];
const NAV_BASE = [
  { rota: 'config', label: 'Admin', icone: 'admin' },
];

const ctxApp = { perfil: null, ehGestor: false, recarregarApp: null };

/* ═══════════════ Onboarding ═══════════════ */

/** Sem Entra ID, o "login" é a identificação local do agente. */
function pedirPerfil(existentes) {
  return new Promise((resolve) => {
    const nome = h('input', { type: 'text', placeholder: 'Seu nome', autofocus: true });
    const email = h('input', { type: 'email', placeholder: 'voce@alexandriabr.com' });
    const papel = h('select', {},
      h('option', { value: 'gestor' }, 'Gestor — vejo tudo e distribuo leads'),
      h('option', { value: 'agente' }, 'Agente — vejo a minha carteira'));

    const listaExistente = existentes.length
      ? h('div', { class: 'onb__existentes' },
        h('p', { class: 'texto-fraco' }, 'Ou entre como alguém já cadastrado:'),
        h('div', { class: 'linha-botoes' }, existentes.map((p) =>
          h('button', {
            class: 'btn',
            onclick: async () => {
              await definirPerfilAtual(p.id);
              m.fechar();
              resolve(p);
            },
          }, p.nome, h('em', {}, p.papel)))))
      : null;

    const m = modal({
      titulo: existentes.length ? 'Quem está usando?' : 'Bem-vindo ao WattScout',
      largura: '560px',
      corpo: h('div', {},
        !existentes.length
          ? h('p', { class: 'texto' },
            'Os dados ficam no Supabase da equipe, compartilhados entre todos os agentes — '
            + 'ainda sem login de verdade, então diga quem você é para que os leads e os '
            + 'toques fiquem com autoria.')
          : null,
        h('div', { class: 'form' },
          h('label', { class: 'campo' }, h('span', {}, 'Nome'), nome),
          h('label', { class: 'campo' }, h('span', {}, 'E-mail'), email),
          h('label', { class: 'campo' }, h('span', {}, 'Papel'), papel,
            h('small', {}, 'O primeiro cadastro costuma ser gestor. Dá para mudar depois em Config.'))),
        listaExistente),
      acoes: [{
        label: 'Começar',
        classe: 'btn--primario',
        onclick: async () => {
          if (!nome.value.trim() || !email.value.trim()) {
            toast('Preencha nome e e-mail.', 'erro');
            return false;
          }
          const p = await criarPerfil({
            nome: nome.value.trim(),
            email: email.value.trim(),
            papel: papel.value,
          });
          await definirPerfilAtual(p.id);
          resolve(p);
          return true;
        },
      }],
    });
  });
}

/* ═══════════════ Shell ═══════════════ */

function itemRail(n, extra) {
  return h('a', {
    class: 'rail__item', href: `#/${n.rota}`, dataset: { rota: n.rota, rotulo: n.label },
    'aria-label': n.label,
  }, icone(n.icone), extra || null);
}

function montarShell() {
  const badgeFila = h('span', { class: 'rail__contador', id: 'contador-fila', hidden: true });

  const rail = h('nav', { class: 'rail', 'aria-label': 'Navegação principal' },
    h('a', { class: 'rail__marca', href: '#/fila', 'aria-label': 'WattScout — início', title: 'WattScout' },
      h('img', { src: 'icons/icon-192.png', alt: '', width: '32', height: '32' })),
    h('div', { class: 'rail__itens' },
      NAV_TOPO.map((n) => itemRail(n, n.rota === 'fila' ? badgeFila : null))),
    h('div', { class: 'rail__base' }, NAV_BASE.map((n) => itemRail(n))));

  // busca global: manda o texto para a lista de leads (que já busca nome, CNPJ, telefone, cidade…)
  const campoBusca = h('input', {
    type: 'search', id: 'busca-global', placeholder: 'Buscar leads, CNPJ, telefone…  ( / )',
    'aria-label': 'Buscar em todos os seus leads', autocomplete: 'off',
  });
  const busca = h('form', {
    class: 'topo__busca', role: 'search',
    onsubmit: (e) => {
      e.preventDefault();
      const q = campoBusca.value.trim();
      if (q) navegar('fila', { f: 'meus', q });
    },
  }, icone('busca', { tamanho: 'peq' }), campoBusca);

  const botaoNovo = h('button', { class: 'btn btn--primario btn--mini', type: 'button' },
    icone('mais', { tamanho: 'peq' }), 'Novo');
  const menuNovo = menuSuspenso(botaoNovo, [
    { rotulo: 'Importar planilha', icone: 'importar', onclick: () => navegar('importar') },
    { rotulo: 'Prospectar usinas', icone: 'prospeccao', onclick: () => navegar('descobrir') },
  ]);

  const topo = h('header', { class: 'topo' },
    busca,
    h('div', { class: 'topo__dir' }, menuNovo));

  document.body.prepend(rail, topo);
  return { badgeFila };
}

/** Redesenha o avatar do topo e o menu do usuário (o menu precisa do perfil atual). */
async function atualizarChip() {
  const p = ctxApp.perfil;
  // botão novo a cada chamada: menuSuspenso() registra o clique no botão que recebe
  const chip = h('button', { class: 'perfil-chip', id: 'perfil-chip', type: 'button' });
  chip.replaceChildren(
    avatar(p.nome),
    h('span', { class: 'perfil-chip__nome' }, p.nome),
    h('span', { class: 'perfil-chip__papel' }, p.papel));
  chip.setAttribute('aria-label', `Menu de ${p.nome}`);

  const antigo = document.getElementById('menu-usuario');
  const menu = menuSuspenso(chip, [
    {
      cabecalho: h('div', { class: 'menu__cab-conteudo', style: 'display:flex;gap:10px;align-items:center' },
        avatar(p.nome, { tamanho: 'grande' }),
        h('div', {}, h('strong', {}, p.nome), p.email ? h('small', {}, p.email) : null, h('small', {}, p.papel))),
    },
    { rotulo: 'Configurações', icone: 'admin', onclick: () => navegar('config') },
    { sep: true },
    {
      rotulo: 'Trocar de usuário', icone: 'usuario',
      onclick: async () => {
        const lista = (await perfis()).filter((x) => x.ativo);
        const p2 = await pedirPerfil(lista.filter((x) => x.id !== ctxApp.perfil.id));
        if (p2) location.reload();
      },
    },
  ]);
  menu.id = 'menu-usuario';
  if (antigo) antigo.replaceWith(menu);
  else document.querySelector('.topo__dir').append(menu);
}

async function atualizarContador(badgeFila) {
  try {
    const hoje = hojeISO();
    const meus = await buscarLeads({ owner_id: ctxApp.perfil.id });
    const devidos = meus.filter((l) =>
      ['a_abordar', 'abordado', 'em_conversa', 'qualificado', 'proposta'].includes(l.status)
      && l.proxima_acao_em && l.proxima_acao_em <= hoje).length;
    badgeFila.hidden = devidos === 0;
    badgeFila.textContent = devidos > 99 ? '99+' : String(devidos);
    badgeFila.title = `${fmtNum(devidos)} para hoje`;
    badgeFila.className = `rail__contador${meus.some((l) => l.proxima_acao_em && l.proxima_acao_em < hoje) ? ' is-atrasado' : ''}`;
  } catch { /* contador é conveniência; nunca deve derrubar a tela */ }
}

/* ═══════════════ PWA ═══════════════ */

function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const novo = reg.installing;
      novo?.addEventListener('statechange', () => {
        if (novo.state === 'installed' && navigator.serviceWorker.controller) {
          toast(h('span', {}, 'Nova versão disponível. ',
            h('button', {
              class: 'btn btn--mini',
              onclick: () => { novo.postMessage('pular-espera'); location.reload(); },
            }, 'Atualizar')), 'info', 0);
        }
      });
    });
  }).catch(() => { /* SW é progressivo: sem ele o app ainda funciona */ });
}

function prepararInstalacao() {
  let evento = null;
  const botao = h('button', { class: 'btn btn--mini btn--instalar', hidden: true }, '⇩ Instalar app');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    evento = e;
    botao.hidden = false;
  });
  botao.onclick = async () => {
    if (!evento) return;
    evento.prompt();
    const { outcome } = await evento.userChoice;
    if (outcome === 'accepted') botao.hidden = true;
    evento = null;
  };

  // iOS não tem beforeinstallprompt e apaga o storage após 7 dias se não instalado.
  const ehiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (ehiOS && !standalone) {
    getConfig('aviso_ios_visto').then((visto) => {
      if (visto) return;
      modal({
        titulo: 'Instale antes de usar no iPhone',
        largura: '460px',
        corpo: h('div', {},
          h('p', { class: 'texto' },
            'No iOS, o Safari apaga os dados de um site após 7 dias sem acesso — a menos que ele '
            + 'esteja instalado na Tela de Início. Como esta versão guarda tudo no seu aparelho, '
            + 'instalar não é opcional.'),
          h('ol', { class: 'passos' },
            h('li', {}, 'Toque em Compartilhar (o quadrado com a seta)'),
            h('li', {}, 'Escolha "Adicionar à Tela de Início"'),
            h('li', {}, 'Abra o WattScout pelo ícone, não pelo Safari'))),
        acoes: [{
          label: 'Entendi',
          classe: 'btn--primario',
          onclick: () => setConfig('aviso_ios_visto', true),
        }],
      });
    });
  }
  return botao;
}

function bannerConectividade() {
  const banner = h('div', { class: 'banner-off', hidden: navigator.onLine },
    'Sem conexão — o app continua funcionando; só o enriquecimento de CNPJ precisa de internet.');
  const sync = () => { banner.hidden = navigator.onLine; };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  return banner;
}

/* ═══════════════ Boot ═══════════════ */

async function boot() {
  if (location.protocol === 'file:') {
    document.body.replaceChildren(h('div', { class: 'erro-fatal' },
      h('h1', {}, 'Abra por um servidor local'),
      h('p', {}, 'Módulos ES e service worker não funcionam em file://.'),
      h('pre', {}, 'pnpm dev\n\n→ http://localhost:8080')));
    return;
  }

  await abrir();
  await semearConcessionarias();

  let perfil = await perfilAtual();
  if (!perfil) perfil = await pedirPerfil((await perfis()).filter((p) => p.ativo));
  ctxApp.perfil = perfil;
  ctxApp.ehGestor = perfil.papel === 'gestor' || perfil.papel === 'admin';

  const { badgeFila } = montarShell();
  await atualizarChip();

  document.body.append(bannerConectividade());
  $('.topo__dir').prepend(prepararInstalacao());

  ctxApp.recarregarApp = async () => {
    const p = await perfilAtual();
    if (p) {
      ctxApp.perfil = p;
      ctxApp.ehGestor = p.papel === 'gestor' || p.papel === 'admin';
      await atualizarChip();
    }
    await renderRota();
    atualizarContador(badgeFila);
  };

  const comCtx = (fn) => async (params) => {
    const el = await fn(params, ctxApp);
    atualizarContador(badgeFila);
    return el;
  };

  registrarRota('fila', comCtx(viewFila));
  registrarRota('conversas', comCtx(viewConversas));
  registrarRota('descobrir', comCtx(viewDescobrir));
  registrarRota('backlog', comCtx(viewBacklog));
  registrarRota('importar', comCtx(viewImportar));
  registrarRota('painel', comCtx(viewPainel));
  registrarRota('exportar', comCtx(viewExportar));
  registrarRota('config', comCtx(viewConfig));

  window.addEventListener('hashchange', renderRota);
  await renderRota();
  await atualizarContador(badgeFila);

  // atalho global: "/" foca a busca da tela
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.matches('input,textarea,select,[contenteditable]')) {
      // busca da tela atual, ou — se a tela não tem — a busca global do topo
      const busca = $('.busca') || $('#busca-global');
      if (busca) { e.preventDefault(); busca.focus(); }
    }
    if (e.key === 'Escape' && drawerEstaAberto()) fecharDrawer();
  });

  registrarSW();

  const usinas = await contar('usina_aneel');
  const leads = await contar('lead');
  if (!usinas && !leads) {
    toast('Base vazia. Comece importando a planilha atual em Importar.', 'info', 7000);
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.replaceChildren(h('div', { class: 'erro-fatal' },
    h('h1', {}, 'Não consegui iniciar'),
    h('p', {}, e.message),
    h('p', { class: 'texto-fraco' },
      'Cause comuns: js/supabase-config.js não existe ou está com URL/chave erradas '
      + '(copie de supabase-config.example.js), o vendor/supabase-js-*.umd.js não carregou, '
      + 'ou a CSP está bloqueando a conexão com o Supabase — confira o console.')));
});
