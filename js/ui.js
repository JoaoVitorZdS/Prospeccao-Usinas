// ui.js — primitivas de interface do WattScout.
// Estilos em css/wattscout.css (tokens do Zendesk Garden em vendor/zendesk-garden/).
// Nada aqui usa innerHTML: DOM sempre via h() ou createElementNS (CSP script-src 'self').

import { h, esc, $, limpar } from './util.js';
import { STATUS_MAP } from './seed.js';

/* ═══════════════ Toast ═══════════════ */

let pilhaToast;

export function toast(mensagem, tipo = 'info', ms = 3600) {
  if (!pilhaToast) {
    pilhaToast = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(pilhaToast);
  }
  const t = h('div', { class: `toast toast--${tipo}` },
    h('span', { class: 'toast__msg' }, mensagem),
    h('button', { class: 'toast__x', 'aria-label': 'Fechar', onclick: () => fechar() }, '×'));
  const fechar = () => {
    t.classList.add('is-saindo');
    setTimeout(() => t.remove(), 200);
  };
  pilhaToast.append(t);
  if (ms) setTimeout(fechar, ms);
  return fechar;
}

/* ═══════════════ Modal ═══════════════ */

export function modal({ titulo, corpo, acoes = [], largura = '520px', aoFechar }) {
  const fundo = h('div', { class: 'modal-fundo' });
  const caixa = h('div', {
    class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo,
    style: `max-width:${largura}`,
  });

  const fechar = (valor) => {
    document.removeEventListener('keydown', onTecla, true);
    fundo.remove();
    aoFechar?.(valor);
  };
  const onTecla = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); fechar(null); }
  };

  caixa.append(...limpar(
    h('div', { class: 'modal__topo' },
      h('h2', {}, titulo),
      h('button', { class: 'btn-icone', 'aria-label': 'Fechar', onclick: () => fechar(null) }, '×')),
    h('div', { class: 'modal__corpo' }, corpo),
    acoes.length
      ? h('div', { class: 'modal__acoes' }, acoes.map((a) =>
        h('button', {
          class: `btn ${a.classe || ''}`,
          onclick: async () => {
            const r = await a.onclick?.(fechar);
            if (r !== false && a.fecha !== false) fechar(a.valor ?? true);
          },
        }, a.label)))
      : null,
  ));

  fundo.append(caixa);
  fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fechar(null); });
  document.addEventListener('keydown', onTecla, true);
  document.body.append(fundo);
  setTimeout(() => caixa.querySelector('input,textarea,select,button')?.focus(), 40);
  return { fechar, caixa };
}

export function confirmar(titulo, mensagem, { ok = 'Confirmar', perigo = false } = {}) {
  return new Promise((res) => {
    modal({
      titulo,
      corpo: h('p', { class: 'texto' }, mensagem),
      largura: '440px',
      acoes: [
        { label: 'Cancelar', classe: 'btn--fantasma', valor: false },
        { label: ok, classe: perigo ? 'btn--perigo' : 'btn--primario', valor: true },
      ],
      aoFechar: (v) => res(v === true),
    });
  });
}

export function perguntar(titulo, campos, { ok = 'Salvar' } = {}) {
  return new Promise((res) => {
    const form = h('form', { class: 'form', onsubmit: (e) => e.preventDefault() });
    const refs = {};
    for (const c of campos) {
      let ctrl;
      if (c.tipo === 'textarea') {
        ctrl = h('textarea', { rows: c.linhas || 3, placeholder: c.dica || '' }, c.valor || '');
      } else if (c.tipo === 'select') {
        ctrl = h('select', {}, (c.opcoes || []).map((o) =>
          h('option', { value: o.v, selected: o.v === c.valor }, o.label)));
      } else {
        ctrl = h('input', { type: c.tipo || 'text', value: c.valor ?? '', placeholder: c.dica || '' });
      }
      refs[c.campo] = ctrl;
      form.append(h('label', { class: 'campo' }, h('span', {}, c.label), ctrl,
        c.ajuda ? h('small', {}, c.ajuda) : null));
    }
    modal({
      titulo,
      corpo: form,
      acoes: [
        { label: 'Cancelar', classe: 'btn--fantasma', valor: null },
        {
          label: ok,
          classe: 'btn--primario',
          onclick: () => {
            const out = {};
            for (const [k, el] of Object.entries(refs)) out[k] = el.value.trim();
            const faltando = campos.filter((c) => c.obrigatorio && !out[c.campo]);
            if (faltando.length) {
              toast(`Preencha: ${faltando.map((f) => f.label).join(', ')}`, 'erro');
              return false;
            }
            res(out);
            return true;
          },
        },
      ],
      aoFechar: (v) => { if (v == null) res(null); },
    });
  });
}

