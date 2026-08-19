// views/fila.js — "Minha fila" (seção 7.B).
// Não é uma planilha compartilhada: é a lista do que fazer agora, ordenada por
// quem venceu primeiro e depois por quem tem menos tentativas.

import {
  h, maskCnpj, maskFone, fmtData, fmtPotencia, hojeISO, debounce, diasEntre, limpar,
} from '../util.js';
import { STATUS_FILA, STATUS, statusLabel } from '../seed.js';
import { buscarLeads, ordenarFila, todos, salvarLead, get } from '../db.js';
import {
  cabecalhoPagina, tabela, badgeStatus, badge, vazio, toast, pills, perguntar, confirmar,
} from '../ui.js';
import { abrirCockpit } from './cockpit.js';
import { contexto, baixarLeads } from '../exporta.js';

const FILTROS = [
  { v: 'hoje', label: 'Hoje', dica: 'Vencendo hoje ou antes' },
  { v: 'atrasados', label: 'Atrasados', dica: 'Próxima ação já venceu' },
  { v: 'novos', label: 'Novos', dica: 'Ainda não abordados' },
  { v: 'aguardando', label: 'Aguardando resposta', dica: 'Abordado, sem retorno' },
  { v: 'meus', label: 'Todos meus' },
  { v: 'todos', label: 'Todos', dica: 'Só gestor' },
];

