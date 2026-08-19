// ui.js — primitivas de interface.
// Os nomes de componente espelham o `helpdesk-fe` (Card/KPI/Badge/PageHeader/Tab)
// para que o port futuro seja mecânico, como pede a seção 7.

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

/* ═══════════════ Roteador ═══════════════ */

const rotas = new Map();
let rotaAtual = null;

export const registrarRota = (nome, render) => rotas.set(nome, render);

export function navegar(nome, params) {
  const hash = `#/${nome}${params ? `?${new URLSearchParams(params)}` : ''}`;
  if (location.hash === hash) return renderRota();
  location.hash = hash;
}

export async function renderRota() {
  const bruto = location.hash.replace(/^#\/?/, '') || 'fila';
  const [nome, qs] = bruto.split('?');
  const render = rotas.get(nome) || rotas.get('fila');
  const alvo = $('#conteudo');
  rotaAtual = nome;
  document.querySelectorAll('.nav__item').forEach((a) =>
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
