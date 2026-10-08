// views/importar.js — uma tela, três entradas, mesmo parser e mesma prévia (seção 7.D).
//
// Princípios que o código honra:
//   • nunca aborta o lote inteiro por uma linha ruim — separa as rejeitadas;
//   • dedup por CNPJ → telefone (últimos 8) → e-mail, nessa ordem de confiança,
//     e SEM fuzzy por razão social (falso positivo com matriz/filial);
//   • a linha da planilha legada vira `interacao` histórica, não some;
//   • grava resumo em `import_lote` — é a defesa documental da LGPD.

import {
  h, esc, maskCnpj, maskFone, normCnpj, normFone, normEmail, foneKey, slug,
  parseData, parseNum, fmtData, paraCSV, baixar, nomeArquivo, hojeISO, uuid, fmtNum,
} from '../util.js';
import {
  ORIGENS, STATUS, STATUS_MAP, statusLabel, origemLabel, TIPOS_GERACAO,
} from '../seed.js';
import {
  CAMPOS_LEAD, CAMPOS_ANEEL, autoMapear, aplicarMapa, pareceCabecalho,
  parseTabelaHTML, parseTexto, lerArquivo,
} from '../parse.js';
import {
  todos, get, put, criarLead, salvarLead, cacheDedup, carregarSupressao, registrarLote,
  casarConcessionaria, agregarEmpresas, putMuitos, registrarInteracao, empresasPorCnpj,
} from '../db.js';
import { CAMPOS_CNPJ, linhaParaEmpresa, ehEmpresarioIndividual } from '../cnpj-importacao.js';
import {
  cabecalhoPagina, card, tabela, toast, vazio, badge, kpi, barraProgresso, confirmar, pills,
} from '../ui.js';
import { navegar } from '../ui.js';
import {
  RECURSOS_ANEEL, AMOSTRAS, extrairProprietariosSiga, splitMunicipioUF, lerZipCsvStream,
} from '../aneel.js';