export async function viewFila(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;
  const estado = {
    filtro: params.f || 'hoje',
    texto: '',
    selecao: new Set(),
  };

  const raiz = h('div', { class: 'pagina' });
  const areaTabela = h('div', {});
  const areaAcoes = h('div', { class: 'barra-selecao', hidden: true });

  const [perfis, concessionarias] = await Promise.all([todos('profiles'), todos('concessionaria')]);
  const mapaConc = new Map(concessionarias.map((c) => [c.codigo, c.nome]));
  const mapaAgente = new Map(perfis.map((p) => [p.id, p.nome]));

  async function carregar() {
    const hoje = hojeISO();
    const base = await buscarLeads({
      owner_id: estado.filtro === 'todos' && ehGestor ? null : perfil.id,
      incluirRemovidos: false,
      texto: estado.texto || undefined,
    });

    let lista = base;
    switch (estado.filtro) {
      case 'hoje':
        lista = base.filter((l) => STATUS_FILA.includes(l.status)
          && l.proxima_acao_em && l.proxima_acao_em <= hoje);
        break;
      case 'atrasados':
        lista = base.filter((l) => STATUS_FILA.includes(l.status)
          && l.proxima_acao_em && l.proxima_acao_em < hoje);
        break;
      case 'novos':
        lista = base.filter((l) => l.status === 'a_abordar');
        break;
      case 'aguardando':
        lista = base.filter((l) => l.status === 'abordado' || l.status === 'em_conversa');
        break;
      case 'meus':
      case 'todos':
      default:
        lista = base;
    }
    return { lista: ordenarFila(lista), base };
  }

  async function contagens() {
    const hoje = hojeISO();
    const meus = await buscarLeads({ owner_id: perfil.id });
    const todosLeads = ehGestor ? await buscarLeads({}) : meus;
    return {
      hoje: meus.filter((l) => STATUS_FILA.includes(l.status) && l.proxima_acao_em && l.proxima_acao_em <= hoje).length,
      atrasados: meus.filter((l) => STATUS_FILA.includes(l.status) && l.proxima_acao_em && l.proxima_acao_em < hoje).length,
      novos: meus.filter((l) => l.status === 'a_abordar').length,
      aguardando: meus.filter((l) => l.status === 'abordado' || l.status === 'em_conversa').length,
      meus: meus.length,
      todos: todosLeads.length,
    };
  }

  const colunas = [
    {
      titulo: 'Razão social / contato',
      render: (l) => h('div', { class: 'cel-principal' },
        h('strong', {}, l.razao_social || l.contato_nome || '(sem nome)'),
        l.contato_nome && l.razao_social ? h('span', {}, l.contato_nome) : null,
        l.opt_out ? badge('opt-out', 'vermelho') : null),
    },
    { titulo: 'CNPJ', largura: '150px', render: (l) => maskCnpj(l.cnpj || '') || '—' },
    { titulo: 'Telefone', largura: '140px', render: (l) => maskFone(l.telefone || '') || '—' },
    { titulo: 'Distribuidora', largura: '150px', render: (l) => mapaConc.get(l.concessionaria_codigo) || l.concessionaria_raw || '—' },
    { titulo: 'Potência', largura: '110px', alinha: 'dir', render: (l) => (l.potencia_kwp == null ? '—' : fmtPotencia(l.potencia_kwp)) },
    { titulo: 'Cidade/UF', largura: '150px', render: (l) => [l.cidade, l.uf].filter(Boolean).join('/') || '—' },
    { titulo: 'Status', largura: '130px', render: (l) => badgeStatus(l.status) },
    { titulo: 'Tent.', largura: '60px', alinha: 'dir', render: (l) => String(l.tentativas || 0) },
    {
      titulo: 'Próxima ação',
      largura: '130px',
      render: (l) => {
        if (!l.proxima_acao_em) return h('span', { class: 'texto-fraco' }, '—');
        const d = diasEntre(hojeISO(), l.proxima_acao_em);
        const cls = d < 0 ? 'atrasado' : d === 0 ? 'hoje' : '';
        return h('span', { class: `prazo ${cls}` }, fmtData(l.proxima_acao_em),
          d < 0 ? h('em', {}, `${-d}d atraso`) : d === 0 ? h('em', {}, 'hoje') : null);
      },
    },
  ];
  if (ehGestor && estado.filtro === 'todos') {
    colunas.push({ titulo: 'Dono', largura: '130px', render: (l) => mapaAgente.get(l.owner_id) || '—' });
  }

  function atualizarBarraSelecao(lista) {
    const n = estado.selecao.size;
    areaAcoes.hidden = n === 0;
    if (!n) return;
    const selecionados = () => lista.filter((l) => estado.selecao.has(l.id));
    areaAcoes.replaceChildren(...limpar(
      h('span', {}, `${n} selecionado(s)`),
      h('button', {
        class: 'btn btn--mini',
        onclick: async () => {
          const alvo = await perguntar('Adiar próxima ação', [{
            campo: 'data', label: 'Nova data', tipo: 'date', valor: hojeISO(), obrigatorio: true,
          }]);
          if (!alvo) return;
          for (const l of selecionados()) await salvarLead({ ...l, proxima_acao_em: alvo.data });
          estado.selecao.clear();
          toast(`${n} lead(s) reagendado(s).`, 'ok');
          desenhar();
        },
      }, 'Reagendar'),
      h('button', {
        class: 'btn btn--mini',
        onclick: async () => {
          const r = await perguntar('Mudar status', [{
            campo: 'status', label: 'Novo status', tipo: 'select', valor: 'a_abordar',
            opcoes: STATUS.map((s) => ({ v: s.v, label: s.label })),
          }]);
          if (!r) return;
          for (const l of selecionados()) await salvarLead({ ...l, status: r.status });
          estado.selecao.clear();
          toast(`${n} lead(s) atualizado(s) para ${statusLabel(r.status)}.`, 'ok');
          desenhar();
        },
      }, 'Mudar status'),
      ehGestor
        ? h('button', {
          class: 'btn btn--mini',
          onclick: async () => {
            const r = await perguntar('Distribuir para', [{
              campo: 'owner_id', label: 'Agente', tipo: 'select', valor: perfil.id,
              opcoes: perfis.filter((p) => p.ativo).map((p) => ({ v: p.id, label: p.nome })),
            }]);
            if (!r) return;
            for (const l of selecionados()) await salvarLead({ ...l, owner_id: r.owner_id });
            estado.selecao.clear();
            toast(`${n} lead(s) redistribuído(s).`, 'ok');
            desenhar();
          },
        }, 'Distribuir')
        : null,
      h('button', {
        class: 'btn btn--mini',
        onclick: async () => {
          const empresas = await todos('empresa');
          baixarLeads(selecionados(), contexto({ perfis, concessionarias, empresas }),
            perfil.nome, 'selecao');
        },
      }, 'Exportar seleção'),
      h('button', {
        class: 'btn btn--mini btn--fantasma',
        onclick: () => { estado.selecao.clear(); desenhar(); },
      }, 'Limpar'),
    ));
  }

  async function desenhar() {
    const { lista } = await carregar();

    areaTabela.replaceChildren(
      lista.length
        ? tabela({
          colunas,
          linhas: lista,
          selecao: { set: estado.selecao, aoMudar: () => atualizarBarraSelecao(lista) },
          aoAbrir: (lead, i) => abrirCockpit({
            lead, fila: lista, indice: i, perfil,
            aoMudar: () => desenhar(),
          }),
          vaziaMsg: 'Nada nesta fila.',
        })
        : vazio(
          estado.filtro === 'hoje' ? 'Fila do dia zerada' : 'Nenhum lead neste filtro',
          estado.filtro === 'hoje'
            ? 'Nada vencendo hoje. Veja "Todos meus" ou puxe leads novos em Descobrir.'
            : 'Ajuste o filtro ou importe leads.',
        ),
    );
    atualizarBarraSelecao(lista);

    const c = await contagens();
    barraFiltros.replaceChildren(pills(
      FILTROS.filter((f) => f.v !== 'todos' || ehGestor).map((f) => ({ ...f, contagem: c[f.v] })),
      estado.filtro,
      (v) => { estado.filtro = v; estado.selecao.clear(); desenhar(); },
    ));
  }

  const busca = h('input', {
    type: 'search', class: 'busca',
    placeholder: 'Buscar por nome, CNPJ, telefone, cidade…',
    'aria-label': 'Buscar leads',
  });
  busca.addEventListener('input', debounce(() => {
    estado.texto = busca.value.trim();
    desenhar();
  }, 220));

  const barraFiltros = h('div', {});

  raiz.append(
    cabecalhoPagina('Minha fila',
      `${perfil.nome} · ordenada por vencimento e depois por número de tentativas`,
      busca),
    barraFiltros,
    areaAcoes,
    areaTabela,
    h('p', { class: 'dica-teclado' },
      h('kbd', {}, 'j'), h('kbd', {}, 'k'), ' navega · ',
      h('kbd', {}, '↵'), ' abre o cockpit · ',
      h('kbd', {}, 'Ctrl+↵'), ' salva e vai para o próximo'),
  );

  await desenhar();
  return raiz;
}
