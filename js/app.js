// app.js — bootstrap, casca (barra lateral + barra superior) e roteamento.
//
// Ordem do boot: abre o cliente Supabase → confere a sessão (Supabase Auth) → liga a conta ao
// perfil → se o perfil estiver pendente, segura na tela "Aguardando aprovação" → só então monta
// o app. Sem sessão, quem aparece é a tela de login (views/login.js). O isolamento dos dados é
// do RLS no banco; o que esta camada esconde (menus, rotas de gestor) é só conveniência.

import { h, $, fmtNum, hojeISO } from './util.js';
import { abrir, semearConcessionarias, perfilAtual, getConfig, setConfig, contar, buscarLeads } from './db.js';
import { sessaoAtual, sair, aoSair, erroNaUrl, emRecuperacao, limparUrlAuth } from './auth.js';
import { registrarRota, aliasRota, renderRota, navegar, toast, modal, drawerEstaAberto, fecharDrawer,
  icone, avatar, menuSuspenso, vazio } from './ui.js';
import { criarLeadManual } from './leads-acoes.js';
import { perfis as listarPerfis } from './db.js';
import { telaLogin, telaPendente, telaNovaSenha } from './views/login.js';
import { viewInicio } from './views/inicio.js';
import { viewNegocios } from './views/negocios.js';
import { viewTarefas } from './views/tarefas.js';
import { viewLeads } from './views/leads.js';
import { viewLead } from './views/lead.js';
import { viewListas } from './views/listas.js';
import { viewConversas } from './views/conversas.js';
import { viewDescobrir } from './views/descobrir.js';
import { viewBacklog } from './views/backlog.js';
import { viewImportar } from './views/importar.js';
import { viewPainel } from './views/painel.js';
import { viewExportar } from './views/exportar.js';
import { viewConfig } from './views/config.js';
import { viewPerfil } from './views/perfil.js';
import { viewContas } from './views/contas.js';

// Barra lateral (rail). Os ids de rota que ainda são os antigos (conversas, descobrir, backlog…)
// só tiveram o rótulo trocado; a renomeação de cada rota acontece junto com a tela refeita
// (#/fila já virou #/leads e continua funcionando por alias).
const NAV_TOPO = [
  { rota: 'inicio', label: 'Início', icone: 'inicio' },
  { rota: 'leads', label: 'Leads', icone: 'leads' },
  { rota: 'negocios', label: 'Negócios', icone: 'negocios' },
  { rota: 'tarefas', label: 'Tarefas', icone: 'tarefas' },
  { rota: 'conversas', label: 'Comunicações', icone: 'conversas' },
  { rota: 'listas', label: 'Listas', icone: 'listas' },
  { rota: 'descobrir', label: 'Prospecção', icone: 'prospeccao' },
  { rota: 'backlog', label: 'Mercado', icone: 'mercado' },
  { rota: 'painel', label: 'Relatórios', icone: 'relatorios' },
  { rota: 'importar', label: 'Importar', icone: 'importar' },
  { rota: 'exportar', label: 'Exportar', icone: 'exportar' },
];
const NAV_BASE = [
  { rota: 'contas', label: 'Contas', icone: 'usuario', soGestor: true },
  { rota: 'config', label: 'Admin Center', icone: 'admin' },
];

const ctxApp = { perfil: null, ehGestor: false, recarregarApp: null };

const ehGestorPapel = (papel) => papel === 'gestor' || papel === 'admin';

/* ═══════════════ Casca ═══════════════ */

function itemRail(n, extra) {
  return h('a', {
    class: 'rail__item', href: `#/${n.rota}`, dataset: { rota: n.rota, rotulo: n.label },
    'aria-label': n.label,
  }, icone(n.icone), extra || null);
}