export async function viewImportar(params, ctxApp) {
  const { perfil, ehGestor } = ctxApp;

  const estado = {
    // a base da ANEEL escreve em `usina_aneel`, que só o gestor pode gravar (RLS)
    modo: params.modo === 'aneel' && ehGestor ? 'aneel' : (params.modo === 'cnpj' ? 'cnpj' : 'lead'),
    fonteTipo: 'colagem',   // colagem | planilha | extensao
    nomeArquivoOrigem: null,
    linhas: [],
    cabecalho: [],
    temCabecalho: true,
    mapa: {},
    acaoDup: 'ignorar',     // ignorar | mesclar | criar
    ownerPadrao: perfil.id,
    origemPadrao: 'planilha_legada',
    nomeLista: '',          // nome da lista criada pela importação de leads (vazio = nome do arquivo)
    // modo "Base CNPJ" (dados abertos da Receita)
    criarLeads: false,      // além de gravar a empresa, cria um lead para as novas
    soAtivas: true,         // ignora CNPJ com situação diferente de Ativa
    incluirEI: false,       // empresário individual = pessoa física: fora por padrão (LIA)
    competencia: '',        // mês da base da Receita (AAAA-MM), só informativo
    analise: null,
  };

  const perfis = (await todos('profiles')).filter((p) => p.ativo);

  /** Nome da lista que esta importação vai criar: o que a pessoa digitou ou o nome do arquivo. */
  function nomePadraoLista() {
    const arq = estado.nomeArquivoOrigem || '';
    if (!arq || /^colagem/.test(arq)) return `Colagem de ${fmtData(hojeISO())}`;
    return arq.replace(/\.[^.]+$/, '');
  }
  const nomeDaLista = () => (estado.nomeLista || '').trim() || nomePadraoLista();

  const raiz = h('div', { class: 'pagina' });
  const areaEtapas = h('div', {});

  const campos = () => (estado.modo === 'aneel' ? CAMPOS_ANEEL : estado.modo === 'cnpj' ? CAMPOS_CNPJ : CAMPOS_LEAD);

  /* ═══════════ Etapa 1 — entrada ═══════════ */

  function etapaEntrada() {
    const colar = h('div', {
      class: 'colar', contenteditable: 'true', role: 'textbox', tabindex: '0',
      'aria-label': 'Área de colagem',
      'data-dica': 'Clique aqui e cole (Ctrl+V / ⌘V) a tabela copiada do site ou do Excel',
    });

    // O evento `paste` não exige permissão nenhuma e funciona em 100% dos sites,
    // inclusive nos que bloqueiam tudo. `text/html` traz a tabela estruturada.
    colar.addEventListener('paste', (e) => {
      e.preventDefault();
      const html = e.clipboardData.getData('text/html');
      const txt = e.clipboardData.getData('text/plain');
      let linhas = null;
      if (html) linhas = parseTabelaHTML(html);
      if (!linhas || linhas.length < 2) linhas = txt ? parseTexto(txt) : null;
      if (!linhas || !linhas.length) {
        toast('Não achei tabela na colagem. Copie incluindo o cabeçalho.', 'erro');
        return;
      }
      estado.fonteTipo = 'colagem';
      estado.nomeArquivoOrigem = html ? 'colagem (text/html)' : 'colagem (texto)';
      receber(linhas);
    });

    const aceitaZip = estado.modo === 'aneel';
    const inputArquivo = h('input', {
      type: 'file',
      accept: aceitaZip ? '.csv,.tsv,.txt,.xlsx,.xlsm,.zip' : '.csv,.tsv,.txt,.xlsx,.xlsm',
      hidden: true,
      onchange: (e) => { if (e.target.files[0]) abrirArquivo(e.target.files[0]); },
    });

    const zona = h('div', { class: 'zona' },
      h('div', { class: 'zona__icone' }, '⇩'),
      h('p', {}, h('strong', {}, 'Arraste um arquivo aqui'),
        aceitaZip ? ' — CSV, TSV, XLSX ou o .zip baixado direto da ANEEL' : ' — CSV, TSV ou XLSX'),
      h('button', { class: 'btn', onclick: () => inputArquivo.click() }, 'Escolher arquivo'),
      inputArquivo);

    ['dragenter', 'dragover'].forEach((ev) => zona.addEventListener(ev, (e) => {
      e.preventDefault(); zona.classList.add('is-sobre');
    }));
    ['dragleave', 'drop'].forEach((ev) => zona.addEventListener(ev, (e) => {
      e.preventDefault(); zona.classList.remove('is-sobre');
    }));
    zona.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0];
      if (f) abrirArquivo(f);
    });

    const abasModo = pills(
      [{ v: 'lead', label: 'Leads / planilha' },
        { v: 'cnpj', label: 'Base CNPJ (Receita)' },
        ...(ehGestor ? [{ v: 'aneel', label: 'Base da ANEEL' }] : [])],
      estado.modo,
      (v) => { estado.modo = v; desenhar(); },
    );

    const recurso = (r, tipoAmostra) => h('div', { class: 'recurso' },
      h('div', { class: 'recurso__texto' },
        h('strong', {}, r.label),
        h('p', { class: 'texto-fraco' }, r.descricao)),
      h('div', { class: 'linha-botoes linha-botoes--fina' },
        h('a', { class: 'btn btn--primario', href: r.url, target: '_blank', rel: 'noopener' },
          `⇩ Baixar (${r.tamanhoAprox})`),
        h('button', { class: 'btn btn--mini', onclick: () => testarAmostra(tipoAmostra) },
          'Testar com amostra real')));

    const painelRecursos = estado.modo === 'aneel'
      ? card('Baixar direto da ANEEL',
        h('p', { class: 'texto-fraco' },
          'Links diretos para o recurso certo — sem navegar o site da ANEEL. O clique baixa o '
          + 'arquivo normalmente (isso não é bloqueado por CORS, é download de página); depois é '
          + 'só arrastar o arquivo baixado na zona abaixo.'),
        h('div', { class: 'recursos-aneel' },
          recurso(RECURSOS_ANEEL.gdZip, 'gd'),
          recurso(RECURSOS_ANEEL.sigaCsv, 'siga')),
        h('p', { class: 'texto-fraco' },
          h('a', { href: RECURSOS_ANEEL.linkDataset, target: '_blank', rel: 'noopener' }, 'Página da GD na ANEEL ↗'),
          ' · ',
          h('a', { href: RECURSOS_ANEEL.linkDatasetSiga, target: '_blank', rel: 'noopener' }, 'Página do SIGA na ANEEL ↗')))
      : null;

    return h('div', {},
      card(h('div', { class: 'card__cabeca' },
        h('h2', {}, 'O que você está importando?'), abasModo),
      estado.modo === 'aneel'
        ? h('p', { class: 'texto-fraco' },
          'Espelho da fonte externa: alimenta `usina_aneel` e reagrega `empresa` por CNPJ. '
          + 'Só o recorte PJ é usado — titulares PF vêm mascarados pela própria ANEEL e não '
          + 'devem ser reidentificados. O ZIP da GD (110 MB) pode ser arrastado direto — o app '
          + 'filtra PJ e descompacta em streaming, sem travar a aba.')
        : estado.modo === 'cnpj'
          ? h('p', { class: 'texto-fraco' },
            'Cadastro de empresas (CNPJ, CNAE, porte, sócios, contatos) a partir dos dados abertos da '
            + 'Receita Federal — o mesmo conjunto que sites como o Casa dos Dados exibem. Grava em `empresa` '
            + 'sem apagar o que já existe e, se quiser, cria os leads. O arquivo vem do servidor MCP '
            + '(`mcp/`, ferramenta cnpj_exportar) ou de qualquer CSV/XLSX com colunas parecidas. '
            + 'Empresário individual (pessoa física) fica de fora por padrão.')
          : h('p', { class: 'texto-fraco' },
            'Vira `lead` + histórico. A planilha atual entra aqui: as 10 colunas são reconhecidas '
            + 'automaticamente e a "Descrição do contato" vira o primeiro toque do histórico.')),
      painelRecursos,
      h('div', { class: 'grade-2 grade-2--larga' },
        card('1. Colar tabela',
          h('p', { class: 'texto-fraco' },
            'Copie a tabela no site (ou no Excel) e cole abaixo. Funciona em qualquer site, '
            + 'sem extensão e sem permissão.'),
          colar),
        card('2. Arrastar arquivo', zona)),
      card('3. Captura pela extensão',
        h('p', { class: 'texto-fraco' },
          'Fase 3 do plano: extensão Chrome MV3 com Side Panel, extrator dirigido por '
          + '`captura_config`. Quando existir, a captura cai nesta mesma prévia.'),
        h('span', { class: 'badge badge--cinza' }, 'não implementado nesta versão')),
    );
  }

  async function abrirArquivo(file) {
    if (/\.zip$/i.test(file.name)) {
      if (estado.modo !== 'aneel') {
        toast('.zip só é aceito na aba "Base da ANEEL" — para leads, use CSV/TSV/XLSX.', 'aviso', 5000);
        return;
      }
      return abrirZipAneel(file);
    }
    try {
      const r = await lerArquivo(file);
      if (r.formato === 'json') {
        toast('Para restaurar backup, use Config → Backup.', 'aviso');
        return;
      }
      if (!r.linhas?.length) { toast('Arquivo vazio.', 'erro'); return; }
      estado.fonteTipo = 'planilha';
      estado.nomeArquivoOrigem = file.name;
      receber(r.linhas);
    } catch (e) {
      toast(e.message, 'erro', 7000);
    }
  }

  /**
   * O ZIP da GD tem ~4,6 milhões de linhas — a esmagadora maioria PF (seção 2.1
   * do plano). Filtrar PJ EM STREAMING, sem nunca montar o CSV inteiro em texto,
   * é o que faz 110 MB comprimidos virarem só ~360 mil linhas na memória em vez
   * de um ~1 GB de string que travaria a aba.
   */
  async function abrirZipAneel(file) {
    const prog = barraProgresso('lendo o ZIP…');
    const controle = new AbortController();
    const { modal } = await import('../ui.js');
    const { fechar } = modal({
      titulo: 'Lendo o ZIP da ANEEL',
      corpo: h('div', {},
        h('p', { class: 'texto' },
          'Descompactando e filtrando só PJ, direto no navegador — o CSV completo '
          + '(cerca de 1 GB descomprimido) nunca fica todo na memória de uma vez.'),
        prog.el),
      acoes: [{ label: 'Parar', classe: 'btn--fantasma', onclick: () => controle.abort() }],
      aoFechar: () => controle.abort(),
    });

    let cabecalho = null;
    let idxTipo = -1;
    const linhasPJ = [];
    try {
      const r = await lerZipCsvStream(file, {
        onCabecalho: (c) => {
          cabecalho = c;
          idxTipo = indiceColunaLocal(c, ['sigtipoconsumidor']);
          if (idxTipo < 0) toast('Não achei a coluna de tipo (PJ/PF) — vou manter todas as linhas.', 'aviso', 6000);
        },
        onLinha: (l) => {
          if (controle.signal.aborted) return false;
          if (idxTipo < 0 || l[idxTipo] === 'PJ') linhasPJ.push(l);
          return true;
        },
        onProgresso: ({ bytesLidos, bytesTotal }) => {
          const pct = bytesTotal ? Math.round((bytesLidos / bytesTotal) * 100) : 0;
          prog.atualizar(bytesLidos, bytesTotal || bytesLidos,
            `${pct}% do ZIP · ${fmtNum(linhasPJ.length)} usinas PJ encontradas até agora`);
        },
      });
      fechar();
      if (r.interrompido) { toast('Leitura interrompida.', 'aviso'); return; }
      if (!linhasPJ.length) { toast('Nenhuma linha PJ encontrada nesse ZIP.', 'aviso'); return; }
      estado.fonteTipo = 'aneel';
      estado.nomeArquivoOrigem = file.name;
      receberComCabecalho(cabecalho, linhasPJ);
      toast(`${fmtNum(linhasPJ.length)} usinas PJ carregadas do ZIP (PF descartado em streaming, sem tocar a memória).`, 'ok', 6000);
    } catch (e) {
      fechar();
      toast(e.message, 'erro', 8000);
    }
  }

  function indiceColunaLocal(cabecalho, aliases) {
    const s = cabecalho.map(slug);
    for (const a of aliases) { const i = s.indexOf(a); if (i >= 0) return i; }
    return -1;
  }

  async function testarAmostra(tipo) {
    try {
      const url = tipo === 'gd' ? AMOSTRAS.gdZip : AMOSTRAS.sigaCsv;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Não consegui carregar a amostra embutida no repo.');
      const blob = await resp.blob();
      const nome = tipo === 'gd' ? 'aneel-gd-amostra.zip' : 'aneel-siga-amostra.csv';
      const file = new File([blob], nome, { type: blob.type });
      await abrirArquivo(file);
    } catch (e) {
      toast(e.message, 'erro', 6000);
    }
  }

  /** Variante de `receber()` para quando o cabeçalho já veio separado (leitura em streaming do ZIP). */
  function receberComCabecalho(cabecalho, linhasDados) {
    estado.temCabecalho = true;
    estado.cabecalho = cabecalho;
    estado.linhas = linhasDados;
    estado.mapa = autoMapear(cabecalho, campos());
    estado.analise = null;
    if (!Object.keys(estado.mapa).length) {
      toast('Não reconheci nenhuma coluna. Mapeie manualmente abaixo.', 'aviso', 5000);
    }
    desenhar();
  }

  function receber(linhas) {
    const temCab = pareceCabecalho(linhas[0], campos());
    estado.temCabecalho = temCab;
    estado.cabecalho = temCab ? linhas[0] : linhas[0].map((_, i) => `Coluna ${i + 1}`);
    estado.linhas = temCab ? linhas.slice(1) : linhas;
    estado.mapa = autoMapear(estado.cabecalho, campos());
    estado.analise = null;
    if (!Object.keys(estado.mapa).length) {
      toast('Não reconheci nenhuma coluna. Mapeie manualmente abaixo.', 'aviso', 5000);
    }
    desenhar();
  }

  /* ═══════════ Etapa 2 — mapeamento ═══════════ */

  function etapaMapa() {
    const defs = campos();
    const usados = new Set(Object.values(estado.mapa));

    const grade = h('div', { class: 'mapa' });
    for (const def of defs) {
      const s = h('select', {},
        h('option', { value: '' }, '— ignorar —'),
        estado.cabecalho.map((c, i) => h('option', {
          value: String(i),
          selected: estado.mapa[def.campo] === i,
          disabled: usados.has(i) && estado.mapa[def.campo] !== i,
        }, `${c || `Coluna ${i + 1}`}`)));
      s.addEventListener('change', () => {
        if (s.value === '') delete estado.mapa[def.campo];
        else estado.mapa[def.campo] = Number(s.value);
        estado.analise = null;
        desenhar();
      });
      const detectado = estado.mapa[def.campo] != null;
      grade.append(h('label', { class: `mapa__item ${detectado ? 'is-ok' : ''}` },
        h('span', {}, def.label, detectado ? h('em', {}, 'detectado') : null), s));
    }

    const amostra = h('div', { class: 'tabela-wrap tabela-wrap--amostra' },
      h('table', { class: 'tabela tabela--mini' },
        h('thead', {}, h('tr', {}, estado.cabecalho.map((c) => h('th', {}, c || '—')))),
        h('tbody', {}, estado.linhas.slice(0, 5).map((l) =>
          h('tr', {}, estado.cabecalho.map((_, i) => h('td', {}, l[i] ?? ''))))),
      ));

    const opcoesLead = estado.modo === 'lead'
      ? h('div', { class: 'filtros' },
        h('label', { class: 'campo campo--linha' },
          h('span', { class: 'rot-mini' }, 'Origem padrão'),
          (() => {
            const s = h('select', {}, ORIGENS.map((o) =>
              h('option', { value: o.v, selected: o.v === estado.origemPadrao }, o.label)));
            s.addEventListener('change', () => { estado.origemPadrao = s.value; estado.analise = null; });
            return s;
          })()),
        h('label', { class: 'campo campo--linha' },
          h('span', { class: 'rot-mini' }, 'Dono padrão'),
          (() => {
            const s = h('select', { disabled: !ehGestor }, perfis.map((p) =>
              h('option', { value: p.id, selected: p.id === estado.ownerPadrao }, p.nome)));
            s.addEventListener('change', () => { estado.ownerPadrao = s.value; estado.analise = null; });
            return s;
          })()),
        h('label', { class: 'campo campo--linha' },
          h('span', { class: 'rot-mini' }, 'Quando já existir'),
          (() => {
            const s = h('select', {},
              h('option', { value: 'ignorar', selected: estado.acaoDup === 'ignorar' }, 'Ignorar (padrão)'),
              h('option', { value: 'mesclar', selected: estado.acaoDup === 'mesclar' }, 'Mesclar — preenche vazios e guarda histórico'),
              h('option', { value: 'criar', selected: estado.acaoDup === 'criar' }, 'Criar mesmo assim (marca duplicado_de)'));
            s.addEventListener('change', () => { estado.acaoDup = s.value; estado.analise = null; desenhar(); });
            return s;
          })()))
      : null;

    const marca = (rot, chave, ajuda) => h('label', { class: 'chk', title: ajuda || '' },
      h('input', {
        type: 'checkbox', checked: !!estado[chave],
        onchange: (e) => { estado[chave] = e.target.checked; estado.analise = null; desenhar(); },
      }), rot);
    const opcoesCnpj = estado.modo === 'cnpj'
      ? h('div', { class: 'filtros filtros--chk' },
        marca('Só empresas ativas', 'soAtivas', 'Ignora CNPJ baixado, suspenso ou inapto'),
        marca('Incluir empresário individual (pessoa física)', 'incluirEI', 'Não recomendado: a razão social é o nome de uma pessoa'),
        marca('Criar leads para as empresas novas', 'criarLeads', 'Cada empresa nova vira um lead na lista desta importação'),
        estado.criarLeads
          ? h('label', { class: 'campo campo--linha' },
            h('span', { class: 'rot-mini' }, 'Dono dos leads'),
            (() => {
              const sel = h('select', { disabled: !ehGestor }, perfis.map((p) =>
                h('option', { value: p.id, selected: p.id === estado.ownerPadrao }, p.nome)));
              sel.addEventListener('change', () => { estado.ownerPadrao = sel.value; estado.analise = null; });
              return sel;
            })())
          : null,
        h('label', { class: 'campo campo--linha' },
          h('span', { class: 'rot-mini' }, 'Mês da base (AAAA-MM)'),
          h('input', {
            type: 'text', value: estado.competencia, placeholder: '2026-09', maxlength: '7', class: 'inp-num',
            oninput: (e) => { estado.competencia = e.target.value.trim(); estado.analise = null; },
          })))
      : null;

    return card(
      h('div', { class: 'card__cabeca' },
        h('h2', {}, 'Conferir o mapeamento'),
        h('div', { class: 'linha-botoes linha-botoes--fina' },
          h('span', { class: 'texto-fraco' },
            `${fmtNum(estado.linhas.length)} linha(s) · ${estado.nomeArquivoOrigem || ''}`),
          h('button', {
            class: 'btn btn--mini',
            onclick: () => {
              estado.temCabecalho = !estado.temCabecalho;
              const todasLinhas = estado.temCabecalho
                ? [estado.cabecalho, ...estado.linhas]
                : [estado.cabecalho, ...estado.linhas];
              receber(todasLinhas);
            },
          }, estado.temCabecalho ? '1ª linha é dado' : '1ª linha é cabeçalho'),
          h('button', { class: 'btn btn--mini btn--fantasma', onclick: () => { estado.linhas = []; desenhar(); } },
            'Recomeçar'))),
      grade,
      opcoesLead,
      opcoesCnpj,
      h('details', { class: 'extra' }, h('summary', {}, 'Ver as 5 primeiras linhas do arquivo'), amostra),
      h('div', { class: 'linha-botoes' },
        h('button', {
          class: 'btn btn--primario',
          onclick: async () => { estado.analise = await analisar(); desenhar(); },
        }, 'Analisar e ver prévia')),
    );
  }

  /* ═══════════ Análise (veredito por linha) ═══════════ */

  async function analisar() {
    const brutos = aplicarMapa(estado.linhas, estado.mapa);
    if (estado.modo === 'aneel') return analisarAneel(brutos);
    if (estado.modo === 'cnpj') return analisarCnpj(brutos);
    return analisarLeads(brutos);
  }

  /**
   * Base CNPJ: cada linha vira uma `empresa`. Veredito: NOVO (não existia), ATUALIZA (já existia — o
   * upsert só escreve o que veio preenchido), ou fora (sem CNPJ, repetido, opt-out, pessoa física,
   * não ativa). Contato (telefone/e-mail) em opt-out é descartado, como no enriquecimento.
   */
  async function analisarCnpj(brutos) {
    const supressao = await carregarSupressao();
    const conv = brutos.map((b) => ({ b, r: linhaParaEmpresa(b, { competencia: estado.competencia || undefined }) }));
    const cnpjs = conv.map(({ r }) => r.empresa?.cnpj).filter(Boolean);
    const existentes = new Set((await empresasPorCnpj(cnpjs)).map((e) => e.cnpj));
    const cacheLeads = estado.criarLeads ? await cacheDedup({ cnpjs, fones: [], emails: [] }) : null;
    const vistos = new Map();
    const itens = [];

    for (const { b, r } of conv) {
      const item = { _linha: b._linha, bruto: b, erros: [] };
      itens.push(item);
      if (r.erro) { item.veredito = 'sem_id'; item.erros.push(r.erro); continue; }
      const e = r.empresa;
      item.empresa = e;
      if (vistos.has(e.cnpj)) {
        item.veredito = 'duplicado_lote';
        item.detalhe = `igual à linha ${vistos.get(e.cnpj) + 1} deste mesmo arquivo`;
        continue;
      }
      vistos.set(e.cnpj, b._linha);

      const motivo = supressao.testar({ cnpj: e.cnpj, telefone: e.telefone1, email: e.email });
      if (motivo === 'cnpj') { item.veredito = 'suprimido'; item.detalhe = 'opt-out registrado por cnpj'; continue; }
      if (!estado.incluirEI && ehEmpresarioIndividual(e)) {
        item.veredito = 'pf';
        item.detalhe = 'empresário individual (pessoa física)';
        continue;
      }
      if (estado.soAtivas && e.situacao_cadastral && e.situacao_cadastral !== 'Ativa') {
        item.veredito = 'inativa';
        item.detalhe = `situação: ${e.situacao_cadastral}`;
        continue;
      }
      // contato em opt-out não entra na base (o CNPJ em si pode entrar)
      const tirados = [];
      if (e.telefone1 && supressao.testar({ telefone: e.telefone1 })) { delete e.telefone1; tirados.push('telefone'); }
      if (e.telefone2 && supressao.testar({ telefone: e.telefone2 })) { delete e.telefone2; tirados.push('telefone 2'); }
      if (e.email && supressao.testar({ email: e.email })) { delete e.email; tirados.push('e-mail'); }

      item.veredito = existentes.has(e.cnpj) ? 'atualiza' : 'novo';
      const notas = [];
      if (tirados.length) notas.push(`${tirados.join(' e ')} em opt-out — descartado`);
      if (estado.criarLeads) {
        if (cacheLeads.porCnpj.has(e.cnpj)) { item.jaTemLead = true; notas.push('já tem lead — só a empresa é gravada'); }
        else item.vaiViraLead = true;
      }
      if (notas.length) item.detalhe = notas.join(' · ');
    }
    return { tipo: 'cnpj', itens };
  }

  async function analisarLeads(brutos) {
    // chaves do arquivo: o banco diz quais já estão na carteira de OUTRO agente (o RLS esconde os leads dele)
    const candidatos = { cnpjs: [], fones: [], emails: [] };
    for (const b of brutos) {
      const c = normCnpj(b.cnpj);
      const fk = foneKey(normFone(b.telefone));
      const em = normEmail(b.email);
      if (c) candidatos.cnpjs.push(c);
      if (fk) candidatos.fones.push(fk);
      if (em) candidatos.emails.push(em);
    }
    const cache = await cacheDedup(candidatos);
    const supressao = await carregarSupressao();
    const porNome = new Map(perfis.map((p) => [slug(p.nome), p.id]));
    const porEmail = new Map(perfis.map((p) => [p.email, p.id]));
    const vistosNoLote = { cnpj: new Map(), fone: new Map(), email: new Map() };

    const itens = [];
    for (const b of brutos) {
      const item = { _linha: b._linha, bruto: b, erros: [] };
      const cnpj = normCnpj(b.cnpj);
      const tel = normFone(b.telefone);
      const email = normEmail(b.email);
      const nome = (b.razao_social || '').trim();
      const contato = (b.contato_nome || '').trim();

      if (b.cnpj && !cnpj) item.erros.push('CNPJ ilegível');
      if (!cnpj && !tel && !email) {
        item.veredito = 'sem_id';
        item.erros.push('sem CNPJ, telefone ou e-mail');
      }
      if (!nome && !contato && !item.erros.length) item.erros.push('sem nome');

      // origem: reconhece o texto da planilha, senão usa o padrão
      const sOrigem = slug(b.origem);
      const origem = ORIGENS.find((o) => slug(o.label) === sOrigem || o.v === sOrigem)?.v
        || (b.origem ? 'outro' : estado.origemPadrao);

      // status: coluna explícita vence; senão deriva de "Desenvolveu"
      let status = null;
      if (b.status) {
        const s = slug(b.status);
        status = STATUS.find((x) => slug(x.label) === s || x.v === s)?.v || null;
      }
      if (!status && b.desenvolveu) {
        status = /^(s|sim|y|yes|true|1|x)$/i.test(String(b.desenvolveu).trim()) ? 'qualificado' : 'a_abordar';
      }

      const autorId = porNome.get(slug(b.autor)) || porEmail.get(normEmail(b.autor)) || null;
      if (b.autor && !autorId) item.avisoAutor = b.autor;

      const dataContato = parseData(b.data_contato);
      const conc = b.concessionaria ? await casarConcessionaria(b.concessionaria) : null;

      item.lead = {
        cnpj: cnpj || undefined,
        razao_social: nome || undefined,
        contato_nome: contato || undefined,
        contato_cargo: b.contato_cargo || undefined,
        telefone: tel || undefined,
        telefone2: normFone(b.telefone2) || undefined,
        email: email || undefined,
        linkedin_url: b.linkedin_url || undefined,
        origem,
        origem_detalhe: estado.nomeArquivoOrigem || undefined,
        status: status || 'a_abordar',
        owner_id: autorId || estado.ownerPadrao,
        concessionaria_codigo: conc || undefined,
        concessionaria_raw: !conc && b.concessionaria ? b.concessionaria : undefined,
        cep: (b.cep || '').replace(/\D/g, '').slice(0, 8) || undefined,
        cidade: b.cidade || undefined,
        uf: (b.uf || '').trim().toUpperCase().slice(0, 2) || undefined,
        potencia_kwp: parseNum(b.potencia_kwp) ?? undefined,
        descricao: b.descricao || undefined,
        tipo: /interm/i.test(b.tipo || '') ? 'intermediador' : 'usina_geradora',
        primeiro_contato_em: dataContato || undefined,
        ultimo_contato_em: dataContato || undefined,
        proxima_acao_em: parseData(b.proxima_acao_em) || (status && status !== 'a_abordar' ? undefined : hojeISO()),
        // `tentativas` NÃO é setado aqui: fica no padrão 0 de `criarLead`. Quem conta
        // é `talvezHistorico` → `registrarInteracao`, chamado logo abaixo quando há
        // data de contato ou descrição. Setar aqui E lá contava o mesmo toque em dobro.
      };
      item.dataContato = dataContato;
      item.descricaoHistorica = b.descricao || null;

      // supressão vence tudo
      const motivoSup = supressao.testar({ cnpj, telefone: tel, email });
      if (motivoSup) {
        item.veredito = 'suprimido';
        item.detalhe = `opt-out registrado por ${motivoSup}`;
      } else if (item.veredito !== 'sem_id') {
        // duplicado contra o banco…
        const dup = await acharNoCache(cache, { cnpj, tel, email });
        // …e contra o próprio lote (duas linhas do mesmo CNPJ)
        const noLote = (cnpj && vistosNoLote.cnpj.get(cnpj))
          || (tel && vistosNoLote.fone.get(foneKey(tel)))
          || (email && vistosNoLote.email.get(email));

        if (dup) {
          item.veredito = 'duplicado';
          item.dup = dup.lead;
          item.dupPor = dup.por;
          item.detalhe = dup.lead.alheio
            ? 'já está na carteira de outro agente'
            : `dono ${nomeDe(dup.lead.owner_id)} · ${statusLabel(dup.lead.status)}`;
        } else if (noLote != null) {
          item.veredito = 'duplicado_lote';
          item.detalhe = `igual à linha ${noLote + 1} deste mesmo arquivo`;
        } else {
          item.veredito = 'novo';
          if (cnpj) vistosNoLote.cnpj.set(cnpj, b._linha);
          if (tel) vistosNoLote.fone.set(foneKey(tel), b._linha);
          if (email) vistosNoLote.email.set(email, b._linha);
        }
      }
      itens.push(item);
    }
    return { tipo: 'lead', itens };
  }

  function acharNoCache(cache, { cnpj, tel, email }) {
    if (cnpj && cache.porCnpj.has(cnpj)) return { lead: cache.porCnpj.get(cnpj), por: 'CNPJ' };
    const fk = foneKey(tel);
    if (fk && cache.porFone.has(fk)) return { lead: cache.porFone.get(fk), por: 'telefone' };
    if (email && cache.porEmail.has(email)) return { lead: cache.porEmail.get(email), por: 'e-mail' };
    return null;
  }

  const nomeDe = (id) => perfis.find((p) => p.id === id)?.nome || '—';

  /**
   * O SIGA não tem coluna de CNPJ — o(s) dono(s) vêm em texto livre na coluna
   * `proprietario_regime` (`extrairProprietariosSiga`, validado contra as
   * 25.264 linhas reais do dump). Uma usina em coparticipação gera MAIS DE UM
   * item aqui — um por dono — porque o modelo de dados é "um lead por CNPJ",
   * não "um lead por usina" (seção 5.1 do plano).
   */
  function proprietariosDaLinha(b) {
    const docBruto = String(b.cnpj || '');
    if (docBruto && !/\*/.test(docBruto)) {
      const cnpj = normCnpj(docBruto);
      if (cnpj) return [{ cnpj, titular: (b.titular || '').trim() || null, regime: null }];
    }
    if (b.proprietario_regime) {
      return extrairProprietariosSiga(b.proprietario_regime)
        .map((p) => ({ cnpj: p.cnpj, titular: p.nome, regime: p.regime }));
    }
    return [];
  }

  async function analisarAneel(brutos) {
    const itens = [];
    const vistos = new Set();
    for (const b of brutos) {
      const tipoCons = (b.tipo_consumidor || '').trim().toUpperCase();
      const docBruto = String(b.cnpj || '');
      const mascarado = /\*/.test(docBruto);

      // Recorte PJ, sempre. PF vem mascarado pela ANEEL e não se reidentifica (seção 9).
      // Só se aplica quando existe coluna de tipo_consumidor (GD) — o SIGA não tem PF.
      if (mascarado || tipoCons === 'PF' || (docBruto && digitsLen(docBruto) === 11)) {
        itens.push({ _linha: b._linha, bruto: b, erros: [], veredito: 'pf', detalhe: 'titular PF — fora do recorte, por desenho' });
        continue;
      }

      const donos = proprietariosDaLinha(b);
      if (!donos.length) {
        itens.push({
          _linha: b._linha, bruto: b, erros: ['CNPJ ausente ou ilegível'], veredito: 'sem_id',
        });
        continue;
      }

      // O SIGA traz `DscMuninicpios` como "Cidade - UF" MESMO quando também existe
      // uma coluna de UF separada (`SigUFPrincipal`) — sem isso o texto duplica
      // ("Nova Lima - MG/MG" na tela). Por isso o split roda sempre que o texto
      // parece combinado, não só quando falta a coluna de UF.
      const municipioTexto = (b.municipio || '').trim();
      const combinado = /-\s*[A-Za-z]{2}$/.test(municipioTexto) ? splitMunicipioUF(municipioTexto) : null;

      for (let i = 0; i < donos.length; i++) {
        const dono = donos[i];
        const item = { _linha: b._linha, bruto: b, erros: [] };
        const cod = (b.cod_empreendimento || '').trim()
          ? `${b.cod_empreendimento.trim()}${donos.length > 1 ? `-${i + 1}` : ''}`
          : `${dono.cnpj}-${slug(b.municipio)}-${slug(b.dt_conexao)}-${b._linha}-${i}`;
        if (vistos.has(cod)) {
          itens.push({ ...item, veredito: 'duplicado_lote', detalhe: 'código repetido no arquivo' });
          continue;
        }
        vistos.add(cod);

        item.usina = {
          cod_empreendimento: cod,
          cnpj: dono.cnpj,
          titular: dono.titular,
          tipo_consumidor: 'PJ',
          distribuidora_nome: (b.distribuidora_nome || '').trim() || null,
          distribuidora_cnpj: normCnpj(b.distribuidora_cnpj) || null,
          concessionaria_codigo: b.distribuidora_nome ? await casarConcessionaria(b.distribuidora_nome) : null,
          uf: (b.uf || '').trim().toUpperCase().slice(0, 2) || combinado?.uf || null,
          municipio: (combinado?.municipio || b.municipio || '').trim() || null,
          cep: (b.cep || '').replace(/\D/g, '').slice(0, 8) || null,
          potencia_kw: parseNum(b.potencia_kw),
          tipo_geracao: (b.tipo_geracao || '').trim().toUpperCase() || null,
          porte: (b.porte || '').trim() || null,
          modalidade: (b.modalidade || '').trim() || null,
          classe_consumo: (b.classe_consumo || '').trim() || null,
          dt_conexao: parseData(b.dt_conexao),
          fase_usina: (b.fase_usina || '').trim() || null,
          fonte: b.fase_usina || b.proprietario_regime ? 'aneel_siga' : 'aneel_gd',
          ingerido_em: new Date().toISOString(),
        };
        if (dono.regime) item.usina.modalidade = item.usina.modalidade || dono.regime;
        if (!item.usina.concessionaria_codigo && item.usina.distribuidora_nome) {
          item.avisoConc = item.usina.distribuidora_nome;
        }
        item.veredito = 'novo';
        itens.push(item);
      }
    }
    return { tipo: 'aneel', itens };
  }

  const digitsLen = (v) => String(v).replace(/\D/g, '').length;

  /* ═══════════ Etapa 3 — prévia ═══════════ */

  const VEREDITOS = {
    novo: { label: 'NOVO', cor: 'verde' },
    duplicado: { label: 'JÁ EXISTE', cor: 'ambar' },
    duplicado_lote: { label: 'REPETIDO NO ARQUIVO', cor: 'ambar' },
    sem_id: { label: 'SEM IDENTIFICADOR', cor: 'vermelho' },
    suprimido: { label: 'OPT-OUT', cor: 'vermelho' },
    pf: { label: 'PF — IGNORADO', cor: 'cinza' },
    atualiza: { label: 'ATUALIZA', cor: 'azul' },
    inativa: { label: 'NÃO ATIVA', cor: 'cinza' },
  };

  function etapaPrevia() {
    const { itens, tipo } = estado.analise;
    const cont = {};
    for (const i of itens) cont[i.veredito] = (cont[i.veredito] || 0) + 1;

    // duplicado de OUTRO agente nunca é mesclado nem recriado: o lead não é do usuário
    const aproveitaveis = itens.filter((i) => i.veredito === 'novo' || i.veredito === 'atualiza'
      || (i.veredito === 'duplicado' && !i.dup?.alheio && estado.acaoDup !== 'ignorar'));

    const colunas = tipo === 'lead'
      ? [
        {
          titulo: 'Veredito',
          largura: '190px',
          render: (i) => h('div', { class: 'cel-principal' },
            badge(VEREDITOS[i.veredito]?.label || i.veredito, VEREDITOS[i.veredito]?.cor || 'cinza'),
            i.detalhe ? h('span', {}, i.detalhe) : null,
            i.erros.length ? h('span', { class: 'texto-erro' }, i.erros.join(' · ')) : null),
        },
        { titulo: 'Razão social / contato', render: (i) => (i.lead?.razao_social || i.lead?.contato_nome || i.bruto.razao_social || '—') },
        { titulo: 'CNPJ', largura: '145px', render: (i) => maskCnpj(i.lead?.cnpj || '') || '—' },
        { titulo: 'Telefone', largura: '130px', render: (i) => maskFone(i.lead?.telefone || '') || '—' },
        { titulo: 'E-mail', largura: '180px', render: (i) => i.lead?.email || '—' },
        { titulo: 'Status', largura: '110px', render: (i) => (i.lead ? statusLabel(i.lead.status) : '—') },
        { titulo: 'Dono', largura: '120px', render: (i) => (i.lead ? nomeDe(i.lead.owner_id) : '—') },
        { titulo: 'Concessionária', largura: '140px', render: (i) => i.lead?.concessionaria_codigo || i.lead?.concessionaria_raw || '—' },
      ]
      : tipo === 'cnpj'
        ? [
          {
            titulo: 'Veredito',
            largura: '200px',
            render: (i) => h('div', { class: 'cel-principal' },
              badge(VEREDITOS[i.veredito]?.label || i.veredito, VEREDITOS[i.veredito]?.cor || 'cinza'),
              i.detalhe ? h('span', {}, i.detalhe) : null,
              i.erros.length ? h('span', { class: 'texto-erro' }, i.erros.join(' · ')) : null),
          },
          { titulo: 'Razão social', render: (i) => i.empresa?.razao_social || i.bruto.razao_social || '—' },
          { titulo: 'CNPJ', largura: '145px', render: (i) => maskCnpj(i.empresa?.cnpj || '') || '—' },
          { titulo: 'Município/UF', largura: '160px', render: (i) => [i.empresa?.municipio_sede, i.empresa?.uf_sede].filter(Boolean).join('/') || '—' },
          { titulo: 'CNAE', largura: '110px', render: (i) => i.empresa?.cnae_principal || '—' },
          { titulo: 'Telefone', largura: '130px', render: (i) => maskFone(i.empresa?.telefone1 || '') || '—' },
          { titulo: 'E-mail', largura: '190px', render: (i) => i.empresa?.email || '—' },
        ]
        : [
        {
          titulo: 'Veredito',
          largura: '180px',
          render: (i) => h('div', { class: 'cel-principal' },
            badge(VEREDITOS[i.veredito]?.label || i.veredito, VEREDITOS[i.veredito]?.cor || 'cinza'),
            i.detalhe ? h('span', {}, i.detalhe) : null,
            i.erros.length ? h('span', { class: 'texto-erro' }, i.erros.join(' · ')) : null),
        },
        { titulo: 'Titular', render: (i) => i.usina?.titular || '—' },
        { titulo: 'CNPJ', largura: '145px', render: (i) => maskCnpj(i.usina?.cnpj || '') || '—' },
        { titulo: 'Distribuidora', largura: '160px', render: (i) => i.usina?.concessionaria_codigo || i.usina?.distribuidora_nome || '—' },
        { titulo: 'Potência', largura: '95px', alinha: 'dir', render: (i) => fmtNum(i.usina?.potencia_kw, 2) },
        { titulo: 'Geração', largura: '110px', render: (i) => TIPOS_GERACAO[i.usina?.tipo_geracao] || i.usina?.tipo_geracao || '—' },
        { titulo: 'Cidade/UF', largura: '150px', render: (i) => [i.usina?.municipio, i.usina?.uf].filter(Boolean).join('/') || '—' },
        { titulo: 'Conexão', largura: '100px', render: (i) => fmtData(i.usina?.dt_conexao) || '—' },
        ];

    const rejeitadas = itens.filter((i) => i.veredito === 'sem_id' || i.erros.length);
    const semConc = itens.filter((i) => i.avisoConc).length;
    const semAutor = itens.filter((i) => i.avisoAutor).length;

    return card(
      h('div', { class: 'card__cabeca' },
        h('h2', {}, 'Prévia'),
        h('button', { class: 'btn btn--mini btn--fantasma', onclick: () => { estado.analise = null; desenhar(); } },
          'Voltar ao mapeamento')),
      h('div', { class: 'kpis kpis--fina' },
        kpi('Total de linhas', fmtNum(itens.length)),
        kpi(tipo === 'cnpj' ? 'Serão gravadas' : 'Serão criados', fmtNum(aproveitaveis.length),
          tipo === 'cnpj' ? `${fmtNum(cont.novo || 0)} novas · ${fmtNum(cont.atualiza || 0)} atualizam` : null),
        tipo === 'cnpj'
          ? kpi('Leads a criar', fmtNum(itens.filter((i) => i.vaiViraLead).length), estado.criarLeads ? 'na lista desta importação' : 'desligado')
          : null,
        kpi('Já existem', fmtNum((cont.duplicado || 0) + (cont.duplicado_lote || 0)),
          estado.acaoDup === 'ignorar' ? 'serão ignorados' : `ação: ${estado.acaoDup}`),
        kpi('Rejeitados', fmtNum(rejeitadas.length)),
        cont.suprimido ? kpi('Bloqueados por opt-out', fmtNum(cont.suprimido)) : null,
        cont.pf ? kpi(tipo === 'cnpj' ? 'Empresário individual' : 'Titulares PF', fmtNum(cont.pf), 'fora do recorte') : null,
        cont.inativa ? kpi('Não ativas', fmtNum(cont.inativa), 'ignoradas') : null),
      (tipo === 'lead' || (tipo === 'cnpj' && estado.criarLeads))
        ? h('label', { class: 'campo' },
          h('span', {}, 'Nome da lista'),
          h('input', {
            type: 'text', value: estado.nomeLista, placeholder: nomePadraoLista(), maxlength: '120',
            oninput: (e) => { estado.nomeLista = e.target.value; },
          }),
          h('small', {}, 'Os leads criados entram nesta lista — depois dá para abri-la, renomeá-la ou excluí-la em Listas.'))
        : null,
      semConc || semAutor
        ? h('p', { class: 'aviso' },
          semConc ? `${semConc} linha(s) com distribuidora não reconhecida — vão para concessionaria_raw (fail-open). ` : '',
          semAutor ? `${semAutor} linha(s) com autor desconhecido — vão para o dono padrão.` : '')
        : null,
      tabela({
        colunas,
        linhas: itens.slice(0, 300),
        chave: (i) => String(i._linha),
        aoAbrir: () => {},
      }),
      itens.length > 300 ? h('p', { class: 'texto-fraco ta-centro' }, `Mostrando 300 de ${fmtNum(itens.length)} linhas.`) : null,
      h('div', { class: 'linha-botoes' },
        h('button', {
          class: 'btn btn--primario',
          disabled: aproveitaveis.length === 0 && estado.acaoDup !== 'mesclar',
          onclick: gravar,
        }, tipo === 'lead' ? `Importar ${fmtNum(aproveitaveis.length)} lead(s)`
          : tipo === 'cnpj' ? `Gravar ${fmtNum(aproveitaveis.length)} empresa(s)` : `Importar ${fmtNum(aproveitaveis.length)} usina(s)`),
        rejeitadas.length
          ? h('button', { class: 'btn', onclick: () => baixarRejeitadas(rejeitadas) },
            `Baixar ${fmtNum(rejeitadas.length)} rejeitada(s)`)
          : null),
    );
  }

  function baixarRejeitadas(rejeitadas) {
    const cab = [...estado.cabecalho, 'Motivo da rejeição'];
    const linhas = rejeitadas.map((r) => [
      ...estado.linhas[r._linha] || [],
      r.erros.join(' · ') || r.detalhe || 'rejeitada',
    ]);
    baixar(paraCSV(cab, linhas), nomeArquivo('rejeitadas', perfil.nome, 'csv'));
  }

  /* ═══════════ Gravação ═══════════ */

  async function gravar() {
    const { itens, tipo } = estado.analise;
    const prog = barraProgresso('gravando…');
    const { modal } = await import('../ui.js');
    const { fechar } = modal({
      titulo: 'Importando',
      corpo: h('div', {}, h('p', { class: 'texto' }, 'Não feche a aba.'), prog.el),
      acoes: [],
    });

    const resumo = { total: itens.length, criados: 0, duplicados: 0, erros: 0, mesclados: 0, ignorados: 0 };
    const amostraErro = [];
    let loteLista = null; // lista desta importação (só no modo "leads"); criada ANTES dos leads

    try {
      if (tipo === 'aneel') {
        const usinas = itens.filter((i) => i.veredito === 'novo').map((i) => i.usina);
        const passo = 500;
        for (let i = 0; i < usinas.length; i += passo) {
          await putMuitos('usina_aneel', usinas.slice(i, i + passo));
          prog.atualizar(i + passo, usinas.length, `usinas: ${Math.min(i + passo, usinas.length)}/${usinas.length}`);
        }
        resumo.criados = usinas.length;
        resumo.erros = itens.filter((i) => i.veredito === 'sem_id').length;
        resumo.duplicados = itens.filter((i) => i.veredito === 'duplicado_lote').length;
        resumo.ignorados = itens.filter((i) => i.veredito === 'pf').length;
        prog.atualizar(1, 1, 'agregando empresas por CNPJ…');
        const nEmp = await agregarEmpresas();
        resumo.empresas = nEmp;
      } else if (tipo === 'cnpj') {
        const aGravar = itens.filter((i) => i.veredito === 'novo' || i.veredito === 'atualiza');
        if (estado.criarLeads) {
          loteLista = await registrarLote({
            tipo: estado.fonteTipo, agente_id: perfil.id, arquivo: estado.nomeArquivoOrigem,
            nome: nomeDaLista(), total: itens.length, criados: 0, duplicados: 0, erros: 0,
          });
        }
        const passo = 500;
        for (let i = 0; i < aGravar.length; i += passo) {
          await putMuitos('empresa', aGravar.slice(i, i + passo).map((x) => x.empresa));
          prog.atualizar(Math.min(i + passo, aGravar.length), aGravar.length, `empresas: ${Math.min(i + passo, aGravar.length)}/${aGravar.length}`);
        }
        resumo.criados = aGravar.filter((i) => i.veredito === 'novo').length;
        resumo.mesclados = aGravar.length - resumo.criados;
        resumo.erros = itens.filter((i) => i.veredito === 'sem_id').length;
        resumo.duplicados = itens.filter((i) => i.veredito === 'duplicado_lote' || i.jaTemLead).length;
        resumo.ignorados = itens.filter((i) => ['pf', 'inativa', 'suprimido'].includes(i.veredito)).length;
        if (loteLista) {
          let leadsCriados = 0;
          for (const it of aGravar.filter((x) => x.vaiViraLead)) {
            const e = it.empresa;
            try {
              await criarLead({
                cnpj: e.cnpj, razao_social: e.razao_social, origem: 'casa_dos_dados',
                origem_detalhe: `Base CNPJ · ${estado.nomeArquivoOrigem || 'importação'}`,
                telefone: e.telefone1 || null, telefone2: e.telefone2 || null, email: e.email || null,
                cidade: e.municipio_sede || null, uf: e.uf_sede || null, cep: e.cep || null,
                owner_id: estado.ownerPadrao, import_lote_id: loteLista.id, proxima_acao_em: hojeISO(),
              });
              leadsCriados++;
            } catch (err) {
              if (err.codigo !== '23505') { resumo.erros++; if (amostraErro.length < 10) amostraErro.push({ linha: it._linha + 1, motivo: err.message }); }
            }
          }
          resumo.leads = leadsCriados;
        }
      } else {
        // a lista nasce antes dos leads: cada um já é criado carimbado com o id dela
        loteLista = await registrarLote({
          tipo: estado.fonteTipo, agente_id: perfil.id, arquivo: estado.nomeArquivoOrigem,
          nome: nomeDaLista(), total: itens.length, criados: 0, duplicados: 0, erros: 0,
        });
        let feito = 0;
        for (const it of itens) {
          feito++;
          if (feito % 25 === 0) prog.atualizar(feito, itens.length);
          try {
            if (it.veredito === 'novo') {
              const novo = await criarLead({ ...it.lead, import_lote_id: loteLista.id });
              await talvezHistorico(novo, it);
              resumo.criados++;
            } else if (it.veredito === 'duplicado' && it.dup?.alheio) {
              resumo.duplicados++;
            } else if (it.veredito === 'duplicado' && estado.acaoDup === 'mesclar') {
              await mesclar(it);
              resumo.mesclados++;
            } else if (it.veredito === 'duplicado' && estado.acaoDup === 'criar') {
              const novo = await criarLead({ ...it.lead, cnpj: undefined, duplicado_de: it.dup.id, import_lote_id: loteLista.id });
              await talvezHistorico(novo, it);
              resumo.criados++;
            } else if (it.veredito === 'duplicado' || it.veredito === 'duplicado_lote') {
              resumo.duplicados++;
            } else {
              resumo.erros++;
              if (amostraErro.length < 10) {
                amostraErro.push({ linha: it._linha + 1, motivo: it.erros.join(' · ') || it.veredito });
              }
            }
          } catch (e) {
            resumo.erros++;
            if (amostraErro.length < 10) amostraErro.push({ linha: it._linha + 1, motivo: e.message });
          }
        }
      }

      const dadosLote = {
        tipo: estado.modo === 'aneel' ? 'aneel' : estado.fonteTipo,
        agente_id: perfil.id,
        arquivo: estado.nomeArquivoOrigem,
        total: resumo.total,
        criados: resumo.criados,
        duplicados: resumo.duplicados + resumo.mesclados,
        erros: resumo.erros,
        amostra_erro: amostraErro,
      };
      // modo leads: fecha a lista criada no início com os números finais; ANEEL: registra o log agora
      const lote = loteLista
        ? await put('import_lote', { ...loteLista, ...dadosLote, atualizado_em: new Date().toISOString() })
        : await registrarLote({
          ...dadosLote,
          nome: `${estado.modo === 'cnpj' ? 'Base CNPJ' : 'Base ANEEL'} — ${estado.nomeArquivoOrigem || 'importação'}`,
        });

      fechar();
      const partes = [`${fmtNum(resumo.criados)} criado(s)`];
      if (resumo.leads) partes.push(`${fmtNum(resumo.leads)} lead(s)`);
      if (resumo.mesclados) partes.push(`${resumo.mesclados} mesclado(s)`);
      if (resumo.duplicados) partes.push(`${resumo.duplicados} duplicado(s)`);
      if (resumo.erros) partes.push(`${resumo.erros} com erro`);
      if (resumo.empresas) partes.push(`${fmtNum(resumo.empresas)} empresa(s) agregada(s)`);
      toast(`Lote ${lote.id.slice(0, 8)}: ${partes.join(' · ')}`, 'ok', 8000);

      estado.linhas = [];
      estado.analise = null;
      estado.nomeLista = '';
      desenhar();
      if (estado.modo === 'aneel') setTimeout(() => navegar('descobrir'), 600);
      else if (estado.modo === 'cnpj') setTimeout(() => (loteLista && resumo.leads
        ? navegar('leads', { lista: loteLista.id, f: 'meus' })
        : navegar('descobrir', { sem_usina: '1' })), 600);
      else if (loteLista && resumo.criados) setTimeout(() => navegar('leads', { lista: loteLista.id, f: 'meus' }), 600);
    } catch (e) {
      fechar();
      const faltaColuna = /Could not find the .* column of 'empresa'/i.test(e.message);
      toast(`Falha na importação: ${e.message}${faltaColuna ? ' — falta rodar a migration 0008_empresa_cnpj_aberto.sql no Supabase (veja SETUP.md).' : ''}`, 'erro', 12000);
    }
  }

  /** A linha da planilha legada vira o primeiro toque do histórico. */
  async function talvezHistorico(lead, it) {
    if (!it.dataContato && !it.descricaoHistorica) return;
    await registrarInteracao({
      lead,
      agente_id: lead.owner_id,
      canal: 'outro',
      sentido: 'saida',
      resultado: null,
      status_apos: lead.status,
      descricao: it.descricaoHistorica || 'Contato importado da planilha',
      ocorrido_em: it.dataContato ? `${it.dataContato}T12:00:00.000Z` : undefined,
      proxima_acao_em: lead.proxima_acao_em,
    });
  }

  /** Mesclar preenche só o que está vazio — não sobrescreve trabalho de ninguém. */
  async function mesclar(it) {
    const atual = await get('lead', it.dup.id);
    if (!atual) return;
    const patch = { ...atual };
    for (const [k, v] of Object.entries(it.lead)) {
      if (v == null || v === '') continue;
      if (['owner_id', 'status', 'tentativas', 'proxima_acao_em', 'origem'].includes(k)) continue;
      if (patch[k] == null || patch[k] === '') patch[k] = v;
    }
    const salvo = await salvarLead(patch);
    await talvezHistorico(salvo, it);
  }

  /* ═══════════ Render ═══════════ */

  function desenhar() {
    const partes = [];
    if (!estado.linhas.length) partes.push(etapaEntrada());
    else if (!estado.analise) partes.push(etapaMapa());
    else partes.push(etapaPrevia());
    areaEtapas.replaceChildren(...partes);
  }

  raiz.append(
    cabecalhoPagina('Importar',
      'Colar tabela, arrastar arquivo ou (fase 3) capturar pela extensão — sempre com a mesma prévia'),
    areaEtapas);
  desenhar();
  return raiz;
}
