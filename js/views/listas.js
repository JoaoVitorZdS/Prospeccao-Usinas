// views/listas.js — as listas de importação: cada importação (planilha, colagem, ANEEL) e cada
// lista criada à mão vira uma lista com nome, e os leads dela ficam ligados a ela. Aqui se cria,
// renomeia, abre (a lista de Leads já filtrada) e exclui — com a opção de devolver os leads à base.

import { h, fmtData, fmtDataHora, fmtNum } from '../util.js';
import {
  listasDeImportacao, criarLista, salvarLista, excluirLista, buscarLeads, todos,
} from '../db.js';
import {
  cabecalhoPagina, card, kpi, tabela, badge, vazio, toast, modal, perguntar, navegar,
} from '../ui.js';

const ROTULO_TIPO = {
  manual: ['Criada à mão', 'roxo'], planilha: ['Planilha', 'azul'], colagem: ['Colagem', 'azul'],
  extensao: ['Extensão', 'azul'], aneel: ['Base ANEEL', 'cinza'],
};

const nomeDaLista = (l) => l.nome || l.arquivo || `Importação de ${fmtData((l.created_at || '').slice(0, 10))}`;

export async function viewListas(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;
  const [listas, leads, perfis] = await Promise.all([listasDeImportacao(), buscarLeads({}), todos('profiles')]);
  const nomeAgente = new Map(perfis.map((p) => [p.id, p.nome]));

  const porLista = new Map();
  for (const l of leads) if (l.import_lote_id) porLista.set(l.import_lote_id, (porLista.get(l.import_lote_id) || 0) + 1);

  const ordenadas = listas.slice().sort((a, b) => ((a.created_at || '') < (b.created_at || '') ? 1 : -1));
  const comLeads = ordenadas.filter((l) => l.tipo !== 'aneel');
  const importacoesAneel = ordenadas.filter((l) => l.tipo === 'aneel');

  async function nova() {
    const r = await perguntar('Nova lista', [
      { campo: 'nome', label: 'Nome', obrigatorio: true, dica: 'Ex.: Cooperativas do Sul, Feira de energia 2026' },
      { campo: 'descricao', label: 'Descrição (opcional)', tipo: 'textarea' },
    ], { ok: 'Criar lista' });
    if (!r) return;
    try {
      await criarLista({ nome: r.nome, descricao: r.descricao, agente_id: perfil.id });
      toast('Lista criada. Adicione leads a ela pela tela de Leads.', 'ok', 5000);
      navegar('listas');
    } catch (e) { toast(e.message, 'erro', 6000); }
  }

  async function renomear(lista) {
    const r = await perguntar('Editar lista', [
      { campo: 'nome', label: 'Nome', valor: nomeDaLista(lista), obrigatorio: true },
      { campo: 'descricao', label: 'Descrição', tipo: 'textarea', valor: lista.descricao || '' },
    ]);
    if (!r) return;
    try {
      await salvarLista({ ...lista, nome: r.nome, descricao: r.descricao || null });
      toast('Lista atualizada.', 'ok');
      navegar('listas');
    } catch (e) { toast(e.message, 'erro', 6000); }
  }

  async function excluir(lista) {
    const n = porLista.get(lista.id) || 0;
    const devolver = h('input', { type: 'checkbox' });
    const ok = await new Promise((res) => {
      modal({
        titulo: `Excluir "${nomeDaLista(lista)}"?`,
        largura: '480px',
        corpo: h('div', { class: 'form' },
          h('p', { class: 'texto' }, n
            ? `Esta lista tem ${fmtNum(n)} lead(s). Por padrão eles continuam na carteira, só saem da lista.`
            : 'A lista está vazia.'),
          n ? h('label', { class: 'chk' }, devolver, `Devolver os ${fmtNum(n)} lead(s) à base também`) : null),
        acoes: [
          { label: 'Cancelar', classe: 'btn--fantasma', valor: false },
          { label: 'Excluir lista', classe: 'btn--perigo', valor: true },
        ],
        aoFechar: (v) => res(v === true),
      });
    });
    if (!ok) return;
    try {
      const movidos = await excluirLista(lista.id, { devolverLeads: devolver.checked });
      toast(`Lista excluída${movidos ? ` · ${fmtNum(movidos)} lead(s) ${devolver.checked ? 'devolvidos à base' : 'mantidos na carteira'}` : ''}.`, 'ok', 6000);
      navegar('listas');
    } catch (e) { toast(e.message, 'erro', 7000); }
  }

  const colunas = [
    {
      titulo: 'Lista',
      render: (l) => h('div', { class: 'cel-principal' },
        h('strong', {}, l.tipo === 'aneel'
          ? nomeDaLista(l)
          : h('a', { class: 'link-lead', href: `#/leads?lista=${l.id}` }, nomeDaLista(l))),
        l.descricao ? h('span', {}, l.descricao) : (l.arquivo && l.nome ? h('span', {}, l.arquivo) : null)),
    },
    { titulo: 'Origem', largura: '130px', render: (l) => badge(...(ROTULO_TIPO[l.tipo] || [l.tipo, 'cinza'])) },
    { titulo: 'Leads', largura: '80px', alinha: 'dir', render: (l) => fmtNum(porLista.get(l.id) || 0) },
    { titulo: 'Importados', largura: '95px', alinha: 'dir', render: (l) => (l.total ? `${fmtNum(l.criados)} / ${fmtNum(l.total)}` : '—') },
    { titulo: 'Criada por', largura: '130px', render: (l) => nomeAgente.get(l.agente_id) || '—' },
    { titulo: 'Criada em', largura: '140px', render: (l) => fmtDataHora(l.created_at) },
    {
      titulo: '', largura: '230px',
      render: (l) => h('div', { class: 'linha-botoes linha-botoes--fina' },
        l.tipo !== 'aneel'
          ? h('a', { class: 'btn btn--mini', href: `#/leads?lista=${l.id}` }, 'Abrir leads')
          : null,
        l.tipo !== 'aneel' ? h('button', { class: 'btn btn--mini', onclick: () => renomear(l) }, 'Editar') : null,
        (l.agente_id === perfil.id || ehGestor)
          ? h('button', { class: 'btn btn--mini btn--perigo-fraco', onclick: () => excluir(l) }, 'Excluir')
          : null),
    },
  ];

  const raiz = h('div', { class: 'pagina' });
  raiz.append(
    cabecalhoPagina('Listas', 'Agrupe leads por importação ou por campanha — e trabalhe cada lista pela tela de Leads',
      h('button', { class: 'btn btn--primario', onclick: nova }, '+ Nova lista')),
    h('div', { class: 'kpis kpis--fina' },
      kpi('Listas', fmtNum(comLeads.length)),
      kpi('Leads em alguma lista', fmtNum([...porLista.values()].reduce((s, n) => s + n, 0))),
      kpi('Leads sem lista', fmtNum(leads.filter((l) => !l.import_lote_id && !l.deleted_at).length))),
    comLeads.length
      ? tabela({ colunas, linhas: comLeads, aoAbrir: (l) => navegar('leads', { lista: l.id, f: 'meus' }), vaziaMsg: '' })
      : vazio('Nenhuma lista ainda',
        'Toda importação de planilha cria uma lista automaticamente. Você também pode criar uma e adicionar leads a ela.',
        h('button', { class: 'btn btn--primario', onclick: nova }, '+ Nova lista')),
    importacoesAneel.length
      ? card('Importações da base ANEEL',
        h('p', { class: 'texto-fraco' }, 'Registro das cargas de usinas da ANEEL (não têm leads — alimentam a Prospecção).'),
        tabela({ colunas: colunas.slice(0, 6).concat(colunas.slice(6)), linhas: importacoesAneel, aoAbrir: () => {}, vaziaMsg: '' }))
      : null);
  return raiz;
}
