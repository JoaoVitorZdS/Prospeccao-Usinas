// crm-calculos.js — os números por trás das telas de CRM (Início, Negócios, Tarefas), sem DOM nem banco.
// Tudo é calculado sobre `lead`, `interacao` e `empresa` que já existem — nenhuma tabela nova.

import { STATUS, STATUS_FILA, STATUS_MAP } from './seed.js';
import { addDias, dataLocal } from './util.js';

/** Etapas do quadro de Negócios, da esquerda para a direita. */
export const ETAPAS_QUADRO = ['a_abordar', 'abordado', 'em_conversa', 'qualificado', 'proposta', 'ganho'];
/** Desfechos negativos: ficam numa faixa lateral do quadro. */
export const ENCERRAMENTOS = ['perdido', 'sem_contato', 'descartado'];

const porData = (a, b) => (a.proxima_acao_em || '9999') < (b.proxima_acao_em || '9999') ? -1
  : (a.proxima_acao_em || '9999') > (b.proxima_acao_em || '9999') ? 1
    : (a.tentativas || 0) - (b.tentativas || 0);

/**
 * Tarefas = a próxima ação de cada lead ativo. Agrupa em atrasadas / hoje / próximos `dias` / depois / sem data.
 * Só entra lead em status de trabalho (a_abordar … proposta) e não devolvido.
 */
export function agruparTarefas(leads, hoje, { dias = 7 } = {}) {
  const limite = addDias(hoje, dias);
  const g = { atrasadas: [], hoje: [], proximos: [], depois: [], semData: [] };
  for (const l of leads) {
    if (l.deleted_at || !STATUS_FILA.includes(l.status)) continue;
    if (!l.proxima_acao_em) g.semData.push(l);
    else if (l.proxima_acao_em < hoje) g.atrasadas.push(l);
    else if (l.proxima_acao_em === hoje) g.hoje.push(l);
    else if (l.proxima_acao_em <= limite) g.proximos.push(l);
    else g.depois.push(l);
  }
  for (const lista of Object.values(g)) lista.sort(porData);
  return g;
}

/** Colunas do quadro: cada etapa com seus leads, a contagem e a potência somada (kW). */
export function colunasDoQuadro(leads, potenciaDe = (l) => l.potencia_kwp ?? 0) {
  const ativos = leads.filter((l) => !l.deleted_at);
  return ETAPAS_QUADRO.map((etapa) => {
    const doGrupo = ativos.filter((l) => l.status === etapa).sort(porData);
    return {
      etapa, label: STATUS_MAP[etapa].label, cor: STATUS_MAP[etapa].cor,
      leads: doGrupo, total: doGrupo.length,
      potencia: doGrupo.reduce((s, l) => s + (potenciaDe(l) || 0), 0),
    };
  });
}

/** Contagem dos desfechos negativos (faixa "Encerrados" do quadro). */
export function contarEncerrados(leads) {
  const out = Object.fromEntries(ENCERRAMENTOS.map((e) => [e, 0]));
  for (const l of leads) if (!l.deleted_at && out[l.status] != null) out[l.status]++;
  return out;
}

/** Os números de topo do Início. `potenciaDe(lead)` devolve kW (com fallback para a empresa). */
export function resumoInicio({ leads, interacoes, hoje, potenciaDe = (l) => l.potencia_kwp ?? 0 }) {
  const ativos = leads.filter((l) => !l.deleted_at);
  const emTrabalho = ativos.filter((l) => STATUS_FILA.includes(l.status));
  const ganhos = ativos.filter((l) => l.status === 'ganho');
  const seteDias = addDias(hoje, -7);
  const semana = interacoes.filter((i) => dataLocal(i.ocorrido_em) >= seteDias);
  const saiuDaFila = ativos.filter((l) => l.status !== 'a_abordar').length;
  const tarefas = agruparTarefas(ativos, hoje);
  return {
    tarefasHoje: tarefas.hoje.length,
    atrasadas: tarefas.atrasadas.length,
    emPipeline: emTrabalho.length,
    potenciaPipeline: emTrabalho.reduce((s, l) => s + (potenciaDe(l) || 0), 0),
    ganhos: ganhos.length,
    potenciaGanha: ganhos.reduce((s, l) => s + (potenciaDe(l) || 0), 0),
    contatosSemana: semana.length,
    leadsTocadosSemana: new Set(semana.map((i) => i.lead_id)).size,
    taxaGanho: saiuDaFila ? ganhos.length / saiuDaFila : 0,
    total: ativos.length,
  };
}

/** Funil: quantos leads (e kW) em cada status, na ordem das etapas, só os que têm algo. */
export function funil(leads, potenciaDe = (l) => l.potencia_kwp ?? 0) {
  return STATUS.map((s) => {
    const doGrupo = leads.filter((l) => !l.deleted_at && l.status === s.v);
    return {
      status: s.v, label: s.label, cor: s.cor, total: doGrupo.length,
      potencia: doGrupo.reduce((a, l) => a + (potenciaDe(l) || 0), 0),
    };
  }).filter((x) => x.total > 0);
}

/** Últimas interações (mais recentes primeiro), só de leads conhecidos. */
export function atividadeRecente(interacoes, leadsPorId, limite = 8) {
  return interacoes
    .filter((i) => leadsPorId.has(i.lead_id))
    .sort((a, b) => (a.ocorrido_em < b.ocorrido_em ? 1 : -1))
    .slice(0, limite)
    .map((i) => ({ ...i, lead: leadsPorId.get(i.lead_id) }));
}
