// views/conversas.js — Comunicações: caixa de entrada em três painéis (lista · conversa · contexto).
//
// Regra do produto: a ferramenta PREPARA e REGISTRA, nunca envia. A "conversa" é o histórico de toques de um
// lead (`interacao`) — não existe tabela de mensagens. O painel do meio reúne o histórico e o formulário de
// registro do toque; o da direita, o contexto do lead (script de abordagem, links, dados). É o MESMO cockpit
// da gaveta e da página do lead (views/cockpit.js), só montado em colunas.

import { h, fmtDataHora, diasEntre, debounce, dataLocal, hojeISO, limpar } from '../util.js';
import { CANAIS, RESULTADO_MAP, origemLabel } from '../seed.js';
import { todos, buscarLeads } from '../db.js';
import { cabecalhoPagina, badge, badgeStatus, vazio, kpi, pills, breadcrumb, icone } from '../ui.js';
import { criarCockpit } from './cockpit.js';

const CANAL_MAP = Object.fromEntries(CANAIS.map((c) => [c.v, c]));

const FILTROS = [
  { v: 'aguardando', label: 'Aguardando resposta' },
  { v: 'recentes', label: 'Últimos 7 dias' },
  { v: 'sem_retorno', label: 'Sem retorno há 15+ dias' },
  { v: 'todas', label: 'Todas' },
];