/* ═══════════════ Drawer (cockpit) ═══════════════ */

let drawerAberto = null;

export function drawer({ conteudo, aoFechar, largura = '760px' }) {
  fecharDrawer();
  const fundo = h('div', { class: 'drawer-fundo' });
  const painel = h('div', {
    class: 'drawer', role: 'dialog', 'aria-modal': 'true', style: `max-width:${largura}`,
  }, conteudo);
  fundo.append(painel);
  fundo.addEventListener('mousedown', (e) => { if (e.target === fundo) fecharDrawer(); });
  document.body.append(fundo);
  document.body.classList.add('sem-scroll');
  drawerAberto = { fundo, aoFechar, painel };
  setTimeout(() => painel.classList.add('is-aberto'), 10);
  return painel;
}

export function fecharDrawer() {
  if (!drawerAberto) return;
  const { fundo, aoFechar } = drawerAberto;
  drawerAberto = null;
  fundo.remove();
  document.body.classList.remove('sem-scroll');
  aoFechar?.();
}

export const drawerEstaAberto = () => !!drawerAberto;

/* ═══════════════ Componentes ═══════════════ */

export const badge = (texto, cor = 'cinza') => h('span', { class: `badge badge--${cor}` }, texto);

export function badgeStatus(status) {
  const s = STATUS_MAP[status];
  return badge(s?.label || status || '—', s?.cor || 'cinza');
}

export const kpi = (rotulo, valor, dica) =>
  h('div', { class: 'kpi' },
    h('div', { class: 'kpi__valor' }, valor),
    h('div', { class: 'kpi__rotulo' }, rotulo),
    dica ? h('div', { class: 'kpi__dica' }, dica) : null);

export const card = (titulo, ...corpo) =>
  h('section', { class: 'card' },
    titulo ? h('div', { class: 'card__topo' },
      typeof titulo === 'string' ? h('h2', {}, titulo) : titulo) : null,
    h('div', { class: 'card__corpo' }, corpo));

export const cabecalhoPagina = (titulo, subtitulo, ...acoes) =>
  h('header', { class: 'pagina__topo' },
    h('div', {}, h('h1', {}, titulo), subtitulo ? h('p', {}, subtitulo) : null),
    acoes.length ? h('div', { class: 'pagina__acoes' }, acoes) : null);

export const vazio = (titulo, mensagem, acao) =>
  h('div', { class: 'vazio' },
    h('div', { class: 'vazio__icone' }, '◍'),
    h('h3', {}, titulo),
    mensagem ? h('p', {}, mensagem) : null,
    acao || null);

export function pills(opcoes, valorAtual, aoTrocar, { multi = false } = {}) {
  const cx = h('div', { class: 'pills', role: multi ? 'group' : 'radiogroup' });
  const atual = new Set([].concat(valorAtual ?? []));
  for (const o of opcoes) {
    const b = h('button', {
      type: 'button',
      class: `pill ${atual.has(o.v) ? 'is-ativa' : ''}`,
      'data-v': o.v,
      title: o.dica || '',
      onclick: () => {
        if (multi) {
          if (atual.has(o.v)) atual.delete(o.v); else atual.add(o.v);
          cx.querySelectorAll('.pill').forEach((p) => p.classList.toggle('is-ativa', atual.has(p.dataset.v)));
          aoTrocar([...atual]);
        } else {
          cx.querySelectorAll('.pill').forEach((p) => p.classList.toggle('is-ativa', p.dataset.v === o.v));
          aoTrocar(o.v);
        }
      },
    }, o.atalho ? h('kbd', {}, o.atalho) : null, o.label, o.contagem != null ? h('em', {}, String(o.contagem)) : null);
    cx.append(b);
  }
  return cx;
}

