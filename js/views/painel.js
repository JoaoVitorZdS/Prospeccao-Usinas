// views/painel.js — visão gerencial (seção 7.E).
// O número que interessa ao negócio de energia não é "quantos leads": é
// POTÊNCIA TOTAL EM PIPELINE. Ele fica em destaque.

import { h, fmtNum, fmtPotencia, hojeISO, addDias, fmtData, limpar, dataLocal } from '../util.js';
import { STATUS, STATUS_MAP, STATUS_FILA, statusLabel, origemLabel } from '../seed.js';
import { todos, buscarLeads, empresasPorCnpj } from '../db.js';
import { cabecalhoPagina, card, kpi, vazio, badge } from '../ui.js';
import { taxaPreenchimento } from '../enriquecer.js';

/** Barras horizontais em CSS puro — sem biblioteca de gráfico. */
function barras(itens, { formatar = fmtNum, cor = 'azul' } = {}) {
  const max = Math.max(1, ...itens.map((i) => i.valor));
  if (!itens.length) return h('p', { class: 'texto-fraco' }, 'Sem dados.');
  return h('div', { class: 'barras' }, itens.map((i) =>
    h('div', { class: 'barra' },
      h('span', { class: 'barra__rot', title: i.rotulo }, i.rotulo),
      h('div', { class: 'barra__trilho' },
        h('div', {
          class: `barra__fill barra__fill--${i.cor || cor}`,
          style: `width:${(i.valor / max) * 100}%`,
        })),
      h('span', { class: 'barra__val' }, formatar(i.valor)))));
}

