// views/descobrir.js — o funil novo (seção 7.A).
//
// Explorador sobre `usina_aneel` agregado em `empresa`. É aqui que a lista deixa
// de ser "empresa qualquer, descubro depois se tem usina" e passa a ser
// "empresas que comprovadamente têm usina, com distribuidora, potência e CEP".
//
// A ação final — "Criar N leads para mim" — respeita duas coisas sem perguntar:
// quem está na supressão e quem já tem lead ativo.

import {
  h, maskCnpj, maskFone, fmtNum, fmtPotencia, fmtData, debounce, hojeISO, limpar,
} from '../util.js';
import { UFS, TIPOS_GERACAO } from '../seed.js';
import {
  todos, buscarTop, buscarLeads, criarLead, carregarSupressao, contar, agregarEmpresas,
} from '../db.js';
import {
  cabecalhoPagina, tabela, vazio, toast, kpi, badge, perguntar, confirmar, barraProgresso, card,
} from '../ui.js';
import { filaEnriquecimento, processarFila, taxaPreenchimento } from '../enriquecer.js';
import { navegar } from '../ui.js';

export async function viewDescobrir(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;

  const totalUsinas = await contar('usina_aneel');
  const raiz = h('div', { class: 'pagina' });

  if (!totalUsinas) {
    raiz.append(
      cabecalhoPagina('Descobrir', 'Explorador sobre a base da ANEEL'),
      vazio(
        'Nenhuma usina carregada ainda',
        'Vá em Importar → Base da ANEEL: baixe pelo link direto e arraste o arquivo (o ZIP da GD '
        + 'é lido em streaming, sem travar a aba) ou clique em "Testar com amostra real" pra ver '
        + 'o fluxo funcionando sem baixar nada.',
        h('div', { class: 'linha-botoes' },
          h('button', { class: 'btn btn--primario', onclick: () => navegar('importar', { modo: 'aneel' }) },
            'Ir para Importar'),
          h('a', {
            class: 'btn btn--fantasma', target: '_blank', rel: 'noopener',
            href: 'https://dadosabertos.aneel.gov.br/dataset/relacao-de-empreendimentos-de-geracao-distribuida',
          }, 'Abrir o dataset na ANEEL')),
      ),
    );
    return raiz;
  }

  // Nunca mais que isto NUMA SÓ REQUISIÇÃO, não importa o tamanho da base —
  // é a diferença entre 1 chamada ao Supabase e ~360 (base de 360 mil linhas
  // paginando de 1000 em 1000). UF e distribuidora reconsultam o servidor
  // quando mudam (abaixo); os outros filtros continuam client-side sobre o
  // que já foi carregado — ver aviso na tela quando o corte está truncado.
  const TETO_CARGA = 3000;

  const concessionarias = await todos('concessionaria');
  const mapaConc = new Map(concessionarias.map((c) => [c.codigo, c.nome]));
  const totalEmpresas = await contar('empresa');
  const leadsAtivos = new Set((await buscarLeads({})).map((l) => l.cnpj).filter(Boolean));
  const supressao = await carregarSupressao();

  const filtro = {
    uf: '', conc: '', geracao: '', porte: '', modalidade: '', fase: '',
    potMin: '', potMax: '', conexaoDe: '', conexaoAte: '',
    comTelefone: false, comEmail: false, semLead: true, texto: '',
  };
  const selecao = new Set();

  let empresas = [];
  let truncado = false;
  let totalFiltrado = totalEmpresas;

  /* UF/distribuidora vêm de fonte COMPLETA (lista fixa / tabela de referência),
     não do que foi carregado — senão sumiriam opções que só existem fora do
     recorte atual dos 3 mil. Os outros filtros continuam derivados do
     carregado: são refinamento fino, não a ferramenta de "achar o resto". */
  const opcUF = UFS.slice();
  const opcConc = concessionarias.map((c) => c.codigo).sort();
  const opcGer = Object.keys(TIPOS_GERACAO);
  let opcPorte = [], opcModal = [], opcFase = [];

  const opcoesDe = (extrair) => {
    const s = new Set();
    for (const e of empresas) for (const v of [].concat(extrair(e) || [])) if (v) s.add(v);
    return [...s].sort();
  };

  /**
   * Só isto fala com o Supabase pra buscar `empresa` — sempre ordenado, sempre
   * limitado. `truncado` é calculado a partir do que REALMENTE voltou, não do
   * que foi pedido: o Supabase tem um teto próprio de linhas por requisição
   * (`db-max-rows`, tipicamente 1000) que já vale mesmo pedindo `limite` maior
   * — confirmado testando contra o projeto real. Assumir que `.limit(N)`
   * sempre entrega N seria mostrar "sem corte" quando na verdade cortou.
   */
  async function recarregar() {
    const filtroServidor = (q) => {
      if (filtro.uf) q = q.contains('ufs', [filtro.uf]);
      if (filtro.conc) q = q.contains('distribuidoras', [filtro.conc]);
      return q;
    };
    const [carregadas, totalDoFiltro] = await Promise.all([
      buscarTop('empresa', { ordenarPor: 'potencia_total_kw', limite: TETO_CARGA, filtro: filtroServidor }),
      (filtro.uf || filtro.conc) ? contar('empresa', filtroServidor) : Promise.resolve(totalEmpresas),
    ]);
    empresas = carregadas;
    totalFiltrado = totalDoFiltro;
    truncado = empresas.length < totalFiltrado;
    opcPorte = opcoesDe((e) => e.portes);
    opcModal = opcoesDe((e) => e.modalidades);
    opcFase = opcoesDe((e) => e.fases);
  }
  await recarregar();

  function aplicar() {
    const f = filtro;
    const min = f.potMin === '' ? null : Number(f.potMin);
    const max = f.potMax === '' ? null : Number(f.potMax);
    const q = f.texto.trim().toLowerCase();
    return empresas.filter((e) => {
      // uf/conc já vieram filtrados do servidor (recarregar) — os testes
      // abaixo são só uma rede de segurança, não fazem trabalho de verdade
      if (f.uf && !(e.ufs || []).includes(f.uf)) return false;
      if (f.conc && !(e.distribuidoras || []).includes(f.conc)) return false;
      if (f.geracao && !(e.tipos_geracao || []).includes(f.geracao)) return false;
      if (f.porte && !(e.portes || []).includes(f.porte)) return false;
      if (f.modalidade && !(e.modalidades || []).includes(f.modalidade)) return false;
      if (f.fase && !(e.fases || []).includes(f.fase)) return false;
      const p = e.potencia_total_kw || 0;
      if (min != null && p < min) return false;
      if (max != null && p > max) return false;
      if (f.conexaoDe && (!e.ultima_conexao || e.ultima_conexao < f.conexaoDe)) return false;
      if (f.conexaoAte && (!e.primeira_conexao || e.primeira_conexao > f.conexaoAte)) return false;
      if (f.comTelefone && !e.telefone1) return false;
      if (f.comEmail && !e.email) return false;
      if (f.semLead && leadsAtivos.has(e.cnpj)) return false;
      if (supressao.testar({ cnpj: e.cnpj, telefone: e.telefone1, email: e.email })) return false;
      if (q) {
        const alvo = `${e.razao_social || ''} ${e.cnpj} ${e.municipio_principal || ''}`.toLowerCase();
        if (!alvo.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (b.potencia_total_kw || 0) - (a.potencia_total_kw || 0));
  }

  /* ── Controles ── */
  /** `remoto: true` (UF/distribuidora) reconsulta o servidor — os outros filtros
   * só refiltram o que já está carregado, sem nova requisição. */
  const sel = (rot, opcoes, chave, formatar, remoto) => {
    const s = h('select', {},
      h('option', { value: '' }, `${rot}: todas`),
      opcoes.map((o) => h('option', { value: o }, formatar ? formatar(o) : o)));
    s.addEventListener('change', async () => {
      filtro[chave] = s.value;
      if (remoto) {
        s.disabled = true;
        areaTabela.replaceChildren(h('div', { class: 'carregando' }, 'Buscando…'));
        try { await recarregar(); } catch (e) { toast(e.message, 'erro', 6000); }
        s.disabled = false;
      }
      desenhar();
    });
    return h('label', { class: 'campo campo--linha' }, s);
  };
  const num = (rot, chave) => {
    const i = h('input', { type: 'number', min: '0', step: '1', placeholder: rot, class: 'inp-num' });
    i.addEventListener('input', debounce(() => { filtro[chave] = i.value; desenhar(); }, 300));
    return h('label', { class: 'campo campo--linha' }, i);
  };
  const dt = (rot, chave) => {
    const i = h('input', { type: 'date', title: rot });
    i.addEventListener('change', () => { filtro[chave] = i.value; desenhar(); });
    return h('label', { class: 'campo campo--linha' }, h('span', { class: 'rot-mini' }, rot), i);
  };
  const chk = (rot, chave, marcado) => {
    const i = h('input', { type: 'checkbox', checked: marcado });
    i.addEventListener('change', () => { filtro[chave] = i.checked; desenhar(); });
    return h('label', { class: 'chk' }, i, rot);
  };

  const busca = h('input', { type: 'search', class: 'busca', placeholder: 'Razão social, CNPJ ou município…', 'aria-label': 'Buscar empresas' });
  busca.addEventListener('input', debounce(() => { filtro.texto = busca.value; desenhar(); }, 250));

  const painelFiltros = card(null,
    h('div', { class: 'filtros' },
      sel('UF', opcUF, 'uf', null, true),
      sel('Distribuidora', opcConc, 'conc', (c) => mapaConc.get(c) || c, true),
      sel('Geração', opcGer, 'geracao', (g) => TIPOS_GERACAO[g] || g),
      sel('Porte', opcPorte, 'porte'),
      sel('Modalidade', opcModal, 'modalidade'),
      opcFase.length ? sel('Fase', opcFase, 'fase') : null,
      num('Potência mín (kW)', 'potMin'),
      num('Potência máx (kW)', 'potMax'),
      dt('Conexão de', 'conexaoDe'),
      dt('até', 'conexaoAte')),
    h('div', { class: 'filtros filtros--chk' },
      chk('Tem telefone', 'comTelefone', false),
      chk('Tem e-mail', 'comEmail', false),
      chk('Esconder quem já é lead', 'semLead', true),
      busca));

  const areaKpis = h('div', { class: 'kpis' });
  const areaAcoes = h('div', { class: 'barra-selecao', hidden: true });
  const areaTabela = h('div', {});

  const colunas = [
    {
      titulo: 'Razão social',
      render: (e) => h('div', { class: 'cel-principal' },
        h('strong', {}, e.razao_social || '(sem nome)'),
        h('span', {}, maskCnpj(e.cnpj))),
    },
    { titulo: 'Usinas', largura: '70px', alinha: 'dir', render: (e) => fmtNum(e.qtd_usinas) },
    {
      titulo: 'Potência total',
      largura: '120px',
      alinha: 'dir',
      render: (e) => fmtPotencia(e.potencia_total_kw),
    },
    {
      titulo: 'Distribuidora',
      largura: '170px',
      render: (e) => (e.distribuidoras || []).slice(0, 2).map((c) => mapaConc.get(c) || c).join(', ')
        + ((e.distribuidoras || []).length > 2 ? ` +${e.distribuidoras.length - 2}` : ''),
    },
    { titulo: 'Cidade/UF', largura: '150px', render: (e) => [e.municipio_principal, e.uf_principal].filter(Boolean).join('/') },
    {
      titulo: 'Contato',
      largura: '190px',
      render: (e) => {
        if (!e.enriquecido_em) return h('span', { class: 'texto-fraco' }, 'não enriquecido');
        if (!e.telefone1 && !e.email) return badge('sem contato', 'cinza');
        return h('div', { class: 'cel-principal' },
          e.telefone1 ? h('strong', {}, maskFone(e.telefone1)) : null,
          e.email ? h('span', {}, e.email) : null);
      },
    },
    {
      titulo: 'Conexão',
      largura: '105px',
      render: (e) => fmtData(e.ultima_conexao) || '—',
    },
  ];

  function atualizarAcoes(lista) {
    const n = selecao.size;
    areaAcoes.hidden = n === 0;
    if (!n) return;
    const escolhidos = () => lista.filter((e) => selecao.has(e.cnpj));
    areaAcoes.replaceChildren(
      h('span', {}, `${n} empresa(s) selecionada(s)`),
      h('button', { class: 'btn btn--mini btn--primario', onclick: () => criarLeads(escolhidos()) },
        `Criar ${n} lead(s)`),
      h('button', { class: 'btn btn--mini', onclick: () => enriquecer(escolhidos().map((e) => e.cnpj)) },
        'Enriquecer contato'),
      h('button', { class: 'btn btn--mini btn--fantasma', onclick: () => { selecao.clear(); desenhar(); } },
        'Limpar'),
    );
  }

  async function criarLeads(escolhidos) {
    let destino = perfil.id;
    let distribuir = false;
    if (ehGestor) {
      const perfis = (await todos('profiles')).filter((p) => p.ativo);
      const r = await perguntar(`Criar ${escolhidos.length} lead(s)`, [{
        campo: 'owner_id', label: 'Dono dos leads', tipo: 'select', valor: perfil.id,
        opcoes: [{ v: '__round', label: '↻ Distribuir entre todos os agentes' },
          ...perfis.map((p) => ({ v: p.id, label: p.nome }))],
      }]);
      if (!r) return;
      if (r.owner_id === '__round') {
        distribuir = true;
        var rodizio = perfis.filter((p) => p.papel !== 'admin' || perfis.length === 1);
      } else destino = r.owner_id;
    }

    const sup = await carregarSupressao();
    const jaLead = new Set((await buscarLeads({})).map((l) => l.cnpj).filter(Boolean));
    let criados = 0, pulados = 0, suprimidos = 0;

    for (let i = 0; i < escolhidos.length; i++) {
      const e = escolhidos[i];
      if (jaLead.has(e.cnpj)) { pulados++; continue; }
      if (sup.testar({ cnpj: e.cnpj, telefone: e.telefone1, email: e.email })) { suprimidos++; continue; }
      const owner = distribuir ? rodizio[criados % rodizio.length].id : destino;
      await criarLead({
        cnpj: e.cnpj,
        razao_social: e.razao_social,
        origem: 'aneel',
        origem_detalhe: `Descobrir · ${e.qtd_usinas} usina(s) · ${fmtPotencia(e.potencia_total_kw)}`,
        telefone: e.telefone1 || null,
        telefone2: e.telefone2 || null,
        email: e.email || null,
        owner_id: owner,
        concessionaria_codigo: (e.distribuidoras || [])[0] || null,
        potencia_kwp: e.potencia_total_kw ?? null,
        cep: e.cep || null,
        cidade: e.municipio_principal || null,
        uf: e.uf_principal || null,
        proxima_acao_em: hojeISO(),
      });
      jaLead.add(e.cnpj);
      leadsAtivos.add(e.cnpj);
      criados++;
    }
    selecao.clear();
    toast(`${criados} lead(s) criado(s).`
      + (pulados ? ` ${pulados} já existiam.` : '')
      + (suprimidos ? ` ${suprimidos} bloqueado(s) por opt-out.` : ''), 'ok', 5000);
    desenhar();
  }

  async function enriquecer(cnpjs) {
    const prog = barraProgresso('preparando…');
    const controle = new AbortController();
    const { fechar } = (await import('../ui.js')).modal({
      titulo: `Enriquecendo ${cnpjs.length} CNPJ(s)`,
      corpo: h('div', {},
        h('p', { class: 'texto' },
          'Consultando OpenCNPJ com BrasilAPI como fallback. A procedência fica gravada '
          + 'em cada registro. Pode fechar depois — o progresso é salvo a cada CNPJ.'),
        prog.el),
      acoes: [{ label: 'Parar', classe: 'btn--fantasma', onclick: () => { controle.abort(); } }],
      aoFechar: () => controle.abort(),
    });

    const resumo = await processarFila(cnpjs, {
      sinal: controle.signal,
      onProgresso: ({ feito, total, cnpj, ok, suprimido }) => {
        prog.atualizar(feito, total,
          `${feito}/${total} · ${maskCnpj(cnpj)} ${suprimido ? '(suprimido)' : ok ? '✓' : '—'}`);
      },
    });
    fechar();
    toast(`Enriquecidos: ${resumo.ok} · com telefone: ${resumo.comTelefone} · com e-mail: ${resumo.comEmail}`
      + (resumo.erros ? ` · falhas: ${resumo.erros}` : ''), 'ok', 6000);

    // recarrega os agregados alterados (mesma busca limitada/ordenada de sempre)
    await recarregar();
    desenhar();
  }

  function desenhar() {
    const lista = aplicar();
    const potTotal = lista.reduce((s, e) => s + (e.potencia_total_kw || 0), 0);
    const usinas = lista.reduce((s, e) => s + (e.qtd_usinas || 0), 0);
    const comTel = lista.filter((e) => e.telefone1).length;
    const naoEnriq = lista.filter((e) => !e.enriquecido_em).length;

    areaKpis.replaceChildren(
      kpi('Empresas no filtro', fmtNum(lista.length),
        `${fmtNum(empresas.length)} carregadas de ${fmtNum(totalFiltrado)}${(filtro.uf || filtro.conc) ? ' no recorte' : ' na base'}`),
      kpi('Usinas', fmtNum(usinas)),
      kpi('Potência somada', fmtPotencia(potTotal)),
      kpi('Com telefone', fmtNum(comTel), lista.length ? `${Math.round((comTel / lista.length) * 100)}%` : ''),
      kpi('Sem enriquecer', fmtNum(naoEnriq),
        naoEnriq ? 'selecione e clique em Enriquecer' : 'tudo consultado'),
    );

    const pagina = lista.slice(0, 500);
    areaTabela.replaceChildren(...limpar(
      truncado
        ? h('p', { class: 'aviso' },
          `Carregadas as ${fmtNum(empresas.length)} empresas de maior potência (de `
          + `${fmtNum(totalFiltrado)}${(filtro.uf || filtro.conc) ? ' neste recorte' : ' na base'}) — filtre por `
          + 'UF ou distribuidora pra buscar outro recorte direto no banco, sem baixar tudo de uma vez.')
        : null,
      lista.length
        ? h('div', {},
          tabela({
            colunas,
            linhas: pagina,
            chave: (e) => e.cnpj,
            selecao: { set: selecao, aoMudar: () => atualizarAcoes(lista) },
            aoAbrir: () => {},
          }),
          lista.length > pagina.length
            ? h('p', { class: 'texto-fraco ta-centro' },
              `Mostrando as ${pagina.length} de maior potência. Refine o filtro para ver o resto.`)
            : null,
          h('div', { class: 'linha-botoes' },
            h('button', {
              class: 'btn btn--primario',
              onclick: () => criarLeads(lista.slice(0, 200)),
            }, `Criar leads das ${Math.min(lista.length, 200)} primeiras`),
            h('button', {
              class: 'btn',
              onclick: () => enriquecer(lista.filter((e) => !e.enriquecido_em).slice(0, 200).map((e) => e.cnpj)),
              disabled: naoEnriq === 0,
            }, `Enriquecer ${Math.min(naoEnriq, 200)} pendentes`)))
        : vazio('Nenhuma empresa neste filtro', 'Afrouxe os filtros ou importe mais um recorte da ANEEL.'),
    ));
    atualizarAcoes(lista);
  }

  const taxa = await taxaPreenchimento();
  raiz.append(...limpar(
    cabecalhoPagina('Descobrir',
      `${fmtNum(totalUsinas)} usinas · ${fmtNum(totalEmpresas)} CNPJs distintos na base`,
      h('button', {
        class: 'btn btn--fantasma',
        onclick: async () => {
          const n = await agregarEmpresas();
          toast(`${fmtNum(n)} empresas reagregadas a partir das usinas.`, 'ok');
          navegar('descobrir');
        },
      }, 'Reagregar')),
    taxa.enriquecidas
      ? h('p', { class: 'nota-taxa' },
        `Taxa de preenchimento medida: telefone em ${Math.round(taxa.pctTelefone * 100)}% e e-mail em `
        + `${Math.round(taxa.pctEmail * 100)}% de ${fmtNum(taxa.enriquecidas)} CNPJs consultados. `
        + 'É este número que decide se vale contratar fonte paga.')
      : null,
    painelFiltros,
    areaKpis,
    areaAcoes,
    areaTabela,
  ));
  desenhar();
  return raiz;
}
