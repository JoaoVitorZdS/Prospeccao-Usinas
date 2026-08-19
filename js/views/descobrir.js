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
  todos, buscarLeads, criarLead, carregarSupressao, contar, agregarEmpresas,
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
        'Importe um recorte da base de Geração Distribuída da ANEEL (CSV) pela tela Importar, '
        + 'aba "Base da ANEEL". Recorte por UF/distribuidora — não precisa dos 4,6 milhões de linhas.',
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

  const [empresas, concessionarias] = await Promise.all([todos('empresa'), todos('concessionaria')]);
  const mapaConc = new Map(concessionarias.map((c) => [c.codigo, c.nome]));
  const leadsAtivos = new Set((await buscarLeads({})).map((l) => l.cnpj).filter(Boolean));
  const supressao = await carregarSupressao();

  const filtro = {
    uf: '', conc: '', geracao: '', porte: '', modalidade: '', fase: '',
    potMin: '', potMax: '', conexaoDe: '', conexaoAte: '',
    comTelefone: false, comEmail: false, semLead: true, texto: '',
  };
  const selecao = new Set();

  /* opções derivadas do que existe na base, não de lista fixa */
  const opcoesDe = (extrair) => {
    const s = new Set();
    for (const e of empresas) for (const v of [].concat(extrair(e) || [])) if (v) s.add(v);
    return [...s].sort();
  };
  const opcConc = opcoesDe((e) => e.distribuidoras);
  const opcPorte = opcoesDe((e) => e.portes);
  const opcModal = opcoesDe((e) => e.modalidades);
  const opcFase = opcoesDe((e) => e.fases);
  const opcGer = opcoesDe((e) => e.tipos_geracao);
  const opcUF = opcoesDe((e) => e.ufs).filter((u) => UFS.includes(u));

  function aplicar() {
    const f = filtro;
    const min = f.potMin === '' ? null : Number(f.potMin);
    const max = f.potMax === '' ? null : Number(f.potMax);
    const q = f.texto.trim().toLowerCase();
    return empresas.filter((e) => {
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
  const sel = (rot, opcoes, chave, formatar) => {
    const s = h('select', {},
      h('option', { value: '' }, `${rot}: todas`),
      opcoes.map((o) => h('option', { value: o }, formatar ? formatar(o) : o)));
    s.addEventListener('change', () => { filtro[chave] = s.value; desenhar(); });
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

  const busca = h('input', { type: 'search', class: 'busca', placeholder: 'Razão social, CNPJ ou município…' });
  busca.addEventListener('input', debounce(() => { filtro.texto = busca.value; desenhar(); }, 250));

  const painelFiltros = card(null,
    h('div', { class: 'filtros' },
      sel('UF', opcUF, 'uf'),
      sel('Distribuidora', opcConc, 'conc', (c) => mapaConc.get(c) || c),
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

    // recarrega os agregados alterados
    const novos = await todos('empresa');
    empresas.length = 0;
    empresas.push(...novos);
    desenhar();
  }

  function desenhar() {
    const lista = aplicar();
    const potTotal = lista.reduce((s, e) => s + (e.potencia_total_kw || 0), 0);
    const usinas = lista.reduce((s, e) => s + (e.qtd_usinas || 0), 0);
    const comTel = lista.filter((e) => e.telefone1).length;
    const naoEnriq = lista.filter((e) => !e.enriquecido_em).length;

    areaKpis.replaceChildren(
      kpi('Empresas no filtro', fmtNum(lista.length), `de ${fmtNum(empresas.length)} na base`),
      kpi('Usinas', fmtNum(usinas)),
      kpi('Potência somada', fmtPotencia(potTotal)),
      kpi('Com telefone', fmtNum(comTel), lista.length ? `${Math.round((comTel / lista.length) * 100)}%` : ''),
      kpi('Sem enriquecer', fmtNum(naoEnriq),
        naoEnriq ? 'selecione e clique em Enriquecer' : 'tudo consultado'),
    );

    const pagina = lista.slice(0, 500);
    areaTabela.replaceChildren(
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
    );
    atualizarAcoes(lista);
  }

  const taxa = await taxaPreenchimento();
  raiz.append(...limpar(
    cabecalhoPagina('Descobrir',
      `${fmtNum(totalUsinas)} usinas · ${fmtNum(empresas.length)} CNPJs distintos na base local`,
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
