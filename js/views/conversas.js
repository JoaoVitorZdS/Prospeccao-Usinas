// views/conversas.js — "CRM completo para lidar com as conversas", dentro da
// regra que o plano já fixou: a ferramenta PREPARA e REGISTRA, nunca envia.
//
// O que muda aqui não é permissão de disparo — é a LENTE. Em vez de olhar os
// leads (Minha fila), esta tela olha os TOQUES: uma caixa de entrada ordenada
// pelo contato mais recente, com sinal claro de "esperando resposta há quanto
// tempo" e o canal de cada toque. Mesma base de dados (`interacao` + `lead`),
// visão de conversa em vez de visão de tarefa. Abre o mesmo cockpit de sempre.

import { h, fmtData, fmtDataHora, diasEntre, hojeISO, debounce, dataLocal } from '../util.js';
import { CANAIS, RESULTADO_MAP, statusLabel, origemLabel } from '../seed.js';
import { todos, buscarLeads, get } from '../db.js';
import { cabecalhoPagina, tabela, badge, badgeStatus, vazio, kpi, pills, toast } from '../ui.js';
import { abrirCockpit } from './cockpit.js';

const CANAL_MAP = Object.fromEntries(CANAIS.map((c) => [c.v, c]));

const FILTROS = [
  { v: 'aguardando', label: 'Aguardando resposta' },
  { v: 'recentes', label: 'Últimos 7 dias' },
  { v: 'sem_retorno', label: 'Sem retorno há 15+ dias' },
  { v: 'todas', label: 'Todas as conversas' },
];