function montarShell() {
  const badgeFila = h('span', { class: 'rail__contador', id: 'contador-fila', hidden: true });

  const rail = h('nav', { class: 'rail', 'aria-label': 'Navegação principal' },
    h('a', { class: 'rail__marca', href: '#/inicio', 'aria-label': 'WattScout — início', title: 'WattScout' },
      h('img', { src: 'icons/icon-192.png', alt: '', width: '32', height: '32' })),
    h('div', { class: 'rail__itens' },
      NAV_TOPO.map((n) => itemRail(n, n.rota === 'tarefas' ? badgeFila : null))),
    h('div', { class: 'rail__base' },
      NAV_BASE.filter((n) => !n.soGestor || ctxApp.ehGestor).map((n) => itemRail(n))));

  // busca global: manda o texto para a lista de leads (que já busca nome, CNPJ, telefone, cidade…)
  const campoBusca = h('input', {
    type: 'search', id: 'busca-global', placeholder: 'Buscar leads, CNPJ, telefone…  ( / )',
    'aria-label': 'Buscar nos seus leads', autocomplete: 'off',
  });
  const busca = h('form', {
    class: 'topo__busca', role: 'search',
    onsubmit: (e) => {
      e.preventDefault();
      const q = campoBusca.value.trim();
      if (q) navegar('leads', { f: 'meus', q });
    },
  }, icone('busca', { tamanho: 'peq' }), campoBusca);

  const botaoNovo = h('button', { class: 'btn btn--primario btn--mini', type: 'button' },
    icone('mais', { tamanho: 'peq' }), 'Novo');
  const menuNovo = menuSuspenso(botaoNovo, [
    {
      rotulo: 'Novo lead', icone: 'leads',
      onclick: async () => {
        try {
          const novo = await criarLeadManual({ perfil: ctxApp.perfil, ehGestor: ctxApp.ehGestor, perfis: await listarPerfis() });
          if (novo) navegar(`lead/${novo.id}`);
        } catch (e) { toast(e.message, 'erro', 7000); }
      },
    },
    { rotulo: 'Importar planilha', icone: 'importar', onclick: () => navegar('importar') },
    { rotulo: 'Importar Base CNPJ', icone: 'importar', onclick: () => navegar('importar', { modo: 'cnpj' }) },
    { rotulo: 'Prospectar usinas', icone: 'prospeccao', onclick: () => navegar('descobrir') },
  ]);

  const topo = h('header', { class: 'topo' },
    busca,
    h('div', { class: 'topo__dir' }, menuNovo));

  document.body.prepend(rail, topo);
  return { badgeFila };
}

const ROTULO_PAPEL = { agente: 'Agente', gestor: 'Gestor', admin: 'Administrador' };

/** Redesenha o avatar do topo e o menu do usuário (o menu precisa do perfil atual). */
async function atualizarChip() {
  const p = ctxApp.perfil;
  // botão novo a cada chamada: menuSuspenso() registra o clique no botão que recebe
  const chip = h('button', { class: 'perfil-chip', id: 'perfil-chip', type: 'button' });
  chip.replaceChildren(
    avatar(p.nome),
    h('span', { class: 'perfil-chip__nome' }, p.nome),
    h('span', { class: 'perfil-chip__papel' }, ROTULO_PAPEL[p.papel] || p.papel));
  chip.setAttribute('aria-label', `Menu de ${p.nome}`);

  const antigo = document.getElementById('menu-usuario');
  const menu = menuSuspenso(chip, [
    {
      cabecalho: h('div', { style: 'display:flex;gap:10px;align-items:center' },
        avatar(p.nome, { tamanho: 'grande' }),
        h('div', {}, h('strong', {}, p.nome), p.email ? h('small', {}, p.email) : null,
          h('small', {}, ROTULO_PAPEL[p.papel] || p.papel))),
    },
    { rotulo: 'Meu perfil', icone: 'usuario', onclick: () => navegar('perfil') },
    ctxApp.ehGestor ? { rotulo: 'Gestão de contas', icone: 'leads', onclick: () => navegar('contas') } : null,
    { rotulo: 'Admin Center', icone: 'admin', onclick: () => navegar('config') },
    { sep: true },
    { rotulo: 'Sair', icone: 'sair', perigo: true, onclick: async () => { await sair(); location.reload(); } },
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

  // iOS não tem beforeinstallprompt e apaga o storage do site (login incluído) após 7 dias sem uso.
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
            'No iOS, o Safari apaga os dados de um site (inclusive o seu login) após 7 dias sem acesso — '
            + 'a menos que ele esteja instalado na Tela de Início.'),
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
    'Sem conexão — o WattScout precisa de internet para ler e gravar os dados.');
  const sync = () => { banner.hidden = navigator.onLine; };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  return banner;
}

/* ═══════════════ Boot ═══════════════ */

/** O banco ainda não recebeu a migration 0006 (a RPC não existe) — explica em vez de quebrar. */
const faltaMigration = (e) => /reivindicar_perfil|PGRST202|Could not find the function/i.test(`${e?.message} ${e?.codigo}`);

