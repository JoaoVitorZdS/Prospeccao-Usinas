// views/tarefas.js — a próxima ação de cada lead, agrupada por prazo: atrasadas, hoje, próximos 7 dias.
//
// "Tarefa" não é uma tabela: é o `proxima_acao_em` do lead (a mesma data que a lista de Leads e a fila já
// usam). Registrar o contato abre a gaveta de abordagem (que grava o toque e define a próxima data);
// adiar só muda a data.

import { h, hojeISO, addDias, fmtData, diasEntre, limpar } from '../util.js';
import { buscarLeads, todos, atualizarLeads } from '../db.js';
import {
  cabecalhoPagina, card, tabela, badgeStatus, menuSuspenso, icone, pills, toast, vazio, perguntar,
} from '../ui.js';
import { agruparTarefas } from '../crm-calculos.js';
import { abrirCockpit } from './cockpit.js';

const GRUPOS = [
  { id: 'atrasadas', titulo: 'Atrasadas', cor: 'vermelho', vazio: 'Nenhuma tarefa atrasada.' },
  { id: 'hoje', titulo: 'Hoje', cor: 'ambar', vazio: 'Nada marcado para hoje.' },
  { id: 'proximos', titulo: 'Próximos 7 dias', cor: 'azul', vazio: 'Nada nos próximos 7 dias.' },
];

