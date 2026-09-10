// views/backlog.js — o mapa de onde faltam usinas.
//
// "Backlog" = consumo (kWh/mês) que a Alexandria já tem contratado ou em
// pipeline numa área de concessão e que ainda NÃO casou com uma usina geradora
// na MESMA distribuidora. A compensação de GD amarra usina e unidade
// consumidora à mesma distribuidora, então cobrir o backlog é sempre um
// problema por distribuidora — não dá pra atender Enel SP com usina em Minas.
//
// Quanto maior a barra, mais vale prospectar geração ali: o botão "Ver usinas"
// abre Descobrir já filtrado naquela distribuidora. Fonte da verdade: tabela
// `backlog` no Supabase, editável aqui pelo gestor; a primeira carga vem de
// BACKLOG_INICIAL (js/seed.js) via semearBacklog().

import { h, fmtNum, fmtData, limpar } from '../util.js';
import {
  todos, contar, backlogTodos, semearBacklog, salvarBacklog,
} from '../db.js';
import { cabecalhoPagina, card, kpi, vazio, toast, perguntar, navegar } from '../ui.js';

/** kWh/mês vindo do formulário: aceita "1.734.765", "1680000" ou "1.680.000,00".
 *  Backlog é uma contagem grande de kWh/mês — casas decimais não importam. */