/**
 * Tabela com seleção por checkbox e navegação por teclado (j/k/Enter).
 * `colunas`: [{ chave, titulo, largura, alinha, render(linha) }]
 */
export function tabela({ colunas, linhas, aoAbrir, selecao, chave = (l) => l.id, vaziaMsg }) {
  const wrap = h('div', { class: 'tabela-wrap' });
  if (!linhas.length) {
    wrap.append(h('div', { class: 'tabela-vazia' }, vaziaMsg || 'Nada aqui.'));
    return wrap;
  }
  const tab = h('table', { class: 'tabela' });
  const selecionados = selecao?.set || new Set();

  const thSel = selecao
    ? h('th', { class: 'col-sel' }, h('input', {
      type: 'checkbox',
      'aria-label': 'Selecionar tudo',
      onchange: (e) => {
        selecionados.clear();
        if (e.target.checked) linhas.forEach((l) => selecionados.add(chave(l)));
        tab.querySelectorAll('tbody input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; });
        tab.querySelectorAll('tbody tr').forEach((tr) => tr.classList.toggle('is-sel', e.target.checked));
        selecao.aoMudar?.(selecionados);
      },
    }))
    : null;

  tab.append(h('thead', {}, h('tr', {}, thSel,
    colunas.map((c) => h('th', {
      style: c.largura ? `width:${c.largura}` : null,
      class: c.alinha === 'dir' ? 'ta-dir' : null,
    }, c.titulo)))));

  const corpo = h('tbody', {});
  linhas.forEach((l, i) => {
    const tr = h('tr', {
      tabindex: '0',
      dataset: { i: String(i) },
      onclick: (e) => {
        if (e.target.closest('input,button,a')) return;
        aoAbrir?.(l, i);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') { e.preventDefault(); aoAbrir?.(l, i); }
      },
    });
    if (selecao) {
      tr.append(h('td', { class: 'col-sel' }, h('input', {
        type: 'checkbox',
        checked: selecionados.has(chave(l)),
        'aria-label': 'Selecionar linha',
        onchange: (e) => {
          if (e.target.checked) selecionados.add(chave(l)); else selecionados.delete(chave(l));
          tr.classList.toggle('is-sel', e.target.checked);
          selecao.aoMudar?.(selecionados);
        },
      })));
      if (selecionados.has(chave(l))) tr.classList.add('is-sel');
    }
    for (const c of colunas) {
      const v = c.render ? c.render(l, i) : l[c.chave];
      tr.append(h('td', {
        class: c.alinha === 'dir' ? 'ta-dir' : null,
        title: typeof v === 'string' ? v : null,
      }, v ?? ''));
    }
    corpo.append(tr);
  });
  tab.append(corpo);
  wrap.append(tab);

  // j/k navegam, Enter abre — o atalho que a seção 7.B pede
  wrap.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea,select')) return;
    if (e.key !== 'j' && e.key !== 'k') return;
    e.preventDefault();
    const atual = document.activeElement.closest('tr[data-i]');
    const i = atual ? Number(atual.dataset.i) : -1;
    const prox = e.key === 'j' ? Math.min(i + 1, linhas.length - 1) : Math.max(i - 1, 0);
    corpo.querySelector(`tr[data-i="${prox}"]`)?.focus();
  });

  return wrap;
}

