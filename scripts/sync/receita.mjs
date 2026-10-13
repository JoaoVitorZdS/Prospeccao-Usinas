// receita.mjs — etapa "receita" do `pnpm sincronizar`: cadastro de CNPJ da Receita Federal → tabela `empresa`.
//
//   1. lista os CNPJs dos DONOS de usina (vêm da etapa ANEEL, ou do banco);
//   2. baixa os zips da Receita (retomável) e carrega num SQLite local — a lista de donos ENTRA INTEIRA (o dono de
//      uma usina é de qualquer ramo), somada a quem tem os CNAEs de energia;
//   3. exporta o CSV no formato do app e o grava em `empresa` com a MESMA lógica da tela "Importar → Base CNPJ".
//
// Sem Casa dos Dados: é a própria fonte aberta da Receita (ver mcp/README.md e doc/LIA-legitimo-interesse.md).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAMPOS_CNPJ, converterLinhasCnpj, classificarLinhasCnpj, gruposParaGravar } from '../../js/cnpj-importacao.js';
import { autoMapear, aplicarMapa, decodificar, parseTexto } from '../../js/parse.js';
import * as db from '../../js/db.js';

const LOTE_IMPORTACAO = 2000; // linhas do CSV analisadas por vez (cada lote consulta `empresa` em fatias de 300)
export const CNAES_PADRAO = ['geracao', 'comercializacao'];

/** O pacote `mcp/` é carregado só quando a etapa roda (traz `node:sqlite`). */
async function carregarMcp() {
  const [baixar, carregar, exportar, cnaes, banco] = await Promise.all([
    import('../../mcp/etl/baixar.mjs'), import('../../mcp/etl/carregar.mjs'), import('../../mcp/etl/exportar.mjs'),
    import('../../mcp/src/cnaes.mjs'), import('../../mcp/src/banco.mjs'),
  ]);
  return {
    baixar: baixar.baixar, planoDeDownload: baixar.planoDeDownload, carregar: carregar.carregar, exportar: exportar.exportar,
    resolverCnaes: cnaes.resolverCnaes, pastaDados: banco.PASTA_DADOS,
  };
}

/** CNPJs de quem tem usina (`empresa.qtd_usinas > 0`). Paginado com ORDER BY: sem ele a paginação pode pular linhas. */
export async function cnpjsDeDonos() {
  const sb = await db.abrir();
  const donos = new Set();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb.from('empresa').select('cnpj').gt('qtd_usinas', 0).order('cnpj').range(desde, desde + 999);
    if (error) throw new Error(`Não consegui listar os donos de usina: ${error.message}`);
    for (const r of data) donos.add(r.cnpj);
    if (data.length < 1000) break;
  }
  return donos;
}

/** A competência baixada mais recente em `<raiz>/AAAA-MM`, ou null. */
export function competenciaMaisRecente(raiz) {
  if (!existsSync(raiz)) return null;
  return readdirSync(raiz).filter((n) => /^\d{4}-\d{2}$/.test(n)).sort().at(-1) || null;
}

/**
 * Importa o texto de um CSV da Base CNPJ para `empresa`. Mesma decisão da tela: PF/MEI, inativas, repetidas e
 * opt-out ficam de fora; quem já existe é MESCLADO (o que veio vazio não apaga telefone/e-mail enriquecidos).
 * Fora do --dry-run grava em lotes, novas e existentes separadas (ver `gruposParaGravar`).
 */
