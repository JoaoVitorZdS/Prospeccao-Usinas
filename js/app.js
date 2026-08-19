// app.js — bootstrap, shell e roteamento.

import { h, $, fmtNum, hojeISO } from './util.js';
import { abrir, semearConcessionarias, perfis, criarPerfil, perfilAtual,
  definirPerfilAtual, getConfig, setConfig, contar, buscarLeads } from './db.js';
import { registrarRota, renderRota, navegar, toast, modal, drawerEstaAberto, fecharDrawer } from './ui.js';
import { viewFila } from './views/fila.js';
import { viewConversas } from './views/conversas.js';
import { viewDescobrir } from './views/descobrir.js';
import { viewImportar } from './views/importar.js';
import { viewPainel } from './views/painel.js';
import { viewExportar } from './views/exportar.js';
import { viewConfig } from './views/config.js';

const NAV = [
  { rota: 'fila', label: 'Minha fila', icone: '◧' },
  { rota: 'conversas', label: 'Conversas', icone: '💬' },
  { rota: 'descobrir', label: 'Descobrir', icone: '◎' },
  { rota: 'importar', label: 'Importar', icone: '⇩' },
  { rota: 'painel', label: 'Painel', icone: '▤' },
  { rota: 'exportar', label: 'Exportar', icone: '⇧' },
  { rota: 'config', label: 'Config', icone: '⚙' },
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
      titulo: existentes.length ? 'Quem está usando?' : 'Bem-vindo ao Lex Prospecta',
      largura: '560px',
      corpo: h('div', {},
        !existentes.length
          ? h('p', { class: 'texto' },
            'Esta é a versão autocontida: roda inteira no seu navegador, sem servidor e sem login. '
            + 'Diga quem você é para que os leads e os toques fiquem com autoria.')
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

function montarShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Seções' },
    NAV.map((n) => h('a', {
      class: 'nav__item', href: `#/${n.rota}`, dataset: { rota: n.rota },
    }, h('span', { class: 'nav__ico' }, n.icone), n.label)));

  const chip = h('button', { class: 'perfil-chip', id: 'perfil-chip' });
  const badgeFila = h('span', { class: 'nav__contador', id: 'contador-fila', hidden: true });

  const cab = h('header', { class: 'topo' },
    h('a', { class: 'marca', href: '#/fila' },
      h('img', { src: 'icons/icon-192.png', alt: '', width: '28', height: '28' }),
      h('span', {}, 'Lex ', h('strong', {}, 'Prospecta'))),
    nav,
    h('div', { class: 'topo__dir' }, badgeFila, chip));

  document.body.prepend(cab);
  return { chip, badgeFila };
}

async function atualizarChip(chip) {
  const p = ctxApp.perfil;
  chip.replaceChildren(
    h('span', { class: 'perfil-chip__ini' }, (p.nome || '?').slice(0, 1).toUpperCase()),
    h('span', { class: 'perfil-chip__nome' }, p.nome),
    h('span', { class: 'perfil-chip__papel' }, p.papel));
  chip.onclick = async () => {
    const lista = (await perfis()).filter((x) => x.ativo);
    const p2 = await pedirPerfil(lista.filter((x) => x.id !== ctxApp.perfil.id));
    if (p2) location.reload();
  };
}

async function atualizarContador(badgeFila) {
  try {
    const hoje = hojeISO();
    const meus = await buscarLeads({ owner_id: ctxApp.perfil.id });
    const devidos = meus.filter((l) =>
      ['a_abordar', 'abordado', 'em_conversa', 'qualificado', 'proposta'].includes(l.status)
      && l.proxima_acao_em && l.proxima_acao_em <= hoje).length;
    badgeFila.hidden = devidos === 0;
    badgeFila.textContent = `${fmtNum(devidos)} para hoje`;
    badgeFila.className = `nav__contador${meus.some((l) => l.proxima_acao_em && l.proxima_acao_em < hoje) ? ' is-atrasado' : ''}`;
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
            h('li', {}, 'Abra o Lex Prospecta pelo ícone, não pelo Safari'))),
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
      h('p', {}, 'Módulos ES, IndexedDB e service worker não funcionam em file://.'),
      h('pre', {}, 'cd lex-prospecta\npython3 -m http.server 8080\n\n→ http://localhost:8080')));
    return;
  }

  await abrir();
  await semearConcessionarias();

  let perfil = await perfilAtual();
  if (!perfil) perfil = await pedirPerfil((await perfis()).filter((p) => p.ativo));
  ctxApp.perfil = perfil;
  ctxApp.ehGestor = perfil.papel === 'gestor' || perfil.papel === 'admin';

  const { chip, badgeFila } = montarShell();
  await atualizarChip(chip);

  document.body.append(bannerConectividade());
  $('.topo__dir').prepend(prepararInstalacao());

  ctxApp.recarregarApp = async () => {
    const p = await perfilAtual();
    if (p) {
      ctxApp.perfil = p;
      ctxApp.ehGestor = p.papel === 'gestor' || p.papel === 'admin';
      await atualizarChip(chip);
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
      const busca = $('.busca');
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
      'Se o navegador estiver em janela anônima, o IndexedDB pode estar bloqueado.')));
});