async function boot() {
  if (location.protocol === 'file:') {
    document.body.replaceChildren(h('div', { class: 'erro-fatal' },
      h('h1', {}, 'Abra por um servidor local'),
      h('p', {}, 'Módulos ES e service worker não funcionam em file://.'),
      h('pre', {}, 'pnpm dev\n\n→ http://localhost:8080')));
    return;
  }

  await abrir();

  // ── sessão ──
  const erroLink = erroNaUrl();
  const recuperando = emRecuperacao();
  let sessao = null;
  try { sessao = await sessaoAtual(); } catch { /* sem sessão utilizável: cai no login */ }
  limparUrlAuth();

  if (!sessao) {
    telaLogin({
      erro: erroLink,
      aviso: !erroLink && recuperando ? 'O link de recuperação não pôde ser usado aqui. Peça um novo ou entre com a sua senha.' : null,
    });
    return;
  }
  if (recuperando) { telaNovaSenha(); return; }

  // ── perfil (liga a conta ao perfil existente pelo e-mail, ou cria um pendente) ──
  let perfil;
  try {
    perfil = await perfilAtual();
  } catch (e) {
    if (faltaMigration(e)) {
      throw new Error('O banco ainda não tem a migration 0006_auth_rls.sql. Rode-a no SQL Editor do Supabase (veja SETUP.md) e recarregue.');
    }
    await sair();
    telaLogin({ erro: e.message });
    return;
  }
  if (!perfil.ativo) { telaPendente(perfil); return; }

  ctxApp.perfil = perfil;
  ctxApp.ehGestor = ehGestorPapel(perfil.papel);
  aoSair(() => location.reload()); // sessão encerrada em outra aba ou expirada

  // só gestor escreve em `concessionaria` (RLS); o agente apenas lê o que o gestor já semeou
  if (ctxApp.ehGestor) {
    try { await semearConcessionarias(); } catch (e) { console.warn('semear concessionárias:', e.message); }
  }

  const { badgeFila } = montarShell();
  await atualizarChip();

  document.body.append(bannerConectividade());
  $('.topo__dir').prepend(prepararInstalacao());

  ctxApp.recarregarApp = async () => {
    const p = await perfilAtual();
    if (p?.ativo) {
      ctxApp.perfil = p;
      ctxApp.ehGestor = ehGestorPapel(p.papel);
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
  // rota de gestor: o banco é quem garante; aqui só evita mostrar uma tela que não funcionaria
  const soGestor = (fn) => comCtx((params, ctx) => (ctx.ehGestor
    ? fn(params, ctx)
    : vazio('Acesso restrito', 'Esta área é só para gestores.')));

  registrarRota('inicio', comCtx(viewInicio));
  registrarRota('leads', comCtx(viewLeads));
  registrarRota('negocios', comCtx(viewNegocios));
  registrarRota('tarefas', comCtx(viewTarefas));
  registrarRota('lead', comCtx(viewLead));
  registrarRota('listas', comCtx(viewListas));
  aliasRota('fila', 'leads');
  registrarRota('conversas', comCtx(viewConversas));
  registrarRota('descobrir', comCtx(viewDescobrir));
  registrarRota('backlog', comCtx(viewBacklog));
  registrarRota('importar', comCtx(viewImportar));
  registrarRota('painel', comCtx(viewPainel));
  registrarRota('exportar', comCtx(viewExportar));
  registrarRota('config', comCtx(viewConfig));
  registrarRota('perfil', comCtx(viewPerfil));
  registrarRota('contas', soGestor(viewContas));

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
    toast(ctxApp.ehGestor
      ? 'Base vazia. Comece importando a planilha atual em Importar.'
      : 'Você ainda não tem leads. Um gestor pode distribuir leads para você.', 'info', 7000);
  }
}

boot().catch((e) => {
  console.error(e);
  document.body.classList.add('sem-casca');
  document.body.replaceChildren(h('div', { class: 'erro-fatal' },
    h('h1', {}, 'Não consegui iniciar'),
    h('p', {}, e.message),
    h('p', { class: 'texto-fraco' },
      'Causas comuns: js/supabase-config.js não existe ou está com URL/chave erradas '
      + '(copie de supabase-config.example.js), o vendor/supabase-js-*.umd.js não carregou, '
      + 'ou a CSP está bloqueando a conexão com o Supabase — confira o console.')));
});