export function barraProgresso(rotulo) {
  const barra = h('div', { class: 'prog__barra' });
  const texto = h('span', { class: 'prog__texto' }, rotulo || '');
  const raiz = h('div', { class: 'prog' }, h('div', { class: 'prog__trilho' }, barra), texto);
  return {
    el: raiz,
    atualizar(feito, total, msg) {
      barra.style.width = `${total ? (feito / total) * 100 : 0}%`;
      texto.textContent = msg ?? `${feito} de ${total}`;
    },
  };
}

/** Botão que copia e confirma visualmente — usado o tempo todo no cockpit. */
export function botaoCopiar(rotulo, obterTexto, { classe = '', atalho } = {}) {
  const b = h('button', { class: `btn ${classe}`, type: 'button' },
    atalho ? h('kbd', {}, atalho) : null, rotulo);
  b.addEventListener('click', async () => {
    const txt = typeof obterTexto === 'function' ? obterTexto() : obterTexto;
    if (!txt) return toast('Nada para copiar.', 'aviso');
    const { copiar } = await import('./util.js');
    const ok = await copiar(txt);
    if (ok) {
      const antes = b.textContent;
      b.classList.add('is-ok');
      b.textContent = '✓ Copiado';
      setTimeout(() => { b.classList.remove('is-ok'); b.textContent = antes; }, 1100);
    } else toast('Não consegui copiar. Selecione e use Ctrl+C.', 'erro');
  });
  return b;
}

/* ═══════════════ Ícones, avatar, menu, abas, chip de filtro ═══════════════ */