export async function viewConversas(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;

  const estado = { escopo: ehGestor ? 'todos' : 'meus', filtro: 'aguardando', canal: '', texto: '' };

  const raiz = h('div', { class: 'pagina' });
  const areaKpis = h('div', { class: 'kpis' });
  const areaFiltros = h('div', {});
  const areaLista = h('div', {});

  async function carregarBase() {
    const [leads, interacoes, perfis] = await Promise.all([
      buscarLeads({ owner_id: estado.escopo === 'meus' ? perfil.id : null }),
      todos('interacao'),
      todos('profiles'),
    ]);
    const mapaAgente = new Map(perfis.map((p) => [p.id, p.nome]));
    const leadsPorId = new Map(leads.map((l) => [l.id, l]));

    // última interação por lead — o que define a posição na "caixa de entrada"
    const ultimaPorLead = new Map();
    for (const i of interacoes) {
      if (!leadsPorId.has(i.lead_id)) continue; // fora do escopo (owner/deleted)
      const atual = ultimaPorLead.get(i.lead_id);
      if (!atual || i.ocorrido_em > atual.ocorrido_em) ultimaPorLead.set(i.lead_id, i);
    }

    const linhas = [...ultimaPorLead.entries()]
      .map(([leadId, ultima]) => ({ lead: leadsPorId.get(leadId), ultima }))
      .sort((a, b) => (a.ultima.ocorrido_em < b.ultima.ocorrido_em ? 1 : -1));

    return { linhas, mapaAgente };
  }

  function aplicarFiltros(linhas) {
    const hoje = hojeISO();
    let out = linhas;
    if (estado.canal) out = out.filter((r) => r.ultima.canal === estado.canal);
    if (estado.texto) {
      const q = estado.texto.toLowerCase();
      out = out.filter((r) =>
        (r.lead.razao_social || '').toLowerCase().includes(q)
        || (r.lead.contato_nome || '').toLowerCase().includes(q)
        || (r.ultima.descricao || '').toLowerCase().includes(q));
    }
    switch (estado.filtro) {
      case 'aguardando':
        return out.filter((r) => r.ultima.sentido === 'saida'
          && ['abordado', 'em_conversa'].includes(r.lead.status));
      case 'recentes':
        return out.filter((r) => diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) <= 7);
      case 'sem_retorno':
        return out.filter((r) => r.ultima.sentido === 'saida'
          && ['abordado', 'em_conversa'].includes(r.lead.status)
          && diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) >= 15);
      default:
        return out;
    }
  }

  function linhaConversa(r, mapaAgente) {
    const c = CANAL_MAP[r.ultima.canal];
    const dias = diasEntre(dataLocal(r.ultima.ocorrido_em), hojeISO());
    const aguardando = r.ultima.sentido === 'saida' && ['abordado', 'em_conversa'].includes(r.lead.status);
    return h('article', {
      class: `conversa ${aguardando && dias >= 7 ? 'conversa--atrasada' : ''}`,
      tabindex: '0',
      onclick: () => abrirCockpitPara(r.lead.id),
      onkeydown: (e) => { if (e.key === 'Enter') abrirCockpitPara(r.lead.id); },
    },
      h('div', { class: 'conversa__ico', title: c?.label || r.ultima.canal }, c?.icone || '•'),
      h('div', { class: 'conversa__corpo' },
        h('div', { class: 'conversa__topo' },
          h('strong', {}, r.lead.razao_social || r.lead.contato_nome || '(sem nome)'),
          badgeStatus(r.lead.status),
          aguardando ? badge(dias === 0 ? 'aguardando hoje' : `aguardando há ${dias}d`, dias >= 15 ? 'vermelho' : dias >= 7 ? 'ambar' : 'azul') : null,
          r.ultima.sentido === 'entrada' ? badge('respondeu', 'verde') : null),
        h('p', { class: 'conversa__prevista' }, r.ultima.descricao || h('em', {}, 'sem descrição registrada')),
        h('div', { class: 'conversa__rodape' },
          h('span', {}, mapaAgente.get(r.lead.owner_id) || '—'),
          h('span', {}, fmtDataHora(r.ultima.ocorrido_em)),
          r.ultima.resultado ? h('span', {}, RESULTADO_MAP[r.ultima.resultado]?.label || r.ultima.resultado) : null,
          badge(origemLabel(r.lead.origem), 'cinza'))));
  }

  async function abrirCockpitPara(leadId) {
    const lead = await get('lead', leadId);
    if (!lead) { toast('Lead não encontrado (pode ter sido removido).', 'erro'); return; }
    abrirCockpit({ lead, perfil, aoMudar: () => desenhar() });
  }

  async function desenhar() {
    const { linhas, mapaAgente } = await carregarBase();
    const filtradas = aplicarFiltros(linhas);

    const hoje = hojeISO();
    const aguardando = linhas.filter((r) => r.ultima.sentido === 'saida' && ['abordado', 'em_conversa'].includes(r.lead.status));
    const semRetorno15 = aguardando.filter((r) => diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) >= 15);
    const hoje7 = linhas.filter((r) => diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) <= 7);
    const responderam = linhas.filter((r) => r.ultima.sentido === 'entrada'
      && diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) <= 7).length;

    areaKpis.replaceChildren(
      kpi('Conversas ativas', String(linhas.length)),
      kpi('Aguardando resposta', String(aguardando.length)),
      kpi('Sem retorno 15d+', String(semRetorno15.length), semRetorno15.length ? 'considere reagendar ou marcar sem_contato' : 'em dia'),
      kpi('Responderam (7d)', String(responderam)));

    const canaisPresentes = [...new Set(linhas.map((r) => r.ultima.canal))];
    areaFiltros.replaceChildren(
      pills(FILTROS.map((f) => ({ ...f })), estado.filtro, (v) => { estado.filtro = v; desenhar(); }),
      h('div', { class: 'filtros', style: 'margin-top:8px' },
        ehGestor ? pills(
          [{ v: 'meus', label: 'Minhas' }, { v: 'todos', label: 'Todas (equipe)' }],
          estado.escopo, (v) => { estado.escopo = v; desenhar(); },
        ) : null,
        canaisPresentes.length > 1
          ? (() => {
            const s = h('select', {},
              h('option', { value: '' }, 'Todos os canais'),
              canaisPresentes.map((c) => h('option', { value: c, selected: c === estado.canal }, CANAL_MAP[c]?.label || c)));
            s.addEventListener('change', () => { estado.canal = s.value; desenhar(); });
            return s;
          })()
          : null,
        (() => {
          const i = h('input', { type: 'search', class: 'busca', placeholder: 'Buscar por nome ou conteúdo…', 'aria-label': 'Buscar conversas', value: estado.texto });
          i.addEventListener('input', debounce(() => { estado.texto = i.value.trim(); desenhar(); }, 220));
          return i;
        })()));

    areaLista.replaceChildren(
      filtradas.length
        ? h('div', { class: 'lista-conversas' }, filtradas.map((r) => linhaConversa(r, mapaAgente)))
        : vazio('Nenhuma conversa neste filtro',
          estado.filtro === 'aguardando'
            ? 'Nada esperando resposta agora — bom sinal, ou é hora de abordar leads novos.'
            : 'Ajuste o filtro ou registre toques na fila.'));
  }

  raiz.append(
    cabecalhoPagina('Conversas',
      'Caixa de entrada dos toques registrados — a ferramenta prepara e registra; quem envia é você, no seu canal'),
    areaKpis,
    areaFiltros,
    areaLista);
  await desenhar();
  return raiz;
}
