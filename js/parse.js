// parse.js — entrada de dados.
//
// Três portas, um só parser e uma só prévia (seção 7.D):
//   1. colar          → `text/html` do clipboard (a tabela estruturada)
//   2. arrastar CSV   → parseCSV do util.js, com detecção de separador e encoding
//   3. arrastar XLSX  → leitor próprio (ZIP + DecompressionStream + DOMParser)
//
// O XLSX é lido sem SheetJS de propósito: o plano previa vendorar o `.tgz` porque
// o pacote npm está congelado em 0.18.5; num app autocontido a dependência some
// inteira. Cobre o que uma planilha de prospecção usa — sharedStrings, inline
// strings, números, booleanos e datas (via numFmt).

import { parseCSV, detectarSep, slug } from './util.js';

/* ═══════════════ Texto: encoding ═══════════════ */

/** UTF-8 por padrão; cai para windows-1252 se aparecer caractere de substituição. */
export function decodificar(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const ruins = (utf8.match(/�/g) || []).length;
  if (ruins === 0) return utf8;
  try {
    const alt = new TextDecoder('windows-1252').decode(buffer);
    return (alt.match(/�/g) || []).length < ruins ? alt : utf8;
  } catch {
    return utf8;
  }
}

/* ═══════════════ Tabela colada (text/html) ═══════════════ */

/**
 * Extrai a maior tabela do HTML do clipboard. Preserva o texto de cada célula e,
 * quando existe, o href do link (Casa dos Dados e LinkedIn escondem dado útil ali).
 */
export function parseTabelaHTML(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tabelas = [...doc.querySelectorAll('table')];
  if (!tabelas.length) return null;
  const tabela = tabelas.sort((a, b) =>
    b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];

  const linhas = [];
  for (const tr of tabela.querySelectorAll('tr')) {
    const celulas = [...tr.querySelectorAll('th,td')].map((td) => {
      const txt = (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) return txt;
      const a = td.querySelector('a[href]');
      return a ? a.getAttribute('href') : '';
    });
    if (celulas.length) linhas.push(celulas);
  }
  const largura = Math.max(...linhas.map((l) => l.length));
  return linhas
    .map((l) => (l.length < largura ? [...l, ...Array(largura - l.length).fill('')] : l))
    .filter((l) => l.some((c) => c !== ''));
}

/** Colagem sem HTML: TSV/CSV solto. */
export const parseTexto = (txt) => parseCSV(txt, detectarSep(txt));

/* ═══════════════ XLSX ═══════════════ */

function lerZip(buffer) {
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  // End of Central Directory: assinatura 0x06054b50, varrida do fim
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Arquivo não é um ZIP/XLSX válido.');
  const nEntradas = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);

  const entradas = new Map();
  for (let i = 0; i < nEntradas; i++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(ptr + 10, true);
    const tamComp = dv.getUint32(ptr + 20, true);
    const nomeLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const comentLen = dv.getUint16(ptr + 32, true);
    const offLocal = dv.getUint32(ptr + 42, true);
    const nome = new TextDecoder('utf-8').decode(u8.subarray(ptr + 46, ptr + 46 + nomeLen));
    entradas.set(nome, { metodo, tamComp, offLocal });
    ptr += 46 + nomeLen + extraLen + comentLen;
  }
  return { dv, u8, entradas };
}

