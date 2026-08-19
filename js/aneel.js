// aneel.js — torna a ANEEL fácil para o operador (seção 2 do plano).
//
// Três coisas que este módulo resolve, todas verificadas contra dados reais
// baixados de dadosabertos.aneel.gov.br em 14/08/2026:
//
//   1. Os links diretos de download (GD e SIGA) ficam curados aqui — o operador
//      não precisa navegar o site da ANEEL para achar o arquivo certo.
//   2. O ZIP da GD (110 MB) é lido em STREAMING, direto no navegador: baixa
//      normalmente pelo link (isso não passa por CORS — é download de página,
//      não fetch), depois arrasta o .zip aqui. O app descompacta e filtra PJ
//      em tempo real, sem nunca materializar o CSV inteiro (~1 GB descomprimido)
//      na memória. Confirmado por medição: SEM CORS na API/downloads da ANEEL
//      (checado em 14/08/2026, header Access-Control-Allow-Origin ausente em
//      GET/OPTIONS/datastore_search) — então fetch() direto nunca funcionaria;
//      o download-por-link é o único caminho sem backend, e é isso que este
//      módulo aproveita.
//   3. O SIGA não tem coluna de CNPJ — o dono do empreendimento vem embutido
//      em texto livre na coluna `DscPropriRegimePariticipacao`, no formato
//      "50% para NOME - 12.345.678/0001-90 (REG), 50% para OUTRO - ... ".
//      `extrairProprietariosSiga` faz o parse disso (testado contra as 25.264
//      linhas reais do dump).

import { normCnpj, slug } from './util.js';

/* ═══════════════ Links diretos (curados, seção 2.1/2.2 do plano) ═══════════════ */
// IDs de recurso do CKAN mudam raramente. Se o link parar de funcionar, o
// `linkDataset` serve de fallback (leva à página onde a ANEEL republica).

export const RECURSOS_ANEEL = {
  gdZip: {
    label: 'Geração Distribuída — ZIP (todas as usinas, ~110 MB)',
    url: 'https://dadosabertos.aneel.gov.br/dataset/5e0fafd2-21b9-4d5b-b622-40438d40aba2/resource/b1bd71e7-d0ad-4214-9053-cbd58e9564a7/download/empreendimento-geracao-distribuida.zip',
    formato: 'zip', tamanhoAprox: '110 MB',
    descricao: 'Base completa: 4,6 milhões de linhas (PJ + PF). Baixe e arraste o .zip aqui — o app filtra PJ e descompacta sozinho.',
  },
  sigaCsv: {
    label: 'SIGA — usinas em construção/operação, com dono (CSV, ~10 MB)',
    url: 'https://dadosabertos.aneel.gov.br/datastore/dump/2f65a1b0-19b8-4360-8238-b34ab4693d55',
    formato: 'csv', tamanhoAprox: '~10 MB',
    descricao: '25 mil registros, inclui usinas que ainda nem entraram em operação — a lista mais quente. Baixe e arraste o CSV aqui.',
  },
  linkDataset: 'https://dadosabertos.aneel.gov.br/dataset/relacao-de-empreendimentos-de-geracao-distribuida',
  linkDatasetSiga: 'https://dadosabertos.aneel.gov.br/dataset/siga-sistema-de-informacoes-de-geracao-da-aneel',
};

/** Amostra real embutida no repo — dá para testar o fluxo sem baixar nada. */
export const AMOSTRAS = {
  gdZip: 'etl/amostras/aneel-gd-amostra.zip',
  sigaCsv: 'etl/amostras/aneel-siga-amostra.csv',
};

/* ═══════════════ Extração de CNPJ do SIGA ═══════════════ */