// Ícones de traço, desenhados para o WattScout (viewBox 24×24). Montados com
// createElementNS — nunca innerHTML (CSP e regra do projeto).
const ICONES = {
  inicio: [['path', 'M3 11l9-8 9 8M5 9.5V20h5v-6h4v6h5V9.5']],
  leads: [['circle', 9, 8, 3.5], ['path', 'M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6'], ['path', 'M15.8 4.8a3.5 3.5 0 010 6.4M18 14.3c2.1.7 3.5 2.6 3.5 5.7']],
  conversas: [['path', 'M4 5h16v11H9.5L4 20.5V5z']],
  prospeccao: [['circle', 10.5, 10.5, 6.5], ['path', 'M15.5 15.5L21 21']],
  mercado: [['path', 'M5 20v-8M12 20V5M19 20V9']],
  relatorios: [['path', 'M21 12a9 9 0 11-9-9v9h9z']],
  importar: [['path', 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3']],
  exportar: [['path', 'M12 15V3m0 0L8 7m4-4l4 4M4 17v3h16v-3']],
  admin: [['path', 'M4 7h9M17 7h3M4 17h3M11 17h9'], ['circle', 15, 7, 2], ['circle', 9, 17, 2]],
  negocios: [['path', 'M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z']],
  tarefas: [['path', 'M4 4h16v16H4zM8 12l3 3 5-6']],
  listas: [['path', 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01']],
  busca: [['circle', 11, 11, 6.5], ['path', 'M16 16l5 5']],
  mais: [['path', 'M12 5v14M5 12h14']],
  usuario: [['circle', 12, 8, 4], ['path', 'M4 21c0-4 3.6-6 8-6s8 2 8 6']],
  sair: [['path', 'M9 4H5v16h4M16 8l4 4-4 4M20 12H9']],
  seta: [['path', 'M6 9l6 6 6-6']],
  fechar: [['path', 'M6 6l12 12M18 6L6 18']],
  filtro: [['path', 'M3 5h18l-7 8v6l-4-2v-4z']],
  raio: [['path', 'M13 2L4 14h7l-1 8 9-12h-7z']],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icone(nome, { tamanho } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icone${tamanho === 'peq' ? ' icone--peq' : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, ...v] of ICONES[nome] || []) {
    const no = document.createElementNS(SVG_NS, tag);
    if (tag === 'circle') {
      no.setAttribute('cx', v[0]); no.setAttribute('cy', v[1]); no.setAttribute('r', v[2]);
    } else {
      no.setAttribute('d', v[0]);
    }
    svg.append(no);
  }
  return svg;
}

/** Iniciais do nome — "Maria Souza" → "MS". */
export const iniciais = (nome) => {
  const partes = String(nome || '?').trim().split(/\s+/).filter(Boolean);
  return ((partes[0]?.[0] || '?') + (partes.length > 1 ? partes.at(-1)[0] : '')).toUpperCase();
};

export const avatar = (nome, { tamanho } = {}) =>
  h('span', {
    class: `avatar${tamanho ? ` avatar--${tamanho}` : ''}`,
    'aria-hidden': 'true',
  }, iniciais(nome));

/**
 * Menu suspenso ancorado a um botão. `itens`: [{ rotulo, icone, onclick, href, perigo }],
 * `{ sep: true }` para divisória ou `{ cabecalho: Node }` para o bloco do topo.
 * Fecha com clique fora ou Esc. Devolve o wrapper — é ele que entra na página.
 */
export function menuSuspenso(botao, itens, { alinhar = 'dir' } = {}) {
  const ancora = h('div', { class: 'menu-ancora' }, botao);
  let aberto = null;
  const fechar = () => {
    if (!aberto) return;
    aberto.remove();
    aberto = null;
    botao.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', foraClique, true);
    document.removeEventListener('keydown', teclaEsc, true);
  };
  const foraClique = (e) => { if (!ancora.contains(e.target)) fechar(); };
  const teclaEsc = (e) => { if (e.key === 'Escape') { fechar(); botao.focus(); } };
  const abrir = () => {
    aberto = h('div', { class: `menu${alinhar === 'esq' ? ' menu--esq' : ''}`, role: 'menu' },
      itens.filter(Boolean).map((it) => {
        if (it.sep) return h('div', { class: 'menu__sep', role: 'separator' });
        if (it.cabecalho) return h('div', { class: 'menu__cab' }, it.cabecalho);
        const Tag = it.href ? 'a' : 'button';
        return h(Tag, {
          class: `menu__item${it.perigo ? ' menu__item--perigo' : ''}`,
          role: 'menuitem',
          href: it.href || null,
          type: it.href ? null : 'button',
          onclick: () => { fechar(); it.onclick?.(); },
        }, it.icone ? icone(it.icone, { tamanho: 'peq' }) : null, it.rotulo);
      }));
    ancora.append(aberto);
    botao.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', foraClique, true);
    document.addEventListener('keydown', teclaEsc, true);
    aberto.querySelector('.menu__item')?.focus();
  };
  botao.setAttribute('aria-haspopup', 'menu');
  botao.setAttribute('aria-expanded', 'false');
  botao.addEventListener('click', () => (aberto ? fechar() : abrir()));
  return ancora;
}

/** Abas: `opcoes` = [{ v, label }]. */
export function abas(opcoes, valorAtual, aoTrocar) {
  const cx = h('div', { class: 'abas', role: 'tablist' });
  for (const o of opcoes) {
    cx.append(h('button', {
      type: 'button', role: 'tab', class: `aba${o.v === valorAtual ? ' is-ativa' : ''}`,
      'aria-selected': String(o.v === valorAtual), dataset: { v: o.v },
      onclick: () => {
        cx.querySelectorAll('.aba').forEach((a) => {
          const ativa = a.dataset.v === o.v;
          a.classList.toggle('is-ativa', ativa);
          a.setAttribute('aria-selected', String(ativa));
        });
        aoTrocar(o.v);
      },
    }, o.label));
  }
  return cx;
}

/** Migalhas: [{ label, rota?, params? }] — o último item é a página atual. */
export function breadcrumb(itens) {
  return h('nav', { class: 'breadcrumb', 'aria-label': 'Você está em' },
    itens.map((it, i) => [
      i > 0 ? h('span', { class: 'breadcrumb__sep', 'aria-hidden': 'true' }, '›') : null,
      it.rota
        ? h('a', { href: `#/${it.rota}${it.params ? `?${new URLSearchParams(it.params)}` : ''}` }, it.label)
        : h('span', { 'aria-current': 'page' }, it.label),
    ]));
}

/**
 * Chip de filtro com popover (padrão das listas do Zendesk Sell). `rotulo` é o nome do
 * filtro; `resumo` o valor atual em texto (vazio = filtro inativo); `corpo` o conteúdo
 * do popover (um <select>, intervalo de datas…); `aoLimpar` zera o filtro.
 */
export function chipFiltro({ rotulo, resumo = '', corpo, aoLimpar }) {
  const ativo = !!resumo;
  const popover = h('div', { class: 'chip-filtro__popover', hidden: true }, corpo);
  const botao = h('button', {
    type: 'button', class: 'chip-filtro__botao', 'aria-expanded': 'false',
    onclick: () => {
      const abrir = popover.hidden;
      popover.hidden = !abrir;
      botao.setAttribute('aria-expanded', String(abrir));
      if (abrir) popover.querySelector('input,select,textarea')?.focus();
    },
  }, ativo ? `${rotulo}: ${resumo}` : rotulo,
  ativo ? null : icone('seta', { tamanho: 'peq' }));
  const raiz = h('div', { class: `chip-filtro${ativo ? ' is-ativo' : ''}` }, botao,
    ativo && aoLimpar
      ? h('button', { type: 'button', class: 'chip-filtro__x', 'aria-label': `Limpar filtro ${rotulo}`, onclick: aoLimpar }, '×')
      : null,
    popover);
  chipsAbertos.add({ raiz, popover, botao });
  return raiz;
}

// Um único listener global fecha os popovers de chip quando o clique cai fora deles
// (em vez de um listener novo a cada render da tela). Chips que saíram do DOM são descartados.
const chipsAbertos = new Set();
document.addEventListener('mousedown', (e) => {
  for (const c of chipsAbertos) {
    if (!c.raiz.isConnected) { chipsAbertos.delete(c); continue; }
    if (!c.popover.hidden && !c.raiz.contains(e.target)) {
      c.popover.hidden = true;
      c.botao.setAttribute('aria-expanded', 'false');
    }
  }
});

/* ═══════════════ Roteador ═══════════════ */

const rotas = new Map();
let rotaAtual = null;

export const registrarRota = (nome, render) => rotas.set(nome, render);

const montarHash = (nome, params) => {
  const limpo = Object.entries(params || {}).filter(([, v]) => v !== '' && v != null && v !== false);
  return `#/${nome}${limpo.length ? `?${new URLSearchParams(limpo)}` : ''}`;
};

export function navegar(nome, params) {
  const hash = montarHash(nome, params);
  if (location.hash === hash) return renderRota();
  location.hash = hash;
}

/** Espelha o estado dos filtros na URL SEM re-renderizar a tela (replaceState não
 *  dispara `hashchange`) — assim o link da página já reabre filtrado. */
export function sincronizarHash(nome, params) {
  const hash = montarHash(nome, params);
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

export async function renderRota() {
  const bruto = location.hash.replace(/^#\/?/, '') || 'fila';
  const [nome, qs] = bruto.split('?');
  const render = rotas.get(nome) || rotas.get('fila');
  const alvo = $('#conteudo');
  rotaAtual = nome;
  document.querySelectorAll('.rail__item').forEach((a) =>
    a.classList.toggle('is-ativa', a.dataset.rota === nome));
  alvo.setAttribute('aria-busy', 'true');
  alvo.replaceChildren(h('div', { class: 'carregando' }, 'Carregando…'));
  try {
    const el = await render(Object.fromEntries(new URLSearchParams(qs || '')));
    if (rotaAtual !== nome) return; // navegou de novo enquanto carregava
    alvo.replaceChildren(el);
  } catch (e) {
    console.error(e);
    alvo.replaceChildren(vazio('Erro ao carregar', e.message));
  } finally {
    alvo.removeAttribute('aria-busy');
  }
}

export const rotaAtiva = () => rotaAtual;
export { esc };