export async function viewPainel(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;

  const [leads, interacoes, perfis, concessionarias] = await Promise.all([
    buscarLeads({ owner_id: ehGestor ? null : perfil.id }),
    todos('interacao'),
    todos('profiles'),
    todos('concessionaria'),
  ]);
  // só as empresas dos leads carregados, não a tabela inteira (ver comentário em empresasPorCnpj)
  const empresas = await empresasPorCnpj(leads.map((l) => l.cnpj));

  const raiz = h('div', { class: 'pagina' });

  if (!leads.length) {
    raiz.append(
      cabecalhoPagina('Painel', ehGestor ? 'Todos os agentes' : perfil.nome),
      vazio('Sem leads ainda', 'Importe a planilha atual ou puxe leads em Descobrir.'));
    return raiz;
  }

  const mapaAgente = new Map(perfis.map((p) => [p.id, p.nome]));
  const mapaConc = new Map(concessionarias.map((c) => [c.codigo, c.nome]));
  const mapaEmpresa = new Map(empresas.map((e) => [e.cnpj, e]));
  const hoje = hojeISO();
  const seteDias = addDias(hoje, -7);
  const trintaDias = addDias(hoje, -30);

  const potenciaDe = (l) => l.potencia_kwp ?? mapaEmpresa.get(l.cnpj)?.potencia_total_kw ?? 0;

  /* ── Números de topo ── */
  const emPipeline = leads.filter((l) => STATUS_FILA.includes(l.status));
  const potPipeline = emPipeline.reduce((s, l) => s + potenciaDe(l), 0);
  const ganhos = leads.filter((l) => l.status === 'ganho');
  const potGanha = ganhos.reduce((s, l) => s + potenciaDe(l), 0);
  const atrasados = leads.filter((l) => STATUS_FILA.includes(l.status)
    && l.proxima_acao_em && l.proxima_acao_em < hoje);
  const tocadosSemana = new Set(interacoes
    .filter((i) => dataLocal(i.ocorrido_em) >= seteDias)
    .map((i) => i.lead_id));
  const interSemana = interacoes.filter((i) => dataLocal(i.ocorrido_em) >= seteDias);

  // taxa de conversão: dos leads que saíram de "a_abordar", quantos viraram ganho
  const saiuDaFila = leads.filter((l) => l.status !== 'a_abordar').length;
  const taxaGanho = saiuDaFila ? ganhos.length / saiuDaFila : 0;
  const taxaGeral = leads.length ? ganhos.length / leads.length : 0;

  const kpis = h('div', { class: 'kpis' },
    kpi('Potência em pipeline', fmtPotencia(potPipeline),
      `${fmtNum(emPipeline.length)} leads em aberto`),
    kpi('Potência ganha', fmtPotencia(potGanha), `${fmtNum(ganhos.length)} leads`),
    kpi('Leads no total', fmtNum(leads.length)),
    kpi('Atrasados', fmtNum(atrasados.length),
      atrasados.length ? 'próxima ação já venceu' : 'nenhum atraso'),
    kpi('Contatos na semana', fmtNum(interSemana.length),
      `${tocadosSemana.size} lead(s) distintos`),
    kpi('Taxa de ganho', `${(taxaGanho * 100).toFixed(1)}%`,
      `${(taxaGeral * 100).toFixed(1)}% sobre a base toda`));

  /* ── Funil ── */
  const porStatus = STATUS.map((s) => ({
    rotulo: s.label,
    valor: leads.filter((l) => l.status === s.v).length,
    cor: s.cor,
  })).filter((x) => x.valor > 0);

  const potPorStatus = STATUS.map((s) => ({
    rotulo: s.label,
    valor: Math.round(leads.filter((l) => l.status === s.v).reduce((a, l) => a + potenciaDe(l), 0)),
    cor: s.cor,
  })).filter((x) => x.valor > 0);

  /* ── Por agente ── */
  const agentes = [...new Set(leads.map((l) => l.owner_id))].map((id) => {
    const meus = leads.filter((l) => l.owner_id === id);
    const meusGanhos = meus.filter((l) => l.status === 'ganho').length;
    const meusToques = interacoes.filter((i) => i.agente_id === id
      && dataLocal(i.ocorrido_em) >= trintaDias).length;
    return {
      id,
      nome: mapaAgente.get(id) || '—',
      total: meus.length,
      abertos: meus.filter((l) => STATUS_FILA.includes(l.status)).length,
      atrasados: meus.filter((l) => STATUS_FILA.includes(l.status) && l.proxima_acao_em && l.proxima_acao_em < hoje).length,
      ganhos: meusGanhos,
      toques30: meusToques,
      potencia: meus.filter((l) => STATUS_FILA.includes(l.status)).reduce((a, l) => a + potenciaDe(l), 0),
    };
  }).sort((a, b) => b.total - a.total);

  const tabelaAgentes = h('div', { class: 'tabela-wrap' },
    h('table', { class: 'tabela' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Agente'),
        h('th', { class: 'ta-dir' }, 'Leads'),
        h('th', { class: 'ta-dir' }, 'Em aberto'),
        h('th', { class: 'ta-dir' }, 'Atrasados'),
        h('th', { class: 'ta-dir' }, 'Ganhos'),
        h('th', { class: 'ta-dir' }, 'Toques (30d)'),
        h('th', { class: 'ta-dir' }, 'Potência em aberto'))),
      h('tbody', {}, agentes.map((a) => h('tr', {},
        h('td', {}, a.nome),
        h('td', { class: 'ta-dir' }, fmtNum(a.total)),
        h('td', { class: 'ta-dir' }, fmtNum(a.abertos)),
        h('td', { class: 'ta-dir' }, a.atrasados
          ? h('span', { class: 'prazo atrasado' }, fmtNum(a.atrasados)) : '0'),
        h('td', { class: 'ta-dir' }, fmtNum(a.ganhos)),
        h('td', { class: 'ta-dir' }, fmtNum(a.toques30)),
        h('td', { class: 'ta-dir' }, fmtPotencia(a.potencia)))))));

  /* ── Por origem e por distribuidora ── */
  const contarPor = (chave, rotular) => {
    const m = new Map();
    for (const l of leads) {
      const k = chave(l);
      if (k == null || k === '') continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()]
      .map(([k, v]) => ({ rotulo: rotular(k), valor: v }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 12);
  };

  const porOrigem = contarPor((l) => l.origem, origemLabel);
  const porConc = contarPor(
    (l) => l.concessionaria_codigo || l.concessionaria_raw,
    (k) => mapaConc.get(k) || k,
  );
  const porUF = contarPor((l) => l.uf, (k) => k);

  /* ── Atividade por dia (14 dias) ── */
  const dias = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDias(hoje, -i);
    dias.push({
      rotulo: fmtData(d).slice(0, 5),
      valor: interacoes.filter((x) => dataLocal(x.ocorrido_em) === d).length,
    });
  }

  const taxa = await taxaPreenchimento();

  raiz.append(...limpar(
    cabecalhoPagina('Painel',
      ehGestor ? `Todos os agentes · ${fmtNum(leads.length)} leads` : `${perfil.nome} · sua carteira`),
    kpis,
    h('div', { class: 'grade-2 grade-2--larga' },
      card('Funil por status (leads)', barras(porStatus)),
      card('Funil por status (kW)', barras(potPorStatus, { formatar: (v) => fmtPotencia(v) }))),
    ehGestor ? card('Por agente', tabelaAgentes) : null,
    h('div', { class: 'grade-3' },
      card('Por origem', barras(porOrigem, { cor: 'roxo' })),
      card('Por distribuidora', barras(porConc, { cor: 'ciano' })),
      card('Por UF', barras(porUF, { cor: 'verde' }))),
    card('Toques por dia (14 dias)', barras(dias, { cor: 'ambar' })),
    taxa.enriquecidas
      ? card('Enriquecimento de contato',
        h('div', { class: 'kpis kpis--fina' },
          kpi('CNPJs consultados', fmtNum(taxa.enriquecidas)),
          kpi('Com telefone', `${(taxa.pctTelefone * 100).toFixed(0)}%`, fmtNum(taxa.comTelefone)),
          kpi('Com e-mail', `${(taxa.pctEmail * 100).toFixed(0)}%`, fmtNum(taxa.comEmail)),
          kpi('Pendentes', fmtNum(taxa.pendentes))),
        h('div', { class: 'linha-botoes linha-botoes--fina' },
          Object.entries(taxa.porFonte).map(([f, n]) => badge(`${f}: ${fmtNum(n)}`, 'cinza'))),
        taxa.porFonteAmostra
          ? h('p', { class: 'texto-fraco' }, '"Por fonte" é uma amostra (até 3.000 registros), não a base inteira.')
          : null,
        h('p', { class: 'texto-fraco' },
          'Lembrete de qualidade: o e-mail da base da Receita é majoritariamente contábil/fiscal, '
          + 'não do decisor. Telefone e LinkedIn seguem sendo os canais que convertem.'))
      : null,
  ));
  return raiz;
}
