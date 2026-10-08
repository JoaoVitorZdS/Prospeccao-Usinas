// views/negocios.js — o quadro de Negócios: uma coluna por etapa do funil, arraste o cartão para mudar de etapa.
//
// Sem tabela nova: cada cartão é um lead e a "etapa" é o `status`. Mover um cartão faz o mesmo que mudar o
// status em qualquer outro lugar (perder/descartar pede o motivo e tudo deixa uma anotação no histórico).
// Acessível por teclado: cada cartão tem um menu "Mover para…" além do arrastar.

import { h, fmtPotencia, fmtNum, fmtData, hojeISO, diasEntre, debounce, limpar } from '../util.js';
import { STATUS_MAP, statusLabel } from '../seed.js';
import { buscarLeads, todos, empresasPorCnpj } from '../db.js';
import { cabecalhoPagina, badge, avatar, menuSuspenso, icone, pills, toast, vazio } from '../ui.js';
import { colunasDoQuadro, contarEncerrados, ETAPAS_QUADRO, ENCERRAMENTOS } from '../crm-calculos.js';
import { moverParaEtapa } from '../leads-acoes.js';

const MAX_CARTOES = 60; // por coluna: acima disso o navegador sofre e ninguém lê 500 cartões

export async function viewNegocios(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;
  const estado = { escopo: ehGestor && params.escopo === 'equipe' ? 'equipe' : 'meus', texto: '', conc: params.conc || '' };
  const raiz = h('div', { class: 'pagina' });
  const quadro = h('div', { class: 'quadro' });

  const [perfis, concessionarias] = await Promise.all([todos('profiles'), todos('concessionaria')]);
  const mapaConc = new Map(concessionarias.map((c) => [c.codigo, c.nome]));
  const mapaAgente = new Map(perfis.map((p) => [p.id, p.nome]));
  let leads = [];
  let empresas = new Map();

  async function recarregar() {
    leads = await buscarLeads({});
    empresas = new Map((await empresasPorCnpj(leads.map((l) => l.cnpj))).map((e) => [e.cnpj, e]));
  }
  const potenciaDe = (l) => l.potencia_kwp ?? empresas.get(l.cnpj)?.potencia_total_kw ?? 0;

  const visiveis = () => leads.filter((l) => {
    if (estado.escopo === 'meus' && l.owner_id !== perfil.id) return false;
    if (estado.conc && l.concessionaria_codigo !== estado.conc) return false;
    if (estado.texto) {
      const t = estado.texto.toLowerCase();
      if (!`${l.razao_social || ''} ${l.contato_nome || ''} ${l.cidade || ''}`.toLowerCase().includes(t)) return false;
    }
    return true;
  });

  async function mover(lead, destino) {
    try {
      const n = await moverParaEtapa(lead, destino, { perfil });
      if (n) { await recarregar(); desenhar(); }
    } catch (e) { toast(e.message, 'erro', 7000); }
  }

  function cartao(l) {
    const d = l.proxima_acao_em ? diasEntre(hojeISO(), l.proxima_acao_em) : null;
    const prazo = d == null ? null
      : h('span', { class: `prazo ${d < 0 ? 'atrasado' : d === 0 ? 'hoje' : ''}` },
        d < 0 ? `${-d}d de atraso` : d === 0 ? 'hoje' : fmtData(l.proxima_acao_em));
    const destinos = [...ETAPAS_QUADRO, ...ENCERRAMENTOS].filter((e) => e !== l.status);
    const botaoMover = h('button', { class: 'btn-icone cartao__mais', type: 'button', 'aria-label': `Mover ${l.razao_social || 'lead'} para outra etapa`, title: 'Mover para…' },
      icone('seta', { tamanho: 'peq' }));
    const menu = menuSuspenso(botaoMover, [
      { cabecalho: h('strong', {}, 'Mover para') },
      ...destinos.map((e) => ({ rotulo: statusLabel(e), onclick: () => mover(l, e) })),
      { sep: true },
      { rotulo: 'Abrir o lead', href: `#/lead/${l.id}` },
    ]);
    return h('article', {
      class: 'cartao', draggable: 'true', dataset: { id: l.id },
      ondragstart: (e) => {
        e.dataTransfer.setData('text/plain', l.id);
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.classList.add('is-arrastando');
      },
      ondragend: (e) => e.currentTarget.classList.remove('is-arrastando'),
    },
    h('div', { class: 'cartao__topo' },
      h('a', { class: 'cartao__titulo link-lead', href: `#/lead/${l.id}`, draggable: 'false' }, l.razao_social || l.contato_nome || '(sem nome)'),
      menu),
    h('div', { class: 'cartao__meta' },
      potenciaDe(l) ? h('strong', {}, fmtPotencia(potenciaDe(l))) : null,
      l.concessionaria_codigo || l.concessionaria_raw
        ? h('span', { class: 'texto-fraco' }, mapaConc.get(l.concessionaria_codigo) || l.concessionaria_raw) : null),
    h('div', { class: 'cartao__rodape' },
      prazo || h('span', { class: 'texto-fraco' }, 'sem próxima ação'),
      estado.escopo === 'equipe' ? h('span', { title: mapaAgente.get(l.owner_id) || '' }, avatar(mapaAgente.get(l.owner_id) || '?', { tamanho: 'peq' })) : null));
  }

  /** Zona que aceita cartões soltos. */
  function zona(el, destino) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('is-alvo'); });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('is-alvo'); });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('is-alvo');
      const lead = leads.find((l) => l.id === e.dataTransfer.getData('text/plain'));
      if (lead) mover(lead, destino);
    });
    return el;
  }

  function desenhar() {
    const atuais = visiveis();
    const colunas = colunasDoQuadro(atuais, potenciaDe);
    const enc = contarEncerrados(atuais);
    const total = atuais.filter((l) => !l.deleted_at).length;

    quadro.replaceChildren(
      ...colunas.map((c) => h('section', { class: 'coluna', 'aria-label': `Etapa ${c.label}` },
        h('header', { class: 'coluna__topo' },
          h('div', {}, h('h2', {}, c.label), h('span', { class: 'texto-fraco' }, c.potencia ? fmtPotencia(c.potencia) : 'sem potência')),
          badge(String(c.total), c.cor)),
        zona(h('div', { class: 'coluna__corpo' },
          c.leads.slice(0, MAX_CARTOES).map(cartao),
          c.leads.length > MAX_CARTOES
            ? h('a', { class: 'texto-fraco', href: `#/leads?f=${estado.escopo === 'equipe' ? 'todos' : 'meus'}&status=${c.etapa}` },
              `+${fmtNum(c.leads.length - MAX_CARTOES)} — ver todos na lista`)
            : null,
          c.total === 0 ? h('p', { class: 'coluna__vazia' }, 'Solte um cartão aqui') : null), c.etapa))),
      h('aside', { class: 'coluna coluna--encerrados', 'aria-label': 'Encerrados' },
        h('header', { class: 'coluna__topo' }, h('div', {}, h('h2', {}, 'Encerrados'), h('span', { class: 'texto-fraco' }, 'solte aqui para encerrar'))),
        ...ENCERRAMENTOS.map((e) => zona(h('div', { class: 'encerrado' },
          h('span', {}, STATUS_MAP[e].label),
          h('a', { href: `#/leads?f=${estado.escopo === 'equipe' ? 'todos' : 'meus'}&status=${e}` }, fmtNum(enc[e]))), e))));
    contagem.textContent = `${fmtNum(total)} negócio(s)`;
  }

  const contagem = h('span', { class: 'texto-fraco' });
  const busca = h('input', { type: 'search', class: 'busca', placeholder: 'Buscar por nome ou cidade…', 'aria-label': 'Buscar negócios' });
  busca.addEventListener('input', debounce(() => { estado.texto = busca.value.trim(); desenhar(); }, 200));
  const selConc = h('select', { 'aria-label': 'Filtrar por distribuidora' },
    h('option', { value: '' }, 'Todas as distribuidoras'),
    concessionarias.filter((c) => c.codigo !== 'OUTRA').sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map((c) => h('option', { value: c.codigo, selected: c.codigo === estado.conc }, c.nome)));
  selConc.addEventListener('change', () => { estado.conc = selConc.value; desenhar(); });

  raiz.append(...limpar(
    cabecalhoPagina('Negócios', 'Arraste o cartão para mudar de etapa — ou use o menu do cartão (teclado)',
      ehGestor ? pills([{ v: 'meus', label: 'Minha carteira' }, { v: 'equipe', label: 'Equipe' }], estado.escopo,
        (v) => { estado.escopo = v; desenhar(); }) : null),
    h('div', { class: 'barra-ferramentas' }, busca, selConc, contagem),
    quadro));
  await recarregar();
  if (!leads.length) {
    return h('div', { class: 'pagina' }, cabecalhoPagina('Negócios', 'O quadro do funil'),
      vazio('Sem negócios ainda', 'Importe leads ou prospecte usinas para ver o funil em colunas.',
        h('a', { class: 'btn btn--primario', href: '#/descobrir' }, 'Prospectar usinas')));
  }
  desenhar();
  return raiz;
}