const RE_DONO = /([^,]+?)\s*-\s*(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\s*\(([A-Za-zÀ-ÿ]+)\)/g;
const RE_PREFIXO_PCT = /^\s*\d+([.,]\d+)?\s*%\s*para\s*/i;

/**
 * "50% para X - 11.222.333/0001-44 (REG), 50% para Y - ..." → [{nome, cnpj, regime}].
 * Testado contra as 25.264 linhas reais do dump do SIGA (14/08/2026): 24.962
 * delas trazem pelo menos um CNPJ nesse formato.
 */
export function extrairProprietariosSiga(texto) {
  if (!texto) return [];
  const out = [];
  const vistos = new Set();
  RE_DONO.lastIndex = 0;
  let m;
  while ((m = RE_DONO.exec(texto))) {
    const cnpj = normCnpj(m[2]);
    if (!cnpj || vistos.has(cnpj)) continue;
    vistos.add(cnpj);
    out.push({
      nome: m[1].replace(RE_PREFIXO_PCT, '').trim().replace(/^-+\s*/, ''),
      cnpj,
      regime: (m[3] || '').toUpperCase(),
    });
  }
  return out;
}

/** "Nova Lima - MG" → { municipio: 'Nova Lima', uf: 'MG' }. Campo combinado do SIGA. */
export function splitMunicipioUF(texto) {
  const m = String(texto || '').match(/^(.*?)\s*-\s*([A-Za-z]{2})$/);
  if (!m) return { municipio: texto || null, uf: null };
  return { municipio: m[1].trim() || null, uf: m[2].toUpperCase() };
}

/* ═══════════════ Parser CSV incremental (linha a linha, para streaming) ═══════════════ */
// Igual ao parseCSV de util.js na regra (RFC 4180, aspas duplicadas), mas
// alimentado em pedaços — nunca segura o texto inteiro na memória.

export function criarParserIncremental(sep) {
  let campo = '', linha = [], aspas = false, pendente = '';
  let sepDetectado = sep || null;

  function detectarSepDaLinha(l) {
    let melhor = ';', max = -1;
    for (const c of [';', ',', '\t']) {
      const n = (l.match(new RegExp(`\\${c}`, 'g')) || []).length;
      if (n > max) { max = n; melhor = c; }
    }
    return melhor;
  }

  function alimentar(chunk) {
    const t = pendente + chunk;
    pendente = '';
    const prontas = [];
    let i = 0;
    if (!sepDetectado) {
      const fimLinha = t.search(/\r\n|\n/);
      if (fimLinha < 0) { pendente = t; return prontas; }
      sepDetectado = detectarSepDaLinha(t.slice(0, fimLinha));
    }
    const s = sepDetectado;
    for (; i < t.length; i++) {
      const c = t[i];
      if (aspas) {
        if (c === '"') {
          if (t[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
        } else campo += c;
        continue;
      }
      if (c === '"') { aspas = true; continue; }
      if (c === s) { linha.push(campo); campo = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') {
        linha.push(campo); campo = '';
        if (linha.some((x) => x !== '')) prontas.push(linha);
        linha = [];
        continue;
      }
      campo += c;
    }
    // o que sobra depois do último \n (linha/campo/aspas em aberto) já fica retido
    // nas variáveis do closure — é isso que faz `alimentar` ser stateful entre chunks.
    return prontas;
  }

  function finalizar() {
    if (campo !== '' || linha.length) {
      linha.push(campo);
      const l = linha;
      linha = []; campo = '';
      if (l.some((x) => x !== '')) return [l];
    }
    return [];
  }

  return { alimentar, finalizar, get sep() { return sepDetectado; } };
}

/* ═══════════════ Leitura de ZIP local (File API, sem rede) ═══════════════ */

/**
 * Acha, no DIRETÓRIO CENTRAL do ZIP (não no cabeçalho local), a primeira entrada
 * .csv. Usar o diretório central — não o cabeçalho local — é o que garante o
 * tamanho comprimido correto: em ZIPs gravados em modo streaming (bit 3 do flag
 * geral ligado), o cabeçalho local pode trazer tamanho ZERO e só o diretório
 * central (ou o "data descriptor" logo após os dados) tem o valor real. Sem
 * isso, fatiar `file.slice(offset)` até o fim do arquivo inclui o próprio
 * diretório central depois do fluxo deflate — o DecompressionStream então
 * recebe bytes a mais e rejeita como "trailing junk" (ou, em navegadores mais
 * tolerantes, decodifica silenciosamente errado).
 */
async function acharEntradaCsv(file) {
  const CAUDA = Math.min(file.size, 1 << 20); // 1 MiB cobre até milhares de entradas
  const cauda = new Uint8Array(await file.slice(file.size - CAUDA).arrayBuffer());
  const dvCauda = new DataView(cauda.buffer);

  let eocd = -1;
  for (let i = cauda.length - 22; i >= 0; i--) {
    if (dvCauda.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Não encontrei o fim do diretório central do ZIP (arquivo corrompido ou não é ZIP).');

  const nEntradas = dvCauda.getUint16(eocd + 10, true);
  const offsetCDGlobal = dvCauda.getUint32(eocd + 16, true);
  const offsetCDNaCauda = offsetCDGlobal - (file.size - CAUDA);
  if (offsetCDNaCauda < 0) {
    throw new Error('ZIP grande demais para o leitor atual (diretório central fora da janela lida).');
  }

  let ptr = offsetCDNaCauda;
  for (let i = 0; i < nEntradas; i++) {
    if (dvCauda.getUint32(ptr, true) !== 0x02014b50) break;
    const metodo = dvCauda.getUint16(ptr + 10, true);
    const tamComp = dvCauda.getUint32(ptr + 20, true);
    const nomeLen = dvCauda.getUint16(ptr + 28, true);
    const extraLen = dvCauda.getUint16(ptr + 30, true);
    const comentLen = dvCauda.getUint16(ptr + 32, true);
    const offsetLocal = dvCauda.getUint32(ptr + 42, true);
    const nome = new TextDecoder('utf-8').decode(cauda.subarray(ptr + 46, ptr + 46 + nomeLen));
    if (/\.csv$/i.test(nome)) return { nome, metodo, tamComp, offsetLocal };
    ptr += 46 + nomeLen + extraLen + comentLen;
  }
  throw new Error('Não achei nenhum arquivo .csv dentro do ZIP.');
}

/** Lê o cabeçalho local só para achar onde os dados comprimidos começam (nome/extra têm tamanho variável). */
async function offsetDadosLocal(file, offsetLocal) {
  const buf = new Uint8Array(await file.slice(offsetLocal, offsetLocal + 4096).arrayBuffer());
  const dv = new DataView(buf.buffer);
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('Cabeçalho local do ZIP inválido no offset esperado.');
  const nomeLen = dv.getUint16(26, true);
  const extraLen = dv.getUint16(28, true);
  return offsetLocal + 30 + nomeLen + extraLen;
}

/**
 * Lê um .zip solto pelo usuário (File local — sem rede, sem CORS) e processa a
 * primeira entrada .csv em streaming: descompacta em pedaços via
 * DecompressionStream e entrega linhas já parseadas ao `onLinha`, sem nunca
 * montar o CSV inteiro em memória. `onLinha` devolve `false` para interromper.
 */
export async function lerZipCsvStream(file, { onCabecalho, onLinha, onProgresso } = {}) {
  const entrada = await acharEntradaCsv(file);
  if (entrada.metodo !== 8 && entrada.metodo !== 0) {
    throw new Error(`Compressão do ZIP não suportada (método ${entrada.metodo}). Reexporte como .zip padrão.`);
  }
  if (entrada.metodo === 8 && typeof DecompressionStream === 'undefined') {
    throw new Error('Este navegador não suporta descompressão em streaming. Use Chrome/Edge/Firefox recentes.');
  }

  const offsetDados = await offsetDadosLocal(file, entrada.offsetLocal);
  const bruto = file.slice(offsetDados, offsetDados + entrada.tamComp);
  const stream = entrada.metodo === 8
    ? bruto.stream().pipeThrough(new DecompressionStream('deflate-raw'))
    : bruto.stream();

  const parser = criarParserIncremental();
  const decoder = new TextDecoderStream('utf-8');
  const reader = stream.pipeThrough(decoder).getReader();

  let processado = 0;
  let cabecalho = null;
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    processado += value.length;
    total++;
    const linhas = parser.alimentar(value);
    for (const linha of linhas) {
      if (!cabecalho) { cabecalho = linha; onCabecalho?.(cabecalho); continue; }
      if (onLinha?.(linha) === false) { await reader.cancel(); return { interrompido: true, bytesLidos: processado }; }
    }
    if (total % 8 === 0) onProgresso?.({ bytesLidos: processado, bytesTotal: file.size });
  }
  const ultima = parser.finalizar();
  for (const linha of ultima) {
    if (!cabecalho) { cabecalho = linha; onCabecalho?.(cabecalho); continue; }
    onLinha?.(linha);
  }
  onProgresso?.({ bytesLidos: file.size, bytesTotal: file.size });
  return { interrompido: false, bytesLidos: processado, cabecalho };
}

/** Índice do CNPJ e do tipo de consumidor no cabeçalho, resolvido por nome (não por posição). */
export function indiceColuna(cabecalho, aliases) {
  const slugs = cabecalho.map(slug);
  for (const a of aliases) {
    const i = slugs.indexOf(a);
    if (i >= 0) return i;
  }
  for (const a of aliases) {
    const i = slugs.findIndex((s) => s.includes(a));
    if (i >= 0) return i;
  }
  return -1;
}