export async function importarCsvReceita({ texto, competencia, dryRun, log, passo = LOTE_IMPORTACAO, deps = {} }) {
  const [cabecalho, ...linhas] = parseTexto(texto);
  if (!cabecalho) throw new Error('O CSV da Receita está vazio.');
  const mapa = autoMapear(cabecalho, CAMPOS_CNPJ);
  if (mapa.cnpj == null) throw new Error('O CSV não tem coluna de CNPJ — não parece uma exportação da Base CNPJ.');
  const supressao = await (deps.carregarSupressao || db.carregarSupressao)();
  const buscar = deps.empresasPorCnpj || db.empresasPorCnpj;
  const gravar = deps.gravar || db.putMuitos;

  const r = { linhas: linhas.length, novas: 0, atualizadas: 0, pf: 0, inativas: 0, suprimidas: 0, semId: 0, repetidas: 0, bytes: 0, estimativaMB: 0 };
  for (let i = 0; i < linhas.length; i += passo) {
    const brutos = aplicarMapa(linhas.slice(i, i + passo), mapa).map((b) => ({ ...b, _linha: b._linha + i }));
    const conv = converterLinhasCnpj(brutos, { competencia });
    const cnpjs = conv.map(({ r: x }) => x.empresa?.cnpj).filter(Boolean);
    const existentes = new Map((await buscar(cnpjs)).map((e) => [e.cnpj, e]));
    const { itens } = classificarLinhasCnpj(conv, { supressao, existentes });
    const { novos, atualizados } = gruposParaGravar(itens);
    if (!dryRun) {
      if (novos.length) await gravar('empresa', novos);
      if (atualizados.length) await gravar('empresa', atualizados);
    }
    r.novas += novos.length;
    r.atualizadas += atualizados.length;
    for (const [k, it] of itens.entries()) {
      // espaço: linha nova ocupa o cabeçalho + os campos + os índices; existente só ganha os campos que vieram (teto)
      if (it.veredito === 'novo') r.bytes += BYTES_CABECALHO_E_INDICES + bytesDaEmpresa(conv[k].r.empresa);
      else if (it.veredito === 'atualiza') r.bytes += bytesDaEmpresa(conv[k].r.empresa);
      if (it.veredito === 'pf') r.pf++;
      else if (it.veredito === 'inativa') r.inativas++;
      else if (it.veredito === 'suprimido') r.suprimidas++;
      else if (it.veredito === 'sem_id') r.semId++;
      else if (it.veredito === 'duplicado_lote') r.repetidas++;
    }
    log(`  empresas: ${Math.min(i + passo, linhas.length).toLocaleString('pt-BR')}/${linhas.length.toLocaleString('pt-BR')} linhas${dryRun ? ' (simulado)' : ''}`);
  }
  r.estimativaMB = r.bytes / 1048576;
  return r;
}

// Cabeçalho de tupla do Postgres (24 B) + chave primária e demais índices de uma linha nova (~100 B) — estimativa.
const BYTES_CABECALHO_E_INDICES = 124;

/** Bytes de dado de uma empresa (só os campos preenchidos): texto pelo tamanho, número 8 B, lista = itens + 4 B cada. */
export function bytesDaEmpresa(e) {
  const valor = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return 8;
    if (typeof v === 'boolean') return 1;
    if (Array.isArray(v)) return v.reduce((s, x) => s + valor(x) + 4, 4);
    if (typeof v === 'object') return Buffer.byteLength(JSON.stringify(v));
    return Buffer.byteLength(String(v));
  };
  return Object.values(e || {}).reduce((s, v) => s + valor(v), 0);
}

/**
 * Etapa completa. `opcoes`: { competencia, uf, cnae, soDonos, semDownload, apagarZips, csv, baixarReceita }.
 * `deps` (testes): { mcp, cnpjsDeDonos, importar }.
 */
