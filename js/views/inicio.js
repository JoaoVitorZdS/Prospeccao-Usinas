// views/inicio.js — o painel inicial do CRM: o que fazer hoje, como está o funil e o que aconteceu por último.
//
// Os números vêm de js/crm-calculos.js (testado). O gestor alterna entre a própria carteira e a equipe
// inteira; o agente só enxerga a dele (o banco já garante isso — o RLS).

import { h, fmtNum, fmtPotencia, fmtDataHora, hojeISO, diasEntre } from '../util.js';
import { CANAIS } from '../seed.js';
import { buscarLeads, todos, empresasPorCnpj, backlogTodos } from '../db.js';
import { cabecalhoPagina, card, kpi, badgeStatus, pills, vazio, navegar } from '../ui.js';
import { agruparTarefas, resumoInicio, funil, atividadeRecente } from '../crm-calculos.js';

const CANAL_MAP = Object.fromEntries(CANAIS.map((c) => [c.v, c]));

function saudacao(nome) {
  const hora = new Date().getHours();
  const periodo = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
  return `${periodo}, ${String(nome || '').split(' ')[0]}`;
}

const dataLonga = () => new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

export async function viewInicio(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;
  const estado = { escopo: params.escopo === 'equipe' && ehGestor ? 'equipe' : 'meus' };
  const raiz = h('div', { class: 'pagina' });
  const area = h('div', { class: 'pagina' });

  const [leadsTodos, interacoes, concessionarias, backlog] = await Promise.all([
    buscarLeads({}), todos('interacao'), todos('concessionaria'), backlogTodos().catch(() => []),
  ]);
  const empresas = new Map((await empresasPorCnpj(leadsTodos.map((l) => l.cnpj))).map((e) => [e.cnpj, e]));
  const nomeConc = new Map(concessionarias.map((c) => [c.codigo, c.nome]));
  const potenciaDe = (l) => l.potencia_kwp ?? empresas.get(l.cnpj)?.potencia_total_kw ?? 0;
  const hoje = hojeISO();

  function desenhar() {
    const leads = estado.escopo === 'equipe' ? leadsTodos : leadsTodos.filter((l) => l.owner_id === perfil.id);
    const idsDosLeads = new Set(leads.map((l) => l.id));
    const inter = interacoes.filter((i) => idsDosLeads.has(i.lead_id));
    const r = resumoInicio({ leads, interacoes: inter, hoje, potenciaDe });
    const tarefas = agruparTarefas(leads.filter((l) => estado.escopo === 'equipe' || l.owner_id === perfil.id), hoje);
    const pendentes = [...tarefas.atrasadas, ...tarefas.hoje];
    const porId = new Map(leads.map((l) => [l.id, l]));

    const linkLead = (l) => h('a', { class: 'link-lead', href: `#/lead/${l.id}` }, l.razao_social || l.contato_nome || '(sem nome)');

    /* ── tarefas de hoje ── */
    const cardTarefas = card(
      h('div', { class: 'card__cabeca' },
        h('h2', {}, 'Para fazer agora'),
        h('a', { class: 'btn btn--mini', href: '#/tarefas' }, 'Ver todas as tarefas')),
      pendentes.length
        ? h('ul', { class: 'lista-feed' }, pendentes.slice(0, 8).map((l) => {
          const d = diasEntre(hoje, l.proxima_acao_em);
          return h('li', { class: 'feed__item' },
            h('div', { class: 'feed__corpo' }, linkLead(l), h('span', { class: 'texto-fraco' }, [l.cidade, l.uf].filter(Boolean).join('/') || '—')),
            badgeStatus(l.status),
            h('span', { class: `prazo ${d < 0 ? 'atrasado' : 'hoje'}` }, d < 0 ? `${-d}d de atraso` : 'hoje'));
        }))
        : vazio('Tudo em dia', 'Nenhuma tarefa vencida ou para hoje. Veja os próximos dias em Tarefas ou prospecte novas usinas.'));

    /* ── funil ── */
    const f = funil(leads, potenciaDe);
    const maxF = Math.max(1, ...f.map((x) => x.total));
    const cardFunil = card('Funil',
      f.length
        ? h('div', { class: 'barras' }, f.map((x) => h('a', {
          class: 'barra barra--link', href: `#/leads?f=${estado.escopo === 'equipe' ? 'todos' : 'meus'}&status=${x.status}`,
          title: `${fmtPotencia(x.potencia)} · abrir os leads`,
        },
        h('span', { class: 'barra__rot' }, x.label),
        h('div', { class: 'barra__trilho' }, h('div', { class: `barra__fill barra__fill--${x.cor}`, style: `width:${(x.total / maxF) * 100}%` })),
        h('span', { class: 'barra__val' }, fmtNum(x.total)))))
        : vazio('Sem leads', 'Importe uma planilha ou prospecte usinas para começar.'));

    /* ── atividade recente ── */
    const recente = atividadeRecente(inter, porId, 8);
    const cardAtividade = card('Atividade recente',
      recente.length
        ? h('ul', { class: 'lista-feed' }, recente.map((i) => {
          const c = CANAL_MAP[i.canal];
          return h('li', { class: 'feed__item' },
            h('span', { class: 'feed__ico', title: c?.label }, c?.icone || '•'),
            h('div', { class: 'feed__corpo' }, linkLead(i.lead),
              h('span', { class: 'texto-fraco' }, i.descricao || (i.resultado ? i.resultado.replaceAll('_', ' ') : 'toque registrado'))),
            h('span', { class: 'texto-fraco' }, fmtDataHora(i.ocorrido_em)));
        }))
        : h('p', { class: 'texto-fraco' }, 'Nenhum contato registrado ainda.'));

    /* ── mercado: onde mais faltam usinas ── */
    const topo = backlog.filter((b) => Number(b.backlog_kwh_mes) > 0)
      .sort((a, b) => Number(b.backlog_kwh_mes) - Number(a.backlog_kwh_mes)).slice(0, 5);
    const maxB = Math.max(1, ...topo.map((b) => Number(b.backlog_kwh_mes)));
    const cardMercado = card(
      h('div', { class: 'card__cabeca' }, h('h2', {}, 'Onde faltam usinas'), h('a', { class: 'btn btn--mini', href: '#/backlog' }, 'Mercado')),
      topo.length
        ? h('div', { class: 'barras' }, topo.map((b) => h('a', {
          class: 'barra barra--link', href: `#/descobrir?conc=${encodeURIComponent(b.concessionaria_codigo)}`, title: 'Ver usinas desta distribuidora',
        },
        h('span', { class: 'barra__rot' }, nomeConc.get(b.concessionaria_codigo) || b.concessionaria_codigo),
        h('div', { class: 'barra__trilho' }, h('div', { class: 'barra__fill barra__fill--vermelho', style: `width:${(Number(b.backlog_kwh_mes) / maxB) * 100}%` })),
        h('span', { class: 'barra__val' }, `${fmtNum(Number(b.backlog_kwh_mes) / 1000, 0)} MWh`))))
        : h('p', { class: 'texto-fraco' }, 'Sem backlog cadastrado. Um gestor registra em Mercado.'));

    area.replaceChildren(
      h('div', { class: 'kpis' },
        kpi('Para hoje', fmtNum(r.tarefasHoje), r.atrasadas ? `${fmtNum(r.atrasadas)} atrasada(s)` : 'nada atrasado'),
        kpi('Potência em pipeline', fmtPotencia(r.potenciaPipeline), `${fmtNum(r.emPipeline)} leads em aberto`),
        kpi('Potência ganha', fmtPotencia(r.potenciaGanha), `${fmtNum(r.ganhos)} lead(s)`),
        kpi('Contatos na semana', fmtNum(r.contatosSemana), `${fmtNum(r.leadsTocadosSemana)} lead(s) distintos`),
        kpi('Taxa de ganho', `${fmtNum(r.taxaGanho * 100, 1)}%`, `${fmtNum(r.total)} leads no total`)),
      h('div', { class: 'grade-2 grade-2--larga' }, cardTarefas, cardFunil),
      h('div', { class: 'grade-2 grade-2--larga' }, cardAtividade, cardMercado));
  }

  raiz.append(
    cabecalhoPagina(saudacao(perfil.nome), `${dataLonga()} · seu resumo de prospecção`,
      ehGestor
        ? pills([{ v: 'meus', label: 'Minha carteira' }, { v: 'equipe', label: 'Equipe' }], estado.escopo,
          (v) => { estado.escopo = v; desenhar(); })
        : null,
      h('button', { class: 'btn btn--primario', onclick: () => navegar('descobrir') }, 'Prospectar usinas')),
    area);
  desenhar();
  return raiz;
}