async function extrair(zip, nome) {
  const e = zip.entradas.get(nome);
  if (!e) return null;
  const { dv, u8 } = zip;
  if (dv.getUint32(e.offLocal, true) !== 0x04034b50) throw new Error('Cabeçalho local inválido no ZIP.');
  const nomeLen = dv.getUint16(e.offLocal + 26, true);
  const extraLen = dv.getUint16(e.offLocal + 28, true);
  const ini = e.offLocal + 30 + nomeLen + extraLen;
  const bruto = u8.subarray(ini, ini + e.tamComp);
  if (e.metodo === 0) return new TextDecoder('utf-8').decode(bruto);
  if (e.metodo !== 8) throw new Error(`Compressão ZIP não suportada (método ${e.metodo}).`);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Este navegador não suporta DecompressionStream. Exporte a planilha como CSV.');
  }
  const stream = new Blob([bruto]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

const colParaIndice = (ref) => {
  const letras = String(ref).match(/^[A-Z]+/)?.[0] || 'A';
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

const serialParaISO = (n) => {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 86400000);
  return isNaN(d) ? String(n) : d.toISOString().slice(0, 10);
};

/** numFmt embutidos que são data + formatos customizados com y/m/d. */
function estilosDeData(xmlStyles) {
  const datas = new Set();
  if (!xmlStyles) return datas;
  const doc = new DOMParser().parseFromString(xmlStyles, 'application/xml');
  const custom = new Map();
  for (const f of doc.getElementsByTagName('numFmt')) {
    const id = Number(f.getAttribute('numFmtId'));
    const cod = f.getAttribute('formatCode') || '';
    if (/[ymd]/i.test(cod) && !/\[/.test(cod)) custom.set(id, true);
  }
  const embutidos = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
  const xfs = doc.querySelector('cellXfs');
  if (!xfs) return datas;
  [...xfs.getElementsByTagName('xf')].forEach((xf, i) => {
    const id = Number(xf.getAttribute('numFmtId') || 0);
    if (embutidos.has(id) || custom.has(id)) datas.add(i);
  });
  return datas;
}

/** Lê a primeira planilha do arquivo (ou a de nome informado) como matriz de strings. */
export async function parseXLSX(buffer, nomeAba) {
  const zip = lerZip(buffer);

  // caminho da aba: workbook.xml → rels
  let caminho = 'xl/worksheets/sheet1.xml';
  let abas = [];
  const wb = await extrair(zip, 'xl/workbook.xml');
  if (wb) {
    const doc = new DOMParser().parseFromString(wb, 'application/xml');
    const rels = await extrair(zip, 'xl/_rels/workbook.xml.rels');
    const mapaRel = new Map();
    if (rels) {
      const rdoc = new DOMParser().parseFromString(rels, 'application/xml');
      for (const r of rdoc.getElementsByTagName('Relationship')) {
        mapaRel.set(r.getAttribute('Id'), r.getAttribute('Target'));
      }
    }
    abas = [...doc.getElementsByTagName('sheet')].map((s) => ({
      nome: s.getAttribute('name'),
      alvo: mapaRel.get(s.getAttribute('r:id') || s.getAttributeNS?.(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')),
    }));
    const escolhida = nomeAba ? abas.find((a) => a.nome === nomeAba) : abas[0];
    if (escolhida?.alvo) {
      caminho = escolhida.alvo.startsWith('/')
        ? escolhida.alvo.slice(1)
        : `xl/${escolhida.alvo.replace(/^\.?\//, '')}`;
    }
  }

  const shared = [];
  const ss = await extrair(zip, 'xl/sharedStrings.xml');
  if (ss) {
    const doc = new DOMParser().parseFromString(ss, 'application/xml');
    for (const si of doc.getElementsByTagName('si')) {
      let texto = '';
      for (const t of si.getElementsByTagName('t')) texto += t.textContent;
      shared.push(texto);
    }
  }

  const datas = estilosDeData(await extrair(zip, 'xl/styles.xml'));

  const xml = await extrair(zip, caminho);
  if (!xml) throw new Error('Não encontrei a planilha dentro do arquivo.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');

  const linhas = [];
  for (const row of doc.getElementsByTagName('row')) {
    const saida = [];
    for (const c of row.getElementsByTagName('c')) {
      const idx = colParaIndice(c.getAttribute('r') || '');
      const t = c.getAttribute('t');
      let valor = '';
      if (t === 'inlineStr') {
        for (const tt of c.getElementsByTagName('t')) valor += tt.textContent;
      } else {
        const v = c.getElementsByTagName('v')[0];
        const bruto = v ? v.textContent : '';
        if (t === 's') valor = shared[Number(bruto)] ?? '';
        else if (t === 'b') valor = bruto === '1' ? 'VERDADEIRO' : 'FALSO';
        else if (t === 'e') valor = '';
        else if (bruto !== '' && datas.has(Number(c.getAttribute('s') || -1)) && Number(bruto) > 1) {
          valor = serialParaISO(bruto);
        } else valor = bruto;
      }
      while (saida.length < idx) saida.push('');
      saida[idx] = String(valor).trim();
    }
    linhas.push(saida);
  }
  const largura = Math.max(0, ...linhas.map((l) => l.length));
  return {
    abas: abas.map((a) => a.nome).filter(Boolean),
    linhas: linhas
      .map((l) => (l.length < largura ? [...l, ...Array(largura - l.length).fill('')] : l))
      .filter((l) => l.some((c) => c !== '')),
  };
}

/* ═══════════════ Arquivo → matriz ═══════════════ */

export async function lerArquivo(file) {
  const nome = (file.name || '').toLowerCase();
  if (nome.endsWith('.xlsx') || nome.endsWith('.xlsm')) {
    const { linhas, abas } = await parseXLSX(await file.arrayBuffer());
    return { linhas, abas, formato: 'xlsx' };
  }
  if (nome.endsWith('.xls')) {
    throw new Error('.xls antigo não é suportado. Salve como .xlsx ou CSV.');
  }
  if (nome.endsWith('.json')) {
    const dados = JSON.parse(decodificar(await file.arrayBuffer()));
    return { json: dados, formato: 'json' };
  }
  const texto = decodificar(await file.arrayBuffer());
  return { linhas: parseCSV(texto), formato: 'csv' };
}

/* ═══════════════ Mapeamento de colunas ═══════════════ */

/** Campos-alvo do import de LEAD. `aliases` são cabeçalhos já vistos em planilha real. */
export const CAMPOS_LEAD = [
  { campo: 'razao_social', label: 'Razão social / Nome', aliases: ['nome', 'razaosocial', 'razao', 'empresa', 'cliente', 'nomeempresa', 'nomefantasia', 'fantasia', 'titular'] },
  { campo: 'cnpj', label: 'CNPJ', aliases: ['cnpj', 'cnpjcpf', 'documento', 'numcpfcnpj', 'cnpjempresa'] },
  { campo: 'contato_nome', label: 'Nome do contato', aliases: ['contato', 'nomecontato', 'responsavel', 'pessoa', 'socio', 'nomedocontato'] },
  { campo: 'contato_cargo', label: 'Cargo do contato', aliases: ['cargo', 'funcao'] },
  { campo: 'telefone', label: 'Telefone', aliases: ['telefone', 'fone', 'celular', 'whatsapp', 'tel', 'telefone1', 'contatotelefone', 'numero'] },
  { campo: 'telefone2', label: 'Telefone 2', aliases: ['telefone2', 'fone2', 'celular2', 'telefonealternativo'] },
  { campo: 'email', label: 'E-mail', aliases: ['email', 'mail', 'correio', 'emailcontato'] },
  { campo: 'linkedin_url', label: 'LinkedIn', aliases: ['linkedin', 'linkedinurl', 'perfil'] },
  { campo: 'origem', label: 'Origem da prospecção', aliases: ['origem', 'origemdaprospeccao', 'fonte', 'canal', 'origemprospeccao'] },
  { campo: 'desenvolveu', label: 'Desenvolveu (Sim/Não)', aliases: ['desenvolveu', 'desenvolvido', 'convertido', 'fechou'] },
  { campo: 'status', label: 'Status', aliases: ['status', 'situacao', 'estagio', 'etapa'] },
  { campo: 'data_contato', label: 'Data do contato', aliases: ['datadocontato', 'data', 'datacontato', 'ultimocontato', 'dataabordagem'] },
  { campo: 'autor', label: 'Autor do contato', aliases: ['autordocontato', 'autor', 'agente', 'vendedor', 'responsavelcontato', 'consultor'] },
  { campo: 'concessionaria', label: 'Concessionária', aliases: ['concessionaria', 'distribuidora', 'nomagente', 'agente', 'energia'] },
  { campo: 'cep', label: 'CEP', aliases: ['cep', 'codcep', 'codigopostal'] },
  { campo: 'cidade', label: 'Cidade', aliases: ['cidade', 'municipio', 'nommunicipio', 'localidade'] },
  { campo: 'uf', label: 'UF', aliases: ['uf', 'estado', 'siguf'] },
  { campo: 'potencia_kwp', label: 'Potência (kW)', aliases: ['potencia', 'potenciakw', 'potenciakwp', 'kwp', 'kw', 'mdapotenciainstaladakw', 'potenciainstalada'] },
  { campo: 'descricao', label: 'Descrição do contato', aliases: ['descricaodocontato', 'descricao', 'observacao', 'obs', 'anotacao', 'comentario', 'historico'] },
  { campo: 'tipo', label: 'Tipo (usina/intermediador)', aliases: ['tipo', 'tipolead', 'perfil'] },
  { campo: 'proxima_acao_em', label: 'Próxima ação', aliases: ['proximaacao', 'retorno', 'followup', 'proximocontato'] },
];

/**
 * Campos-alvo do import da ANEEL (GD e SIGA). Aliases confirmados contra os
 * cabeçalhos REAIS dos dois datasets (baixados e inspecionados em 14/08/2026 —
 * ver etl/amostras/). Os dois arquivos têm nomes de coluna bem diferentes entre
 * si; a lista cobre ambos porque `autoMapear` casa por nome, não por posição.
 *
 * Duas armadilhas reais do SIGA que os aliases evitam:
 *   - `NomEmpreendimento` do SIGA NÃO é o nome do dono (vem abreviado tipo "E",
 *     "F") — por isso `titular` não tem um alias genérico "nome" que casaria
 *     por substring com "NomEmpreendimento". O nome de verdade só existe dentro
 *     de `DscPropriRegimePariticipacao` (ver `extrairProprietariosSiga` em
 *     aneel.js), que o import trata à parte, fora do autoMapear.
 *   - `MdaPotenciaOutorgadaKw` (concedida) aparece ANTES de
 *     `MdaPotenciaFiscalizadaKw` (auditada/real) no cabeçalho, e o autoMapear
 *     casa a primeira coluna que bater — por isso só a Fiscalizada tem alias
 *     aqui; a Outorgada fica de fora de propósito (o operador mapeia à mão se
 *     quiser).
 */
export const CAMPOS_ANEEL = [
  { campo: 'cod_empreendimento', label: 'Código do empreendimento', aliases: ['codempreendimento', 'codigoempreendimento', 'codgd', 'codceg', 'id'] },
  { campo: 'cnpj', label: 'CNPJ/CPF do titular', aliases: ['numcpfcnpj', 'cnpj', 'cpfcnpj', 'documento'] },
  { campo: 'titular', label: 'Titular', aliases: ['nomtitularempreendimento', 'nometitular', 'razaosocial'] },
  { campo: 'tipo_consumidor', label: 'Tipo de consumidor (PJ/PF)', aliases: ['sigtipoconsumidor', 'tipoconsumidor', 'tipo'] },
  { campo: 'distribuidora_nome', label: 'Distribuidora', aliases: ['nomagente', 'distribuidora', 'agente', 'concessionaria'] },
  { campo: 'distribuidora_cnpj', label: 'CNPJ da distribuidora', aliases: ['numcnpjdistribuidora', 'cnpjdistribuidora'] },
  { campo: 'uf', label: 'UF', aliases: ['siguf', 'sigufprincipal', 'uf', 'estado'] },
  { campo: 'municipio', label: 'Município', aliases: ['nommunicipio', 'dscmuninicpios', 'municipio', 'cidade'] },
  { campo: 'cep', label: 'CEP', aliases: ['codcep', 'cep'] },
  { campo: 'potencia_kw', label: 'Potência instalada (kW)', aliases: ['mdapotenciainstaladakw', 'mdapotenciafiscalizadakw', 'potenciainstalada', 'potencia', 'kw'] },
  { campo: 'tipo_geracao', label: 'Tipo de geração', aliases: ['sigtipogeracao', 'tipogeracao', 'fonte'] },
  { campo: 'porte', label: 'Porte', aliases: ['dscporte', 'porte'] },
  { campo: 'modalidade', label: 'Modalidade', aliases: ['dscmodalidadehabilitado', 'modalidade'] },
  { campo: 'classe_consumo', label: 'Classe de consumo', aliases: ['dscclasseconsumo', 'classeconsumo', 'classe'] },
  { campo: 'dt_conexao', label: 'Data de conexão', aliases: ['datentradaoperacao', 'dthatualizacadastralempreend', 'dtconexao', 'dataconexao', 'datconexao'] },
  { campo: 'fase_usina', label: 'Fase da usina (SIGA)', aliases: ['dscfaseusina', 'faseusina', 'fase'] },
  { campo: 'proprietario_regime', label: 'Proprietário/regime (SIGA)', aliases: ['dscpropriregimepariticipacao', 'dscproprietarioregime', 'proprietario'] },
];

/**
 * Auto-detecta o mapeamento pelo cabeçalho normalizado.
 * Match exato do alias vence; depois `startsWith`; depois `includes`.
 *
 * O laço de nível é o de FORA, não o de dentro do campo: isso garante que TODOS
 * os campos tenham a chance de casar exato antes de QUALQUER campo recorrer ao
 * substring fuzzy (nível 2). Com o nível dentro do campo, um alias curto e
 * genérico (ex.: "contato") podia "roubar" por substring a coluna de um campo
 * processado depois — ex.: "contato_nome" (processado antes) capturando a
 * coluna "Data do contato" (slug contém "contato") antes de "data_contato"
 * (processado depois) ter a chance de casar exato nela. Isso corrompia o
 * import: o script de abordagem saía com uma data no lugar do nome do contato.
 */
export function autoMapear(cabecalho, campos) {
  const mapa = {};
  const usados = new Set();
  const slugs = cabecalho.map(slug);

  for (const nivel of [0, 1, 2]) {
    for (const def of campos) {
      if (mapa[def.campo] != null) continue; // já resolvido num nível mais forte
      let achou = -1;
      for (let i = 0; i < slugs.length; i++) {
        if (usados.has(i) || !slugs[i]) continue;
        const s = slugs[i];
        const bate = def.aliases.some((a) =>
          (nivel === 0 && s === a)
          || (nivel === 1 && (s.startsWith(a) || a.startsWith(s)) && Math.min(s.length, a.length) >= 3)
          || (nivel === 2 && a.length >= 4 && s.includes(a)));
        if (bate) { achou = i; break; }
      }
      if (achou >= 0) { mapa[def.campo] = achou; usados.add(achou); }
    }
  }
  return mapa;
}

/** A 1ª linha é cabeçalho? Heurística: pouca coisa numérica e casa com algum alias. */
export function pareceCabecalho(linha, campos) {
  if (!linha) return false;
  const numericos = linha.filter((c) => /^[\d\s.,/-]+$/.test(String(c).trim()) && String(c).trim()).length;
  if (numericos > linha.length / 2) return false;
  const mapa = autoMapear(linha, campos);
  return Object.keys(mapa).length >= 2;
}

/** Aplica o mapeamento e devolve objetos com os nomes canônicos. */
export function aplicarMapa(linhas, mapa) {
  return linhas.map((linha, i) => {
    const obj = { _linha: i };
    for (const [campo, idx] of Object.entries(mapa)) {
      if (idx == null || idx < 0) continue;
      const v = linha[idx];
      obj[campo] = v == null ? '' : String(v).trim();
    }
    return obj;
  });
}