export async function sincronizarReceita({ pasta, perfil, dryRun, donos, opcoes = {}, log, deps = {} }) {
  const dir = resolve(pasta, 'receita');
  mkdirSync(dir, { recursive: true });
  const info = { competencia: opcoes.competencia || null, carga: null, exportacao: null };
  let arquivoCsv = opcoes.csv ? resolve(opcoes.csv) : null;

  if (!arquivoCsv) {
    const mcp = deps.mcp || await carregarMcp();
    const lista = donos?.size ? donos : await (deps.cnpjsDeDonos || cnpjsDeDonos)();
    log(`Receita: ${lista.size.toLocaleString('pt-BR')} donos de usina conhecidos`);
    if (opcoes.soDonos && !lista.size) {
      throw new Error('--so-donos pede só os donos de usina, mas não há nenhum no banco. Rode a etapa "aneel" antes.');
    }

    // ── baixar ──
    const raizDownloads = resolve(mcp.pastaDados, 'downloads');
    let competencia = opcoes.competencia;
    let pastaZips;
    if (opcoes.semDownload) {
      competencia = competencia || competenciaMaisRecente(raizDownloads);
      pastaZips = competencia && resolve(raizDownloads, competencia);
      if (!pastaZips || !existsSync(pastaZips)) throw new Error('--sem-download, mas não há competência baixada em mcp/dados/downloads. Rode sem essa opção.');
    } else if (dryRun && !opcoes.baixarReceita) {
      // A simulação não deve gastar ~30 min e ~6 GB sem avisar: só mostra o que falta. Se tudo já está no disco, segue.
      const plano = await mcp.planoDeDownload({ competencia, destino: raizDownloads, semSocios: true });
      info.competencia = plano.competencia;
      if (plano.faltamBytes > 0) {
        const gb = (plano.faltamBytes / 1073741824).toFixed(2).replace('.', ',');
        log(`Receita: SIMULAÇÃO — faltam ${gb} GB (${plano.arquivos.length - plano.completos} de ${plano.arquivos.length} arquivos) para baixar; não vou baixar na simulação.`);
        log('         Para incluir o download: --dry-run --baixar-receita · para gravar de verdade: sem --dry-run.');
        return { ...info, pulada: true, faltamBytes: plano.faltamBytes, totalBytes: plano.totalBytes, donos: lista.size, resumo: null };
      }
      competencia = plano.competencia;
      pastaZips = plano.pasta;
    } else {
      log('Receita: baixando os arquivos (retomável; a primeira vez leva ~30 min e ~6 GB)');
      const b = await mcp.baixar({ competencia, destino: raizDownloads, semSocios: true });
      competencia = b.competencia;
      pastaZips = b.pasta;
    }
    info.competencia = competencia;

    // ── carregar (filtrar na entrada) ──
    const soDonos = !!opcoes.soDonos;
    // UF sozinha NUNCA vale: seriam milhões de empresas de qualquer ramo — sem --cnae, entra o padrão de energia
    const cnaeLista = soDonos ? null : (opcoes.cnae ? opcoes.cnae.split(',').map((x) => x.trim()).filter(Boolean) : CNAES_PADRAO);
    const ufs = soDonos || !opcoes.uf ? null : new Set(opcoes.uf.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
    const banco = resolve(dir, 'cnpj.sqlite');
    log(`Receita: carregando ${competencia} — ${soDonos ? 'só os donos de usina' : `donos + CNAE ${cnaeLista ? cnaeLista.join('/') : 'qualquer'}${ufs ? ` em ${[...ufs].join(',')}` : ''}`}`);
    info.carga = await mcp.carregar({
      pasta: pastaZips, competencia, saida: banco, comSocios: false,
      cnaes: cnaeLista ? mcp.resolverCnaes(cnaeLista) : null, ufs,
      cnpjs: lista.size ? lista : null, uniao: lista.size > 0,
    });

    // ── exportar ──
    arquivoCsv = resolve(dir, 'receita.csv');
    info.exportacao = mcp.exportar({ banco, saida: arquivoCsv });
    log(`Receita: ${info.exportacao.linhas.toLocaleString('pt-BR')} empresas exportadas`);
    if (opcoes.apagarZips) { rmSync(pastaZips, { recursive: true, force: true }); log('Receita: zips apagados.'); }
  }

  // ── importar ──
  log(`Receita: ${dryRun ? 'simulando a gravação' : 'gravando'} em empresa`);
  const texto = decodificar(readFileSync(arquivoCsv)).replace(/^\uFEFF/, '');
  const importar = deps.importar || importarCsvReceita;
  const resumo = await importar({ texto, competencia: info.competencia || undefined, dryRun, log });
  if (!dryRun) {
    await db.registrarLote({
      tipo: 'planilha', agente_id: perfil.id, arquivo: arquivoCsv.split(/[\\/]/).pop(),
      nome: `Base CNPJ — sincronização ${info.competencia || new Date().toISOString().slice(0, 7)}`,
      total: resumo.linhas, criados: resumo.novas, duplicados: resumo.atualizadas + resumo.repetidas,
      erros: resumo.semId,
    });
  }
  return { ...info, resumo };
}
