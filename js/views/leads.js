// views/leads.js — a lista de Leads (antes "Minha fila").
//
// Layout: visões salvas à esquerda (Hoje, Atrasados, Novos…), barra de filtros no topo (chips com
// popover — distribuidora, UF, status, origem, dono, lista, potência, tentativas, datas…) e a
// tabela com seleção e ações em lote. O estado inteiro (visão + busca + filtros) é espelhado na
// URL, então `#/leads?conc=ENEL-SP&status=abordado` abre já filtrado — é o que o Backlog usa.
//
// As regras de filtro ficam em js/leads-filtro.js (puras, com testes) e as ações em
// js/leads-acoes.js (compartilhadas com a gaveta e a página do lead).

import {
  h, maskCnpj, maskFone, fmtData, fmtPotencia, hojeISO, debounce, diasEntre, limpar,
} from '../util.js';
import { STATUS, ORIGENS, UFS, origemLabel } from '../seed.js';
import { buscarLeads, ordenarFila, todos, empresasPorCnpj, listasDeImportacao } from '../db.js';
import {
  cabecalhoPagina, tabela, badgeStatus, badge, vazio, toast, chipFiltro, sincronizarHash, navegar,
} from '../ui.js';
import { abrirCockpit } from './cockpit.js';
import { contexto, baixarLeads } from '../exporta.js';
import {
  VIEWS, CONC_SEM_CODIGO, novosFiltros, lerParams, paraParams, temFiltro, filtrarLeads, contarViews,
  potenciaDe, precisaDeEmpresas,
} from '../leads-filtro.js';
import {
  concluirLeads, mudarStatusLeads, reagendarLeads, distribuirLeads, adicionarALista, removerDeLista,
  devolverALeadsBase, restaurarDevolvidos, excluirDefinitivo, criarLeadManual,
} from '../leads-acoes.js';

const TETO_LEADS = 30000; // mesmo teto de `todos()` — acima disso a lista está truncada