function lerKwh(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  const n = Number(s.replace(/[.,]\d{1,2}$/, '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export async function viewBacklog(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;
  const raiz = h('div', { class: 'pagina' });

  // primeira visita: popula a partir da semente (silencioso — se falhar, cai no
  // estado vazio com o botão manual)
  if (!(await contar('backlog'))) {
    try { await semearBacklog(); } catch { /* segue vazio */ }
  }

  const [linhas, concessionarias] = await Promise.all([backlogTodos(), todos('concessionaria')]);
  const nomeConc = new Map(concessionarias.map((c) => [c.codigo, c.nome]));

  /* ── editar / adicionar ── */
  async function editar(reg, { novo = false } = {}) {
    const jaTem = new Set(linhas.map((b) => b.concessionaria_codigo));
    const disponiveis = concessionarias
      .filter((c) => c.codigo !== 'OUTRA' && !jaTem.has(c.codigo))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    if (novo && !disponiveis.length) {
      toast('Todas as distribuidoras do cadastro já estão no backlog.', 'info');
      return;
    }

    const campos = [];
    if (novo) {
      campos.push({
        campo: 'codigo', label: 'Distribuidora', tipo: 'select',
        valor: disponiveis[0].codigo,
        opcoes: disponiveis.map((c) => ({ v: c.codigo, label: `${c.nome}${c.uf ? ` (${c.uf})` : ''}` })),
      });
    }
    campos.push({
      campo: 'valor', label: 'Backlog (kWh/mês)',
      valor: String(reg.backlog_kwh_mes ?? 0),
      ajuda: 'Consumo contratado/em pipeline nessa área ainda sem usina casada. '
        + 'Aceita colar do relatório (1.680.000). Zere para tirar da lista ativa.',
    });
    campos.push({
      campo: 'nota', label: 'Nota (opcional)', tipo: 'textarea',
      valor: reg.nota || '',
    });

    const titulo = novo ? 'Adicionar distribuidora' : `Backlog — ${nomeConc.get(reg.concessionaria_codigo) || reg.concessionaria_codigo}`;
    const r = await perguntar(titulo, campos);
    if (!r) return;
    const codigo = novo ? r.codigo : reg.concessionaria_codigo;
    try {
      await salvarBacklog(codigo, lerKwh(r.valor), { perfilId: perfil.id, nota: r.nota });
      toast('Backlog atualizado.', 'ok');
      navegar('backlog');
    } catch (e) {
      toast(e.message, 'erro', 6000);
    }
  }

  /* ── estado vazio ── */
  if (!linhas.length) {
    raiz.append(
      cabecalhoPagina('Backlog', 'Consumo por distribuidora ainda sem usina casada'),
      vazio(
        'Sem backlog cadastrado',
        ehGestor
          ? 'Semeie com os valores do levantamento atual ou adicione distribuidora a distribuidora.'
          : 'Peça a um gestor para cadastrar o backlog do levantamento atual.',
        ehGestor
          ? h('div', { class: 'linha-botoes' },
            h('button', {
              class: 'btn btn--primario',
              onclick: async () => {
                try {
                  const n = await semearBacklog(true);
                  toast(n ? `${n} distribuidoras semeadas.` : 'Nada a semear.', n ? 'ok' : 'info');
                  navegar('backlog');
                } catch (e) { toast(e.message, 'erro', 6000); }
              },
            }, 'Semear com valores atuais'),
            h('button', { class: 'btn', onclick: () => editar({}, { novo: true }) }, '+ Distribuidora'))
          : null,
      ),
    );
    return raiz;
  }

  /* ── dados prontos ── */
  const ordenado = linhas
    .map((b) => ({
      ...b,
      nome: nomeConc.get(b.concessionaria_codigo) || b.concessionaria_codigo,
      valor: Number(b.backlog_kwh_mes) || 0,
    }))
    .sort((a, b) => b.valor - a.valor);

  const comLacuna = ordenado.filter((b) => b.valor > 0);
  const total = comLacuna.reduce((s, b) => s + b.valor, 0);
  const maxV = Math.max(1, ...ordenado.map((b) => b.valor));
  const ultima = ordenado.map((b) => b.atualizado_em).filter(Boolean).sort().at(-1);
  const maior = comLacuna[0];

  const linhaEl = (b) => h('div', { class: `bl-linha${b.valor > 0 ? '' : ' bl-linha--zero'}` },
    h('span', { class: 'bl-linha__nome', title: `${b.nome} · ${b.concessionaria_codigo}` }, b.nome),
    h('div', { class: 'bl-linha__trilho' },
      h('div', { class: 'bl-linha__fill', style: `width:${Math.max(b.valor > 0 ? 2 : 0, (b.valor / maxV) * 100)}%` })),
    h('span', { class: 'bl-linha__val' }, `${fmtNum(b.valor)} kWh/mês`),
    h('div', { class: 'bl-linha__acoes' },
      h('button', {
        class: 'btn btn--mini',
        onclick: () => navegar('descobrir', { conc: b.concessionaria_codigo }),
      }, 'Ver usinas'),
      ehGestor
        ? h('button', {
          class: 'btn btn--mini btn--fantasma', title: 'Editar backlog',
          onclick: () => editar(b),
        }, '✎')
        : null));

  raiz.append(...limpar(
    cabecalhoPagina(
      'Backlog',
      'Consumo por distribuidora ainda sem usina casada — priorize a prospecção pela maior lacuna',
      ...(ehGestor
        ? [h('button', { class: 'btn btn--fantasma', onclick: () => editar({}, { novo: true }) }, '+ Distribuidora')]
        : []),
    ),
    h('div', { class: 'kpis' },
      kpi('Distribuidoras aguardando', fmtNum(comLacuna.length),
        ordenado.length > comLacuna.length ? `${fmtNum(ordenado.length - comLacuna.length)} já cobertas` : null),
      kpi('Backlog somado', `${fmtNum(total)} kWh/mês`),
      kpi('Maior lacuna', maior ? maior.nome : '—', maior ? `${fmtNum(maior.valor)} kWh/mês` : null)),
    ultima ? h('p', { class: 'nota-taxa' }, `Última atualização: ${fmtData(ultima.slice(0, 10))}.`) : null,
    card(null, h('div', { class: 'bl-lista' }, ordenado.map(linhaEl))),
    h('p', { class: 'texto-fraco' },
      'A compensação de GD exige usina e unidade consumidora na mesma distribuidora, '
      + 'então o backlog é sempre por área de concessão. "Ver usinas" abre Descobrir '
      + 'filtrado naquela distribuidora, ordenado por potência.'),
  ));

  return raiz;
}