export async function viewTarefas(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;
  const estado = { escopo: ehGestor && params.escopo === 'equipe' ? 'equipe' : 'meus', mostrarDepois: false };
  const raiz = h('div', { class: 'pagina' });
  const area = h('div', { class: 'pagina' });
  const [perfis] = await Promise.all([todos('profiles')]);
  const mapaAgente = new Map(perfis.map((p) => [p.id, p.nome]));
  let leads = [];

  const recarregar = async () => { leads = await buscarLeads({}); };

  async function adiar(lead, dias) {
    let data;
    if (dias === 'data') {
      const r = await perguntar('Nova data', [{ campo: 'data', label: 'Próxima ação', tipo: 'date', valor: addDias(hojeISO(), 1), obrigatorio: true }], { ok: 'Reagendar' });
      if (!r) return;
      data = r.data;
    } else data = dias == null ? null : addDias(hojeISO(), dias);
    try {
      await atualizarLeads([lead.id], { proxima_acao_em: data });
      toast(data ? `Reagendada para ${fmtData(data)}.` : 'Tarefa removida (sem próxima ação).', 'ok', 2500);
      await recarregar();
      desenhar();
    } catch (e) { toast(e.message, 'erro', 7000); }
  }

  function tabelaDoGrupo(lista) {
    return tabela({
      linhas: lista,
      aoAbrir: (lead, i) => abrirCockpit({ lead, fila: lista, indice: i, perfil, aoMudar: () => recarregar().then(desenhar) }),
      colunas: [
        {
          titulo: 'Lead',
          render: (l) => h('div', { class: 'cel-principal' },
            h('strong', {}, h('a', { class: 'link-lead', href: `#/lead/${l.id}` }, l.razao_social || l.contato_nome || '(sem nome)')),
            h('span', {}, [l.cidade, l.uf].filter(Boolean).join('/') || (l.contato_nome || ''))),
        },
        { titulo: 'Status', largura: '130px', render: (l) => badgeStatus(l.status) },
        {
          titulo: 'Prazo', largura: '150px',
          render: (l) => {
            if (!l.proxima_acao_em) return h('span', { class: 'texto-fraco' }, 'sem data');
            const d = diasEntre(hojeISO(), l.proxima_acao_em);
            return h('span', { class: `prazo ${d < 0 ? 'atrasado' : d === 0 ? 'hoje' : ''}` }, fmtData(l.proxima_acao_em),
              d < 0 ? h('em', {}, `${-d}d de atraso`) : d === 0 ? h('em', {}, 'hoje') : null);
          },
        },
        { titulo: 'Tent.', largura: '60px', alinha: 'dir', render: (l) => String(l.tentativas || 0) },
        ...(estado.escopo === 'equipe' ? [{ titulo: 'Dono', largura: '130px', render: (l) => mapaAgente.get(l.owner_id) || '—' }] : []),
        {
          titulo: '', largura: '230px',
          render: (l) => {
            const botao = h('button', { class: 'btn btn--mini', type: 'button' }, 'Adiar ', icone('seta', { tamanho: 'peq' }));
            return h('div', { class: 'linha-botoes linha-botoes--fina' },
              h('button', {
                class: 'btn btn--mini btn--primario', type: 'button',
                onclick: () => abrirCockpit({ lead: l, fila: [l], indice: 0, perfil, aoMudar: () => recarregar().then(desenhar) }),
              }, 'Registrar contato'),
              menuSuspenso(botao, [
                { rotulo: 'Amanhã', onclick: () => adiar(l, 1) },
                { rotulo: 'Em 3 dias', onclick: () => adiar(l, 3) },
                { rotulo: 'Em 7 dias', onclick: () => adiar(l, 7) },
                { rotulo: 'Escolher data…', onclick: () => adiar(l, 'data') },
                { sep: true },
                { rotulo: 'Sem próxima ação', onclick: () => adiar(l, null) },
              ]));
          },
        },
      ],
      vaziaMsg: '',
    });
  }

  function desenhar() {
    const doEscopo = estado.escopo === 'equipe' ? leads : leads.filter((l) => l.owner_id === perfil.id);
    const g = agruparTarefas(doEscopo, hojeISO());
    const total = g.atrasadas.length + g.hoje.length + g.proximos.length;
    area.replaceChildren(...limpar(
      h('div', { class: 'kpis kpis--fina' },
        ...GRUPOS.map((x) => h('a', { class: 'kpi kpi--link', href: `#tarefa-${x.id}`, onclick: (e) => { e.preventDefault(); document.getElementById(`tarefa-${x.id}`)?.scrollIntoView({ behavior: 'smooth' }); } },
          h('div', { class: 'kpi__valor' }, String(g[x.id].length)), h('div', { class: 'kpi__rotulo' }, x.titulo))),
        h('div', { class: 'kpi' }, h('div', { class: 'kpi__valor' }, String(g.semData.length)), h('div', { class: 'kpi__rotulo' }, 'Sem próxima ação'))),
      total === 0 && !g.depois.length && !g.semData.length
        ? vazio('Nenhuma tarefa', 'Os leads em trabalho aparecem aqui conforme a data da próxima ação.')
        : null,
      ...GRUPOS.map((x) => h('div', { id: `tarefa-${x.id}` },
        card(h('div', { class: 'card__cabeca' }, h('h2', {}, `${x.titulo} (${g[x.id].length})`)),
          g[x.id].length ? tabelaDoGrupo(g[x.id]) : h('p', { class: 'texto-fraco' }, x.vazio)))),
      g.depois.length || g.semData.length
        ? card(h('div', { class: 'card__cabeca' }, h('h2', {}, 'Depois'),
          h('button', { class: 'btn btn--mini', type: 'button', onclick: () => { estado.mostrarDepois = !estado.mostrarDepois; desenhar(); } },
            estado.mostrarDepois ? 'Recolher' : `Mostrar (${g.depois.length + g.semData.length})`)),
        estado.mostrarDepois
          ? h('div', { class: 'pagina' },
            g.depois.length ? [h('h3', {}, `Mais de 7 dias (${g.depois.length})`), tabelaDoGrupo(g.depois)] : null,
            g.semData.length ? [h('h3', {}, `Sem próxima ação (${g.semData.length})`),
              h('p', { class: 'texto-fraco' }, 'Leads em trabalho sem data: nunca aparecem como tarefa até receberem uma.'),
              tabelaDoGrupo(g.semData)] : null)
          : h('p', { class: 'texto-fraco' }, 'Tarefas além dos próximos 7 dias e leads sem data ficam recolhidos.'))
        : null));
  }

  raiz.append(
    cabecalhoPagina('Tarefas', 'A próxima ação de cada lead — o que vence primeiro aparece no topo',
      ehGestor ? pills([{ v: 'meus', label: 'Minhas' }, { v: 'equipe', label: 'Equipe' }], estado.escopo,
        (v) => { estado.escopo = v; desenhar(); }) : null),
    area);
  await recarregar();
  desenhar();
  return raiz;
}