export async function viewConversas(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;
  const estado = {
    escopo: ehGestor ? 'todos' : 'meus', filtro: 'aguardando', canal: '', texto: '', selecionado: null,
  };

  const raiz = h('div', { class: 'pagina' });
  const areaKpis = h('div', { class: 'kpis kpis--fina' });
  const areaFiltros = h('div', { class: 'caixa__filtros' });
  const areaLista = h('div', { class: 'caixa__itens' });
  const painelConversa = h('section', { class: 'caixa__conversa', 'aria-label': 'Conversa' });
  const painelContexto = h('aside', { class: 'caixa__contexto', 'aria-label': 'Contexto do lead' });
  const caixa = h('div', { class: 'caixa' },
    h('section', { class: 'caixa__lista', 'aria-label': 'Conversas' }, areaFiltros, areaLista),
    painelConversa, painelContexto);

  let base = { linhas: [], mapaAgente: new Map() };
  let cockpitAtivo = null;

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
      if (!leadsPorId.has(i.lead_id)) continue; // fora do escopo (dono/devolvido)
      const atual = ultimaPorLead.get(i.lead_id);
      if (!atual || i.ocorrido_em > atual.ocorrido_em) ultimaPorLead.set(i.lead_id, i);
    }
    const linhas = [...ultimaPorLead.entries()]
      .map(([leadId, ultima]) => ({ lead: leadsPorId.get(leadId), ultima }))
      .sort((a, b) => (a.ultima.ocorrido_em < b.ultima.ocorrido_em ? 1 : -1));
    base = { linhas, mapaAgente };
  }

  const esperando = (r) => r.ultima.sentido === 'saida' && ['abordado', 'em_conversa'].includes(r.lead.status);

  function aplicarFiltros(linhas) {
    const hoje = hojeISO();
    let out = linhas;
    if (estado.canal) out = out.filter((r) => r.ultima.canal === estado.canal);
    if (estado.texto) {
      const q = estado.texto.toLowerCase();
      out = out.filter((r) => (r.lead.razao_social || '').toLowerCase().includes(q)
        || (r.lead.contato_nome || '').toLowerCase().includes(q)
        || (r.ultima.descricao || '').toLowerCase().includes(q));
    }
    switch (estado.filtro) {
      case 'aguardando': return out.filter(esperando);
      case 'recentes': return out.filter((r) => diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) <= 7);
      case 'sem_retorno': return out.filter((r) => esperando(r) && diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) >= 15);
      default: return out;
    }
  }

  function itemDaLista(r) {
    const c = CANAL_MAP[r.ultima.canal];
    const dias = diasEntre(dataLocal(r.ultima.ocorrido_em), hojeISO());
    const aguardando = esperando(r);
    const ativo = r.lead.id === estado.selecionado;
    return h('article', {
      class: `conversa${aguardando && dias >= 7 ? ' conversa--atrasada' : ''}${ativo ? ' is-selecionada' : ''}`,
      tabindex: '0', 'aria-current': ativo ? 'true' : null, dataset: { lead: r.lead.id },
      onclick: () => selecionar(r.lead.id),
      onkeydown: (e) => { if (e.key === 'Enter') selecionar(r.lead.id); },
    },
    h('div', { class: 'conversa__ico', title: c?.label || r.ultima.canal }, c?.icone || '•'),
    h('div', { class: 'conversa__corpo' },
      h('div', { class: 'conversa__topo' },
        h('strong', {}, r.lead.razao_social || r.lead.contato_nome || '(sem nome)'),
        aguardando ? badge(dias === 0 ? 'aguardando hoje' : `aguardando há ${dias}d`, dias >= 15 ? 'vermelho' : dias >= 7 ? 'ambar' : 'azul') : null,
        r.ultima.sentido === 'entrada' ? badge('respondeu', 'verde') : null),
      h('p', { class: 'conversa__prevista' }, r.ultima.descricao || h('em', {}, 'sem descrição registrada')),
      h('div', { class: 'conversa__rodape' },
        h('span', {}, base.mapaAgente.get(r.lead.owner_id) || '—'),
        h('span', {}, fmtDataHora(r.ultima.ocorrido_em)),
        r.ultima.resultado ? h('span', {}, RESULTADO_MAP[r.ultima.resultado]?.label || r.ultima.resultado) : null)));
  }

  /* ═══════════ Conversa selecionada: o mesmo cockpit, em duas colunas ═══════════ */

  function limparSelecao() {
    cockpitAtivo?.desmontar();
    cockpitAtivo = null;
    estado.selecionado = null;
    caixa.classList.remove('caixa--detalhe');
    painelConversa.replaceChildren(h('div', { class: 'caixa__vazio' },
      icone('conversas'), h('h3', {}, 'Selecione uma conversa'),
      h('p', { class: 'texto-fraco' }, 'O histórico, o formulário de registro e o script de abordagem aparecem aqui.')));
    painelContexto.replaceChildren();
  }

  async function selecionar(leadId) {
    const linha = base.linhas.find((r) => r.lead.id === leadId);
    if (!linha) return limparSelecao();
    estado.selecionado = leadId;
    cockpitAtivo?.desmontar();
    caixa.classList.add('caixa--detalhe');
    areaLista.querySelectorAll('.conversa').forEach((el) => {
      el.classList.toggle('is-selecionada', el.dataset.lead === leadId);
    });

    const cockpit = await criarCockpit({
      lead: linha.lead, perfil,
      aoMudar: async () => { await carregarBase(); desenharLista(); },
      aoSair: () => { limparSelecao(); carregarBase().then(desenharLista); },
    });
    cockpitAtivo = cockpit;
    cockpit.montar((s, ctx) => {
      const { d, atual } = ctx;
      painelConversa.replaceChildren(
        h('header', { class: 'caixa__cab' },
          h('button', { class: 'btn btn--mini caixa__voltar', type: 'button', onclick: limparSelecao }, '← Conversas'),
          h('div', {},
            h('h2', {}, d.razao || d.contato || 'Lead sem nome'),
            h('div', { class: 'cockpit__meta' }, badgeStatus(atual.status), badge(origemLabel(atual.origem), 'azul'))),
          h('a', { class: 'btn btn--mini', href: `#/lead/${atual.id}` }, 'Abrir lead')),
        s.timeline, s.registrar);
      painelContexto.replaceChildren(s.fatos, s.abordar);
    }, painelConversa);
  }

  /* ═══════════ Lista, filtros e KPIs ═══════════ */

  function desenharLista() {
    const { linhas } = base;
    const hoje = hojeISO();
    const aguardando = linhas.filter(esperando);
    const semRetorno15 = aguardando.filter((r) => diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) >= 15);
    const responderam = linhas.filter((r) => r.ultima.sentido === 'entrada'
      && diasEntre(dataLocal(r.ultima.ocorrido_em), hoje) <= 7).length;
    areaKpis.replaceChildren(
      kpi('Conversas ativas', String(linhas.length)),
      kpi('Aguardando resposta', String(aguardando.length)),
      kpi('Sem retorno 15d+', String(semRetorno15.length), semRetorno15.length ? 'reagende ou marque sem contato' : 'em dia'),
      kpi('Responderam (7d)', String(responderam)));

    const canaisPresentes = [...new Set(linhas.map((r) => r.ultima.canal))];
    const seletorCanal = canaisPresentes.length > 1
      ? (() => {
        const s = h('select', { 'aria-label': 'Filtrar por canal' },
          h('option', { value: '' }, 'Todos os canais'),
          canaisPresentes.map((c) => h('option', { value: c, selected: c === estado.canal }, CANAL_MAP[c]?.label || c)));
        s.addEventListener('change', () => { estado.canal = s.value; desenharLista(); });
        return s;
      })()
      : null;
    const busca = h('input', {
      type: 'search', class: 'busca', placeholder: 'Buscar por nome ou conteúdo…', 'aria-label': 'Buscar conversas', value: estado.texto,
    });
    busca.addEventListener('input', debounce(() => { estado.texto = busca.value.trim(); desenharLista(); }, 220));

    areaFiltros.replaceChildren(...limpar(
      pills(FILTROS.map((f) => ({ ...f })), estado.filtro, (v) => { estado.filtro = v; desenharLista(); }),
      ehGestor ? pills([{ v: 'meus', label: 'Minhas' }, { v: 'todos', label: 'Equipe' }], estado.escopo,
        async (v) => { estado.escopo = v; await carregarBase(); desenharLista(); }) : null,
      h('div', { class: 'linha-botoes' }, busca, seletorCanal)));

    const filtradas = aplicarFiltros(linhas);
    areaLista.replaceChildren(filtradas.length
      ? h('div', { class: 'lista-conversas' }, filtradas.map(itemDaLista))
      : vazio('Nenhuma conversa neste filtro',
        estado.filtro === 'aguardando'
          ? 'Nada esperando resposta agora — bom sinal, ou é hora de abordar leads novos.'
          : 'Ajuste o filtro ou registre toques em Leads.'));
  }

  raiz.append(
    breadcrumb([{ label: 'Comunicações' }]),
    cabecalhoPagina('Comunicações',
      'Caixa de entrada dos toques registrados — a ferramenta prepara e registra; quem envia é você, no seu canal'),
    areaKpis, caixa);

  const inicial = params.lead;           // #/conversas?lead=<id> abre direto a conversa
  await carregarBase();
  desenharLista();
  limparSelecao();
  if (inicial) await selecionar(inicial);
  return raiz;
}
