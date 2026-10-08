// reassociar.js — "Reassociar distribuidoras": conserta, na base já importada, as usinas cuja
// distribuidora não foi ligada ao cadastro (o motivo mais provável de o botão do Backlog abrir
// Prospecção vazio). É uma ação de gestor; o banco recusa as escritas de quem não é.
//
// Segurança do resultado: o que casa EXATAMENTE (código, nome ou alias do cadastro) é ligado
// sozinho. O que só casa de forma aproximada é mostrado numa lista para o gestor conferir antes
// de aplicar — ligar uma usina à distribuidora errada é pior do que deixá-la sem ligar.

import { h, fmtNum } from './util.js';
import { recasarConcessionarias, aplicarCorrespondencias, agregarEmpresas, todos } from './db.js';
import { confirmar, modal, toast, barraProgresso } from './ui.js';

/** Lista de correspondências aproximadas com caixa de seleção (todas desmarcadas por padrão). */
function conferirSugestoes(sugestoes, nomes) {
  return new Promise((res) => {
    const marcas = sugestoes.map(() => h('input', { type: 'checkbox' }));
    modal({
      titulo: 'Conferir correspondências aproximadas',
      largura: '720px',
      corpo: h('div', { class: 'form' },
        h('p', { class: 'texto' },
          'Estes nomes não batem exatamente com o cadastro, mas se parecem com uma distribuidora. '
          + 'Marque só os que estão certos — nada é ligado sem a sua confirmação.'),
        h('div', { class: 'tabela-wrap' }, h('table', { class: 'tabela tabela--mini' },
          h('thead', {}, h('tr', {}, ['', 'Nome na ANEEL', 'Usinas', 'Ligar a'].map((t) => h('th', {}, t)))),
          h('tbody', {}, sugestoes.map((s, i) => h('tr', {},
            h('td', { class: 'col-sel' }, marcas[i]),
            h('td', { style: 'white-space:normal' }, s.nome),
            h('td', { class: 'ta-dir' }, fmtNum(s.qtd)),
            h('td', {}, `${nomes.get(s.codigo) || s.codigo} (${s.codigo})`))))))),
      acoes: [
        { label: 'Pular', classe: 'btn--fantasma', valor: null },
        {
          label: 'Aplicar as marcadas', classe: 'btn--primario',
          onclick: () => { res(sugestoes.filter((_, i) => marcas[i].checked)); return true; },
        },
      ],
      aoFechar: (v) => { if (v == null) res([]); },
    });
  });
}

/** Confirma, roda com barra de progresso e devolve o resumo (ou null se cancelou). */
export async function reassociarDistribuidoras() {
  const ok = await confirmar('Reassociar distribuidoras',
    'Procura, na base da ANEEL já importada, as usinas cuja distribuidora ainda não está ligada ao '
    + 'cadastro e liga as que casam pelo nome. Depois recalcula as empresas. Em uma base grande pode '
    + 'levar alguns minutos — não feche a aba.', { ok: 'Reassociar' });
  if (!ok) return null;

  const prog = barraProgresso('procurando distribuidoras sem código…');
  const progresso = modal({
    titulo: 'Reassociando distribuidoras', acoes: [],
    corpo: h('div', {}, h('p', { class: 'texto' }, 'Não feche a aba.'), prog.el),
  });
  try {
    const r = await recasarConcessionarias({
      onProgresso: ({ feito, total, nome, codigo }) =>
        prog.atualizar(feito, total, `${feito}/${total} · ${nome}${codigo ? ` → ${codigo}` : ''}`),
    });
    progresso.fechar();

    // correspondências aproximadas: o gestor decide
    let confirmadas = 0;
    if (r.sugestoes.length) {
      const nomes = new Map((await todos('concessionaria')).map((c) => [c.codigo, c.nome]));
      const escolhidas = await conferirSugestoes(r.sugestoes, nomes);
      if (escolhidas.length) confirmadas = await aplicarCorrespondencias(escolhidas);
    }

    const ligadas = r.usinas + confirmadas;
    const empresas = ligadas ? await agregarEmpresas() : 0;
    if (!r.nomes) toast('Nada a reassociar: todas as usinas já têm distribuidora ligada.', 'info', 6000);
    else {
      toast(`${fmtNum(ligadas)} usina(s) ligada(s)`
        + (empresas ? ` · ${fmtNum(empresas)} empresa(s) recalculada(s)` : '')
        + (r.semCorrespondencia.length
          ? ` · ${r.semCorrespondencia.length} nome(s) sem correspondência no cadastro (${r.semCorrespondencia.slice(0, 3).map((x) => x.nome).join('; ')}…)`
          : '') + '.', 'ok', 12000);
    }
    return { ...r, usinas: ligadas };
  } catch (e) {
    progresso.fechar();
    toast(e.message, 'erro', 9000);
    return null;
  }
}
