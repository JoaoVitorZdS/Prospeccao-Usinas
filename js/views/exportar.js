// views/exportar.js — a entrega ao superior (seção 7.F).
// A regra é não mudar o hábito de quem recebe: as 10 colunas de sempre, na ordem
// de sempre, com máscara em CNPJ/telefone/CEP para o Excel não estragar o arquivo.

import { h, fmtNum, hojeISO, addDias, fmtData, baixar, nomeArquivo, dataLocal } from '../util.js';
import { STATUS, STATUS_FILA, statusLabel, COLUNAS_PLANILHA, COLUNAS_EXTRAS } from '../seed.js';
import { todos, buscarLeads } from '../db.js';
import { cabecalhoPagina, card, kpi, toast, vazio, badge, pills } from '../ui.js';
import { contexto, csvLeads, csvInteracoes, abrirRelatorio } from '../exporta.js';

const PRONTOS = ['qualificado', 'proposta', 'ganho'];

export async function viewExportar(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;

  const [perfis, concessionarias, empresas, interacoes] = await Promise.all([
    todos('profiles'), todos('concessionaria'), todos('empresa'), todos('interacao'),
  ]);
  const ctx = contexto({ perfis, concessionarias, empresas });

  const filtro = {
    recorte: 'prontos',       // prontos | todos | meus | periodo
    owner: ehGestor ? '' : perfil.id,
    status: new Set(PRONTOS),
    de: addDias(hojeISO(), -30),
    ate: hojeISO(),
    usarPeriodo: false,
  };

  const raiz = h('div', { class: 'pagina' });
  const areaResumo = h('div', {});
  const areaFiltros = h('div', {});

  async function selecionar() {
    let lista = await buscarLeads({ owner_id: filtro.owner || null });
    if (filtro.status.size) lista = lista.filter((l) => filtro.status.has(l.status));
    if (filtro.usarPeriodo) {
      lista = lista.filter((l) => {
        const d = l.ultimo_contato_em || dataLocal(l.updated_at);
        return d && d >= filtro.de && d <= filtro.ate;
      });
    }
    return lista.sort((a, b) =>
      String(a.razao_social || '').localeCompare(String(b.razao_social || ''), 'pt-BR'));
  }

  const RECORTES = [
    { v: 'prontos', label: 'Prontos para contrato', dica: 'qualificado, proposta e ganho' },
    { v: 'aberto', label: 'Em aberto', dica: 'tudo que ainda está na fila' },
    { v: 'todos', label: 'Tudo' },
    { v: 'custom', label: 'Escolher status' },
  ];

  function aplicarRecorte(v) {
    filtro.recorte = v;
    if (v === 'prontos') filtro.status = new Set(PRONTOS);
    else if (v === 'aberto') filtro.status = new Set(STATUS_FILA);
    else if (v === 'todos') filtro.status = new Set(STATUS.map((s) => s.v));
    desenhar();
  }

  function desenharFiltros() {
    const selStatus = filtro.recorte === 'custom'
      ? h('div', { class: 'filtros filtros--chk' }, STATUS.map((s) => {
        const i = h('input', { type: 'checkbox', checked: filtro.status.has(s.v) });
        i.addEventListener('change', () => {
          if (i.checked) filtro.status.add(s.v); else filtro.status.delete(s.v);
          desenhar();
        });
        return h('label', { class: 'chk' }, i, s.label);
      }))
      : null;

    const selOwner = ehGestor
      ? (() => {
        const s = h('select', {},
          h('option', { value: '' }, 'Todos os agentes'),
          perfis.filter((p) => p.ativo).map((p) =>
            h('option', { value: p.id, selected: p.id === filtro.owner }, p.nome)));
        s.addEventListener('change', () => { filtro.owner = s.value; desenhar(); });
        return h('label', { class: 'campo campo--linha' }, h('span', { class: 'rot-mini' }, 'Agente'), s);
      })()
      : null;

    const chkPeriodo = (() => {
      const i = h('input', { type: 'checkbox', checked: filtro.usarPeriodo });
      i.addEventListener('change', () => { filtro.usarPeriodo = i.checked; desenhar(); });
      return h('label', { class: 'chk' }, i, 'Filtrar por período do último contato');
    })();

    const de = h('input', { type: 'date', value: filtro.de, disabled: !filtro.usarPeriodo });
    de.addEventListener('change', () => { filtro.de = de.value; desenhar(); });
    const ate = h('input', { type: 'date', value: filtro.ate, disabled: !filtro.usarPeriodo });
    ate.addEventListener('change', () => { filtro.ate = ate.value; desenhar(); });

    areaFiltros.replaceChildren(card(null,
      pills(RECORTES, filtro.recorte, aplicarRecorte),
      selStatus,
      h('div', { class: 'filtros' },
        selOwner,
        chkPeriodo,
        h('label', { class: 'campo campo--linha' }, h('span', { class: 'rot-mini' }, 'de'), de),
        h('label', { class: 'campo campo--linha' }, h('span', { class: 'rot-mini' }, 'até'), ate))));
  }

  async function desenhar() {
    desenharFiltros();
    const lista = await selecionar();
    const potencia = lista.reduce((s, l) =>
      s + (l.potencia_kwp ?? ctx.empresa.get(l.cnpj)?.potencia_total_kw ?? 0), 0);
    const interDoRecorte = (() => {
      const ids = new Set(lista.map((l) => l.id));
      return interacoes.filter((i) => ids.has(i.lead_id));
    })();

    areaResumo.replaceChildren(
      h('div', { class: 'kpis kpis--fina' },
        kpi('Leads no recorte', fmtNum(lista.length)),
        kpi('Potência somada', `${fmtNum(potencia, 2)} kW`),
        kpi('Toques no recorte', fmtNum(interDoRecorte.length))),

      card('CSV para o superior',
        h('p', { class: 'texto-fraco' },
          'BOM UTF-8, separador ";", CRLF — abre no Excel-pt com acento certo. '
          + 'As 10 primeiras colunas são as da planilha atual, na mesma ordem; as demais vêm depois.'),
        h('div', { class: 'colunas-preview' },
          COLUNAS_PLANILHA.map((c, i) => badge(`${i + 1}. ${c}`, 'azul')),
          COLUNAS_EXTRAS.map((c) => badge(c, 'cinza'))),
        h('div', { class: 'linha-botoes' },
          h('button', {
            class: 'btn btn--primario',
            disabled: !lista.length,
            onclick: () => {
              baixar(csvLeads(lista, ctx), nomeArquivo('leads', perfil.nome, 'csv'));
              toast(`${lista.length} lead(s) exportado(s).`, 'ok');
            },
          }, `Baixar CSV (${fmtNum(lista.length)})`),
          h('button', {
            class: 'btn',
            disabled: !interDoRecorte.length,
            onclick: () => {
              baixar(csvInteracoes(interDoRecorte, lista, ctx), nomeArquivo('interacoes', perfil.nome, 'csv'));
              toast(`${interDoRecorte.length} interação(ões) exportada(s).`, 'ok');
            },
          }, 'Baixar CSV de interações'))),

      card('Relatório para impressão / PDF',
        h('p', { class: 'texto-fraco' },
          'Um bloco por lead, sem quebrar no meio da página, com linha de assinatura. '
          + 'Abre em nova aba e chama a impressão — em "Destino", escolha "Salvar como PDF".'),
        h('div', { class: 'linha-botoes' },
          h('button', {
            class: 'btn btn--primario',
            disabled: !lista.length,
            onclick: () => {
              const ok = abrirRelatorio(lista, ctx, {
                titulo: filtro.recorte === 'prontos' ? 'Leads prontos para contrato' : 'Relatório de leads',
                autor: perfil.nome,
              });
              if (!ok) toast('Popup bloqueado — baixei o HTML. Abra e use Ctrl+P.', 'aviso', 6000);
            },
          }, 'Gerar relatório'))),

      h('p', { class: 'aviso' },
        'Export é dado pessoal (LGPD). O arquivo já sai nomeado com a data e o agente. '
        + 'Não subir em Drive público nem colar em chat.'),
    );
  }

  raiz.append(
    cabecalhoPagina('Exportar / Entregar',
      'O superior continua recebendo a mesma planilha — só que gerada em um clique'),
    areaFiltros,
    areaResumo);
  await desenhar();
  return raiz;
}