export async function viewLeads(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;
  const inicial = lerParams(params);
  const estado = {
    view: (inicial.view === 'todos' && !ehGestor) ? 'meus' : inicial.view,
    texto: inicial.texto,
    filtros: inicial.filtros,
    selecao: new Set(),
    chipAberto: null,
    leads: [],
    empresas: null,      // Map cnpj → empresa; carregado só quando um filtro precisa
  };

  const raiz = h('div', { class: 'pagina' });
  const areaViews = h('aside', {});
  const areaFiltros = h('div', { class: 'barra-filtros' });
  const areaAcoes = h('div', { class: 'barra-selecao', hidden: true });
  const areaTabela = h('div', {});
  const areaAviso = h('div', {});

  const [perfis, concessionarias, listas] = await Promise.all([
    todos('profiles'), todos('concessionaria'), listasDeImportacao(),
  ]);
  const mapaConc = new Map(concessionarias.map((c) => [c.codigo, c.nome]));
  const mapaAgente = new Map(perfis.map((p) => [p.id, p.nome]));
  const mapaLista = new Map(listas.map((l) => [l.id, l.nome || l.arquivo || 'Lista sem nome']));
  const ctx = () => ({ perfilId: perfil.id, hoje: hojeISO(), empresas: estado.empresas });

  async function recarregar() {
    estado.leads = await buscarLeads({ incluirRemovidos: true });
    estado.empresas = null;
    await garantirEmpresas();
  }

  /** Potência/telefone/e-mail da empresa só são necessários para alguns filtros — busca sob demanda. */
  async function garantirEmpresas() {
    if (estado.empresas || !precisaDeEmpresas(estado.filtros)) return;
    const lista = await empresasPorCnpj(estado.leads.map((l) => l.cnpj));
    estado.empresas = new Map(lista.map((e) => [e.cnpj, e]));
  }

  const visiveis = () => ordenarFila(filtrarLeads(estado.leads, estado, ctx()));
  const selecionados = (lista) => lista.filter((l) => estado.selecao.has(l.id));

  function espelharNaUrl() {
    sincronizarHash('leads', paraParams(estado));
  }

  async function mudar(fn) {
    estado.chipAberto = null; // só os filtros de múltipla escolha pedem para reabrir (ver `fn`)
    fn();
    estado.selecao.clear();
    await garantirEmpresas();
    espelharNaUrl();
    desenhar();
  }

  /* ═══════════ Visões salvas (barra lateral) ═══════════ */

  function desenharViews(contagens) {
    areaViews.replaceChildren(h('nav', { class: 'lateral-views', 'aria-label': 'Visões de leads' },
      h('h3', {}, 'Visões'),
      VIEWS.filter((v) => !v.soGestor || ehGestor).map((v) => h('button', {
        type: 'button', title: v.dica || '',
        class: `lateral-views__item${estado.view === v.v ? ' is-ativa' : ''}`,
        'aria-current': estado.view === v.v ? 'true' : null,
        onclick: () => mudar(() => { estado.view = v.v; }),
      }, v.label, h('em', {}, String(contagens[v.v] ?? 0))))));
  }

  /* ═══════════ Filtros (chips com popover) ═══════════ */

  const opcao = (v, rot, atual) => h('option', { value: v, selected: v === atual }, rot);
  const selectFiltro = (chave, opcoes) => {
    const s = h('select', { 'aria-label': chave }, opcoes.map(([v, rot]) => opcao(v, rot, estado.filtros[chave])));
    s.addEventListener('change', () => mudar(() => { estado.filtros[chave] = s.value; }));
    return s;
  };
  const entrada = (chave, tipo, dica) => {
    const i = h('input', { type: tipo, value: estado.filtros[chave], placeholder: dica || '', 'aria-label': dica || chave });
    i.addEventListener('change', () => mudar(() => { estado.filtros[chave] = i.value.trim(); }));
    return i;
  };
  const faixa = (de, ate, tipo, rotDe, rotAte) => h('div', { class: 'grade-2' },
    h('label', { class: 'campo' }, h('span', {}, rotDe), entrada(de, tipo)),
    h('label', { class: 'campo' }, h('span', {}, rotAte), entrada(ate, tipo)));
  const marcador = (chave, rot, idChip) => {
    const c = h('input', { type: 'checkbox', checked: !!estado.filtros[chave] });
    c.addEventListener('change', () => mudar(() => { estado.filtros[chave] = c.checked; estado.chipAberto = idChip; }));
    return h('label', { class: 'chk' }, c, rot);
  };

  function chip(id, rotulo, resumo, corpo, limparChaves, { reabrir = false } = {}) {
    return chipFiltro({
      rotulo, resumo, corpo,
      aberto: reabrir && estado.chipAberto === id,
      aoLimpar: () => mudar(() => {
        for (const k of limparChaves) estado.filtros[k] = Array.isArray(estado.filtros[k]) ? [] : (typeof estado.filtros[k] === 'boolean' ? false : '');
      }),
    });
  }

  function desenharFiltros() {
    const f = estado.filtros;
    const concsOrdenadas = concessionarias.filter((c) => c.codigo !== 'OUTRA')
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const nomeConc = f.conc === CONC_SEM_CODIGO ? 'Não reconhecida' : (mapaConc.get(f.conc) || f.conc);
    const faixaTxt = (a, b, un = '') => [a && `de ${a}${un}`, b && `até ${b}${un}`].filter(Boolean).join(' ');

    const statusCorpo = h('div', { class: 'form' }, STATUS.map((s) => {
      const c = h('input', { type: 'checkbox', checked: f.status.includes(s.v) });
      c.addEventListener('change', () => mudar(() => {
        f.status = c.checked ? [...new Set([...f.status, s.v])] : f.status.filter((x) => x !== s.v);
        estado.chipAberto = 'status';
      }));
      return h('label', { class: 'chk' }, c, s.label);
    }));

    const nContato = [f.comTel, f.comEmail, f.optOut].filter(Boolean).length;
    const nDatas = [f.paDe, f.paAte, f.ucDe, f.ucAte, f.crDe, f.crAte].filter(Boolean).length;

    areaFiltros.replaceChildren(...limpar(
      chip('conc', 'Distribuidora', f.conc ? nomeConc : '',
        selectFiltro('conc', [['', 'Todas'], ...concsOrdenadas.map((c) => [c.codigo, `${c.nome}${c.uf ? ` (${c.uf})` : ''}`]),
          [CONC_SEM_CODIGO, 'Não reconhecida (sem código)']]), ['conc']),
      chip('uf', 'UF', f.uf, selectFiltro('uf', [['', 'Todas'], ...UFS.map((u) => [u, u])]), ['uf']),
      chip('cidade', 'Cidade', f.cidade, entrada('cidade', 'text', 'Parte do nome da cidade'), ['cidade']),
      chip('status', 'Status', f.status.length ? `${f.status.length} selecionado(s)` : '', statusCorpo, ['status'], { reabrir: true }),
      chip('origem', 'Origem', f.origem ? origemLabel(f.origem) : '',
        selectFiltro('origem', [['', 'Todas'], ...ORIGENS.map((o) => [o.v, o.label])]), ['origem']),
      chip('tipo', 'Tipo', f.tipo === 'usina_geradora' ? 'Usina' : (f.tipo ? 'Intermediador' : ''),
        selectFiltro('tipo', [['', 'Todos'], ['usina_geradora', 'Usina geradora'], ['intermediador', 'Intermediador']]), ['tipo']),
      ehGestor
        ? chip('dono', 'Dono', f.dono ? (mapaAgente.get(f.dono) || '—') : '',
          selectFiltro('dono', [['', 'Todos'], ...perfis.filter((p) => p.ativo).map((p) => [p.id, p.nome])]), ['dono'])
        : null,
      chip('lista', 'Lista', f.lista === '__sem' ? 'Sem lista' : (f.lista ? (mapaLista.get(f.lista) || '—') : ''),
        selectFiltro('lista', [['', 'Todas'], ['__sem', 'Sem lista'], ...listas.map((l) => [l.id, mapaLista.get(l.id)])]), ['lista']),
      chip('potencia', 'Potência (kW)', faixaTxt(f.potMin, f.potMax),
        faixa('potMin', 'potMax', 'number', 'Mínima', 'Máxima'), ['potMin', 'potMax']),
      chip('tentativas', 'Tentativas', faixaTxt(f.tentMin, f.tentMax),
        faixa('tentMin', 'tentMax', 'number', 'Mínimo', 'Máximo'), ['tentMin', 'tentMax']),
      chip('contato', 'Contato', nContato ? `${nContato} critério(s)` : '',
        h('div', { class: 'form' },
          marcador('comTel', 'Tem telefone', 'contato'), marcador('comEmail', 'Tem e-mail', 'contato'),
          marcador('optOut', 'Só opt-out', 'contato')), ['comTel', 'comEmail', 'optOut'], { reabrir: true }),
      chip('datas', 'Datas', nDatas ? `${nDatas} critério(s)` : '',
        h('div', { class: 'form' },
          h('strong', {}, 'Próxima ação'), faixa('paDe', 'paAte', 'date', 'De', 'Até'),
          h('strong', {}, 'Último contato'), faixa('ucDe', 'ucAte', 'date', 'De', 'Até'),
          h('strong', {}, 'Criado em'), faixa('crDe', 'crAte', 'date', 'De', 'Até')),
        ['paDe', 'paAte', 'ucDe', 'ucAte', 'crDe', 'crAte']),
      temFiltro(f)
        ? h('button', { class: 'btn btn--mini btn--fantasma', type: 'button', onclick: () => mudar(() => { estado.filtros = novosFiltros(); }) }, 'Limpar filtros')
        : null));
  }

  /* ═══════════ Tabela ═══════════ */

  function colunas() {
    const emp = estado.empresas;
    const cols = [
      {
        titulo: 'Razão social / contato',
        render: (l) => h('div', { class: 'cel-principal' },
          h('strong', {}, h('a', { class: 'link-lead', href: `#/lead/${l.id}`, title: 'Abrir a página do lead' },
            l.razao_social || l.contato_nome || '(sem nome)')),
          l.contato_nome && l.razao_social ? h('span', {}, l.contato_nome) : null,
          l.opt_out ? badge('opt-out', 'vermelho') : null),
      },
      { titulo: 'CNPJ', largura: '150px', render: (l) => maskCnpj(l.cnpj || '') || '—' },
      { titulo: 'Telefone', largura: '140px', render: (l) => maskFone(l.telefone || '') || '—' },
      { titulo: 'Distribuidora', largura: '150px', render: (l) => mapaConc.get(l.concessionaria_codigo) || l.concessionaria_raw || '—' },
      {
        titulo: 'Potência', largura: '110px', alinha: 'dir',
        render: (l) => { const p = potenciaDe(l, emp); return p == null ? '—' : fmtPotencia(p); },
      },
      { titulo: 'Cidade/UF', largura: '150px', render: (l) => [l.cidade, l.uf].filter(Boolean).join('/') || '—' },
      { titulo: 'Status', largura: '130px', render: (l) => badgeStatus(l.status) },
      { titulo: 'Origem', largura: '120px', render: (l) => origemLabel(l.origem) },
      { titulo: 'Lista', largura: '140px', render: (l) => (l.import_lote_id ? (mapaLista.get(l.import_lote_id) || '—') : '—') },
      { titulo: 'Tent.', largura: '60px', alinha: 'dir', render: (l) => String(l.tentativas || 0) },
      {
        titulo: estado.view === 'devolvidos' ? 'Devolvido em' : 'Próxima ação',
        largura: '130px',
        render: (l) => {
          if (estado.view === 'devolvidos') {
            return h('div', { class: 'cel-principal' }, fmtData((l.devolvido_em || l.deleted_at || '').slice(0, 10)),
              l.devolvido_motivo ? h('span', {}, l.devolvido_motivo) : null);
          }
          if (!l.proxima_acao_em) return h('span', { class: 'texto-fraco' }, '—');
          const d = diasEntre(hojeISO(), l.proxima_acao_em);
          const cls = d < 0 ? 'atrasado' : d === 0 ? 'hoje' : '';
          return h('span', { class: `prazo ${cls}` }, fmtData(l.proxima_acao_em),
            d < 0 ? h('em', {}, `${-d}d atraso`) : d === 0 ? h('em', {}, 'hoje') : null);
        },
      },
    ];
    if (ehGestor) cols.push({ titulo: 'Dono', largura: '130px', render: (l) => mapaAgente.get(l.owner_id) || '—' });
    return cols;
  }

  /* ═══════════ Ações em lote ═══════════ */

  async function depoisDaAcao(n) {
    estado.selecao.clear();
    if (n) { await recarregar(); }
    desenhar();
  }

  function desenharAcoes(lista) {
    const n = estado.selecao.size;
    areaAcoes.hidden = n === 0;
    if (!n) return;
    const sel = () => selecionados(lista);
    const btn = (rot, fn, extra = '') => h('button', { class: `btn btn--mini${extra}`, type: 'button', onclick: async () => {
      try { await depoisDaAcao(await fn()); } catch (e) { toast(e.message, 'erro', 7000); }
    } }, rot);

    if (estado.view === 'devolvidos') {
      areaAcoes.replaceChildren(...limpar(
        h('span', {}, `${n} selecionado(s)`),
        btn('Restaurar à carteira', () => restaurarDevolvidos(sel())),
        ehGestor ? btn('Excluir definitivamente', () => excluirDefinitivo(sel()), ' btn--perigo-fraco') : null,
        h('button', { class: 'btn btn--mini btn--fantasma', onclick: () => { estado.selecao.clear(); desenhar(); } }, 'Limpar')));
      return;
    }
    areaAcoes.replaceChildren(...limpar(
      h('span', {}, `${n} selecionado(s)`),
      btn('Reagendar', () => reagendarLeads(sel())),
      btn('Mudar status', () => mudarStatusLeads(sel(), { perfil })),
      btn('Concluir', () => concluirLeads(sel(), { perfil })),
      ehGestor ? btn('Distribuir', () => distribuirLeads(sel(), perfis)) : null,
      btn('Adicionar à lista', () => adicionarALista(sel(), { perfil })),
      btn('Remover da lista', () => removerDeLista(sel().filter((l) => l.import_lote_id))),
      btn('Devolver à base', () => devolverALeadsBase(sel())),
      h('button', {
        class: 'btn btn--mini', type: 'button',
        onclick: async () => {
          const alvo = sel();
          const empresas = await empresasPorCnpj(alvo.map((l) => l.cnpj));
          baixarLeads(alvo, contexto({ perfis, concessionarias, empresas }), perfil.nome, 'selecao');
        },
      }, 'Exportar seleção'),
      h('button', { class: 'btn btn--mini btn--fantasma', onclick: () => { estado.selecao.clear(); desenhar(); } }, 'Limpar')));
  }

  /* ═══════════ Desenho ═══════════ */

  function mensagemVazia() {
    if (temFiltro(estado.filtros) || estado.texto) {
      return vazio('Nenhum lead com esses filtros', 'Afrouxe os filtros ou troque de visão.',
        h('button', { class: 'btn', onclick: () => mudar(() => { estado.filtros = novosFiltros(); estado.texto = ''; busca.value = ''; }) }, 'Limpar filtros e busca'));
    }
    if (estado.view === 'hoje') return vazio('Fila do dia zerada', 'Nada vencendo hoje. Veja "Todos os meus" ou puxe leads novos em Prospecção.');
    if (estado.view === 'devolvidos') return vazio('Nada devolvido à base', 'Leads que você devolver aparecem aqui, para restaurar.');
    return vazio('Nenhum lead nesta visão', 'Importe uma planilha, prospecte usinas ou crie um lead.');
  }

  function desenhar() {
    const lista = visiveis();
    const contagens = contarViews(estado.leads, ctx());
    desenharViews(contagens);
    desenharFiltros();

    areaAviso.replaceChildren(...limpar(
      estado.leads.length >= TETO_LEADS
        ? h('p', { class: 'aviso' }, `A lista mostra os primeiros ${TETO_LEADS.toLocaleString('pt-BR')} leads — use os filtros para chegar nos demais.`)
        : null));

    areaTabela.replaceChildren(lista.length
      ? tabela({
        colunas: colunas(),
        linhas: lista,
        selecao: { set: estado.selecao, aoMudar: () => desenharAcoes(lista) },
        aoAbrir: (lead, i) => abrirCockpit({
          lead, fila: lista, indice: i, perfil,
          aoMudar: () => recarregar().then(desenhar),
        }),
        vaziaMsg: 'Nada nesta visão.',
      })
      : mensagemVazia());
    desenharAcoes(lista);
    rotuloTotal.textContent = `${lista.length.toLocaleString('pt-BR')} de ${estado.leads.filter((l) => (estado.view === 'devolvidos') === !!l.deleted_at).length.toLocaleString('pt-BR')} lead(s)`;
  }

  /* ═══════════ Cabeçalho ═══════════ */

  const busca = h('input', {
    type: 'search', class: 'busca', value: estado.texto,
    placeholder: 'Buscar por nome, CNPJ, telefone, cidade…', 'aria-label': 'Buscar leads',
  });
  busca.addEventListener('input', debounce(() => mudar(() => { estado.texto = busca.value.trim(); }), 220));

  const rotuloTotal = h('span', { class: 'texto-fraco' });

  const botaoNovo = h('button', {
    class: 'btn btn--primario', type: 'button',
    onclick: async () => {
      try {
        const novo = await criarLeadManual({ perfil, ehGestor, perfis });
        if (novo) navegar(`lead/${novo.id}`);
      } catch (e) { toast(e.message, 'erro', 7000); }
    },
  }, '+ Novo lead');

  const botaoExportar = h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const lista = visiveis();
      if (!lista.length) return toast('Nada para exportar nesta visão.', 'aviso');
      const empresas = await empresasPorCnpj(lista.map((l) => l.cnpj));
      baixarLeads(lista, contexto({ perfis, concessionarias, empresas }), perfil.nome, 'leads');
    },
  }, 'Exportar lista');

  raiz.append(
    cabecalhoPagina('Leads', `${perfil.nome} · ordenada por vencimento e depois por número de tentativas`, botaoExportar, botaoNovo),
    h('div', { class: 'layout-lateral' },
      areaViews,
      h('div', { class: 'pagina' },
        h('div', { class: 'linha-botoes' }, busca, rotuloTotal),
        areaFiltros, areaAviso, areaAcoes, areaTabela,
        h('p', { class: 'dica-teclado' },
          h('kbd', {}, 'j'), h('kbd', {}, 'k'), ' navega · ',
          h('kbd', {}, '↵'), ' abre a gaveta de abordagem · clique no nome abre a página do lead · ',
          h('kbd', {}, 'Ctrl+↵'), ' salva e vai para o próximo'))));

  await recarregar();
  desenhar();
  espelharNaUrl();
  return raiz;
}

/** Compat: o nome antigo continua exportado para quem ainda importa `viewFila`. */
export const viewFila = viewLeads;
