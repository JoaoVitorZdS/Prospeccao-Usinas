#!/usr/bin/env node
// carregar.mjs — lê os zips da Receita e monta o SQLite local, FILTRANDO na entrada.
//
// A base completa tem ~60 milhões de estabelecimentos (só ~15% ativos). Carregar tudo ocuparia dezenas
// de GB; por isso o filtro acontece durante a leitura: só entra o que passa em TODOS os critérios.
//
//   node etl/carregar.mjs --cnae geracao,comercializacao --uf SP,MG
//   node etl/carregar.mjs --cnae 3511501 --baixar            # baixa antes, se faltar
//   node etl/carregar.mjs --cnpjs-arquivo donos-de-usina.csv # só os CNPJs de uma lista (ex.: base ANEEL)
//
// Passos (cada arquivo é lido em streaming, nunca inteiro na memória):
//   A. Estabelecimentos → filtra (situação, CNAE, UF, matriz, lista de CNPJ) e grava;
//   B. Empresas         → grava só as dos estabelecimentos mantidos (razão social, natureza, porte, capital);
//   C. limpeza          → tira empresário individual/MEI (pessoa física) — a menos que --incluir-ei;
//   D. Sócios           → só dos mantidos (nome, qualificação, entrada, faixa etária; CPF NÃO é guardado).
// O arquivo final é criado com nome temporário e só vira definitivo se tudo terminar bem.

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lerArgumentos, listaMaiuscula } from './args.mjs';
import { lerListaDeCnpjs } from '../src/lista.mjs';
import { linhasDoZip } from './zip.mjs';
import * as L from './layout.mjs';
import { baixar, listarCompetencias } from './baixar.mjs';
import { resolverCnaes } from '../src/cnaes.mjs';
import { criarBanco, emTransacao, INDICES, normalizarBusca, CAMINHO_PADRAO_DB, PASTA_DADOS } from '../src/banco.mjs';

const LOTE = 20000;                 // linhas por transação
const log = (...a) => console.error(...a);

/** O estabelecimento passa nos critérios de carga? (função pura — testada) */
export function passaNoFiltro(e, f) {
  if (!f.situacoes.has(e.situacao)) return false;
  if (f.soMatriz && !e.matriz) return false;
  if (f.ufs && !f.ufs.has(e.uf)) return false;
  if (f.cnpjs && !f.cnpjs.has(e.cnpj) && !f.cnpjs.has(e.cnpjBasico)) return false;
  if (f.cnaes) {
    const codigos = [e.cnaePrincipal, ...e.cnaesSecundarios].filter(Boolean);
    const bate = codigos.some((c) => f.cnaes.exatos.has(c) || [...f.cnaes.prefixos].some((p) => c.startsWith(p)));
    if (!bate) return false;
  }
  return true;
}

function arquivosDaFamilia(pasta, familia) {
  return readdirSync(pasta)
    .filter((n) => new RegExp(`^${familia}\\d+\\.zip$`).test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.zip$/)[1]) - Number(b.match(/(\d+)\.zip$/)[1]))
    .map((n) => resolve(pasta, n));
}

/** Tabelas auxiliares pequenas (CNAE, município, natureza, qualificação). */
async function carregarTabela(db, pasta, arquivo, sql, preparar) {
  const caminho = resolve(pasta, arquivo);
  if (!existsSync(caminho)) throw new Error(`Falta ${arquivo} em ${pasta}. Rode o download (--baixar).`);
  const ins = db.prepare(sql);
  let n = 0;
  const linhas = []; // linhasDoZip é assíncrono; a tabela é pequena, então juntamos antes de gravar
  for await (const l of linhasDoZip(caminho)) linhas.push(L.dividirLinha(l));
  emTransacao(db, () => {
    for (const c of linhas) {
      if (!L.cabe(c, 'tabela')) throw new Error(`${arquivo}: linha com ${c.length} colunas (esperado 2) — o layout da Receita mudou?`);
      ins.run(...preparar(c));
      n++;
    }
  });
  return n;
}

/**
 * Carrega a base. `opcoes`: { pasta, saida, competencia, cnaes (resolverCnaes), ufs:Set|null,
 * situacoes:Set, soMatriz, cnpjs:Set|null, incluirEI, comSocios }.
 */
export async function carregar({
  pasta, saida = CAMINHO_PADRAO_DB, competencia = '', cnaes = null, ufs = null, situacoes = new Set(['02']),
  soMatriz = false, cnpjs = null, incluirEI = false, comSocios = true,
}) {
  const inicio = Date.now();
  const temp = `${saida}.carregando`;
  rmSync(temp, { force: true });
  const db = criarBanco(temp);
  const filtro = { situacoes, soMatriz, ufs, cnpjs, cnaes };
  const stats = { lidos: 0, mantidos: 0, malformados: 0 };

  try {
    // ── tabelas auxiliares ──
    const nCnae = await carregarTabela(db, pasta, 'Cnaes.zip', 'insert or replace into cnae values (?, ?, ?)', (c) => [c[0], c[1], normalizarBusca(c[1])]);
    await carregarTabela(db, pasta, 'Municipios.zip', 'insert or replace into municipio values (?, ?, ?)', (c) => [c[0], c[1], normalizarBusca(c[1])]);
    await carregarTabela(db, pasta, 'Naturezas.zip', 'insert or replace into natureza values (?, ?)', (c) => [c[0], c[1]]);
    await carregarTabela(db, pasta, 'Qualificacoes.zip', 'insert or replace into qualificacao values (?, ?)', (c) => [c[0], c[1]]);
    log(`Tabelas auxiliares carregadas (${nCnae} CNAEs).`);

    // ── A. estabelecimentos ──
    const insEst = db.prepare(`insert or replace into estabelecimento values
      (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insCnae = db.prepare('insert or ignore into estab_cnae values (?, ?, ?)');
    const arqEst = arquivosDaFamilia(pasta, 'Estabelecimentos');
    if (!arqEst.length) throw new Error(`Nenhum Estabelecimentos*.zip em ${pasta}. Rode o download (--baixar).`);
    for (const arq of arqEst) {
      log(`A. ${arq.split(/[\\/]/).pop()} …`);
      let buffer = [];
      const descarregar = () => emTransacao(db, () => {
        for (const e of buffer) {
          insEst.run(e.cnpj, e.cnpjBasico, e.matriz ? 1 : 0, e.nomeFantasia, e.situacao, e.dataSituacao, e.abertura,
            e.cnaePrincipal, e.cnaesSecundarios.join(','), e.logradouro, e.numero, e.complemento, e.bairro, e.cep,
            e.uf, e.municipioCodigo, e.telefone1, e.telefone2 && e.telefone2 !== e.telefone1 ? e.telefone2 : null, e.email);
          if (e.cnaePrincipal) insCnae.run(e.cnpj, e.cnaePrincipal, 1);
          for (const c of e.cnaesSecundarios) insCnae.run(e.cnpj, c, 0);
        }
      });
      for await (const linha of linhasDoZip(arq)) {
        const cols = L.dividirLinha(linha);
        stats.lidos++;
        if (!L.cabe(cols, 'estabelecimento')) {
          stats.malformados++;
          if (stats.lidos > 1000 && stats.malformados / stats.lidos > 0.01) {
            throw new Error(`Mais de 1% das linhas de ${arq} não têm 30 colunas — o layout da Receita mudou. Abortando sem gravar.`);
          }
          continue;
        }
        const e = L.converterEstabelecimento(cols);
        if (!passaNoFiltro(e, filtro)) continue;
        buffer.push(e);
        stats.mantidos++;
        if (buffer.length >= LOTE) { descarregar(); buffer = []; }
        if (stats.lidos % 2000000 === 0) log(`   ${(stats.lidos / 1e6).toFixed(0)} mi lidos · ${stats.mantidos.toLocaleString('pt-BR')} mantidos`);
      }
      descarregar();
    }
    log(`A. concluído: ${stats.lidos.toLocaleString('pt-BR')} lidos, ${stats.mantidos.toLocaleString('pt-BR')} mantidos (${stats.malformados} malformados).`);
    if (!stats.mantidos) throw new Error('Nenhum estabelecimento passou nos filtros — afrouxe os critérios (CNAE, UF, situação).');

    // índice de básicos só depois da carga (e antes de ler Empresas/Sócios, que consultam por ele)
    db.exec('create index if not exists estab_basico_idx on estabelecimento (cnpj_basico)');
    const basicos = new Set(db.prepare('select distinct cnpj_basico from estabelecimento').all().map((r) => r.cnpj_basico));
    log(`   ${basicos.size.toLocaleString('pt-BR')} empresas (CNPJ básico) a buscar.`);

    // ── B. empresas ──
    const insEmp = db.prepare('insert or replace into empresa values (?,?,?,?,?)');
    for (const arq of arquivosDaFamilia(pasta, 'Empresas')) {
      log(`B. ${arq.split(/[\\/]/).pop()} …`);
      let buffer = [];
      const descarregar = () => emTransacao(db, () => {
        for (const m of buffer) insEmp.run(m.cnpjBasico, m.razaoSocial, m.naturezaCodigo, m.porte, m.capitalSocial);
      });
      for await (const linha of linhasDoZip(arq)) {
        const cols = L.dividirLinha(linha);
        if (!L.cabe(cols, 'empresa') || !basicos.has(cols[L.M.basico])) continue;
        buffer.push(L.converterEmpresa(cols));
        if (buffer.length >= LOTE) { descarregar(); buffer = []; }
      }
      descarregar();
    }

    // ── C. empresário individual / MEI = pessoa física: fora, salvo --incluir-ei ──
    if (!incluirEI) {
      const ei = db.prepare('select cnpj_basico from empresa where natureza_codigo = ?').all(L.NATUREZA_EMPRESARIO_INDIVIDUAL);
      emTransacao(db, () => {
        const delCnae = db.prepare('delete from estab_cnae where cnpj in (select cnpj from estabelecimento where cnpj_basico = ?)');
        const delEst = db.prepare('delete from estabelecimento where cnpj_basico = ?');
        const delEmp = db.prepare('delete from empresa where cnpj_basico = ?');
        for (const { cnpj_basico: b } of ei) { delCnae.run(b); delEst.run(b); delEmp.run(b); basicos.delete(b); }
      });
      log(`C. ${ei.length.toLocaleString('pt-BR')} empresário(s) individual(is) removido(s) (pessoa física).`);
    }
    // estabelecimento sem linha em Empresas não tem razão social: descarta para não exportar vazio
    db.exec(`delete from estab_cnae where cnpj in (select e.cnpj from estabelecimento e where not exists (select 1 from empresa m where m.cnpj_basico = e.cnpj_basico));
             delete from estabelecimento where not exists (select 1 from empresa m where m.cnpj_basico = estabelecimento.cnpj_basico)`);

    // ── D. sócios ──
    if (comSocios) {
      const insSoc = db.prepare('insert into socio values (?,?,?,?,?,?)');
      for (const arq of arquivosDaFamilia(pasta, 'Socios')) {
        log(`D. ${arq.split(/[\\/]/).pop()} …`);
        let buffer = [];
        const descarregar = () => emTransacao(db, () => {
          for (const s of buffer) insSoc.run(s.cnpjBasico, s.tipo, s.nome, s.qualificacaoCodigo, s.entrada, s.faixaEtaria);
        });
        for await (const linha of linhasDoZip(arq)) {
          const cols = L.dividirLinha(linha);
          if (!L.cabe(cols, 'socio') || !basicos.has(cols[L.S.basico])) continue;
          buffer.push(L.converterSocio(cols));
          if (buffer.length >= LOTE) { descarregar(); buffer = []; }
        }
        descarregar();
      }
    }

    // ── índices, metadados, troca atômica ──
    db.exec(INDICES);
    const meta = db.prepare('insert or replace into meta values (?, ?)');
    const guardar = {
      competencia: competencia || '',
      carregado_em: new Date().toISOString(),
      fonte: 'Receita Federal do Brasil — dados abertos do CNPJ',
      filtros: JSON.stringify({
        situacoes: [...situacoes], uf: ufs ? [...ufs] : null, so_matriz: soMatriz, incluir_ei: incluirEI, com_socios: comSocios,
        cnae: cnaes ? { exatos: [...cnaes.exatos], prefixos: [...cnaes.prefixos] } : null, lista_de_cnpjs: cnpjs ? cnpjs.size : null,
      }),
    };
    for (const [k, v] of Object.entries(guardar)) meta.run(k, v);
    db.exec('analyze');
    const resumo = {
      estabelecimentos: db.prepare('select count(*) n from estabelecimento').get().n,
      empresas: db.prepare('select count(*) n from empresa').get().n,
      socios: db.prepare('select count(*) n from socio').get().n,
    };
    db.close();
    rmSync(saida, { force: true });
    renameSync(temp, saida);
    log(`Pronto em ${Math.round((Date.now() - inicio) / 1000)} s → ${saida}`);
    return { ...resumo, ...stats, saida };
  } catch (e) {
    try { db.close(); } catch { /* já fechado */ }
    rmSync(temp, { force: true });
    throw e;
  }
}

// ── linha de comando ──
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { opcoes } = lerArgumentos(process.argv.slice(2), {
      competencia: 'valor', dir: 'valor', saida: 'valor', cnae: 'valor', uf: 'valor', situacao: 'valor',
      'cnpjs-arquivo': 'valor', 'so-matriz': 'flag', 'incluir-ei': 'flag', 'sem-socios': 'flag', baixar: 'flag',
      'partes': 'valor', 'apagar-zips': 'flag',
    });
    const raiz = opcoes.dir ? resolve(opcoes.dir) : resolve(PASTA_DADOS, 'downloads');
    const mes = opcoes.competencia || (existsSync(raiz)
      ? readdirSync(raiz).filter((n) => /^\d{4}-\d{2}$/.test(n)).sort().at(-1)
      : null) || (opcoes.baixar ? (await listarCompetencias()).at(-1) : null);
    if (!mes) throw new Error('Nenhuma competência baixada. Use --baixar ou rode antes: pnpm --dir mcp baixar');
    const pasta = resolve(raiz, mes);
    if (opcoes.baixar) {
      await baixar({ competencia: mes, destino: raiz, semSocios: !!opcoes['sem-socios'], partes: opcoes.partes ? opcoes.partes.split(',').map((x) => x.trim()) : null });
    }
    if (!existsSync(pasta)) throw new Error(`A pasta ${pasta} não existe. Use --baixar ou rode: pnpm --dir mcp baixar`);
    if (!opcoes.cnae && !opcoes.uf && !opcoes['cnpjs-arquivo']) {
      throw new Error('Informe ao menos um filtro de carga (--cnae, --uf ou --cnpjs-arquivo) — a base completa ocupa dezenas de GB. '
        + 'Exemplo: --cnae geracao,comercializacao,instalacao');
    }
    const r = await carregar({
      pasta, competencia: mes, saida: opcoes.saida ? resolve(opcoes.saida) : CAMINHO_PADRAO_DB,
      cnaes: opcoes.cnae ? resolverCnaes(opcoes.cnae.split(',')) : null,
      ufs: listaMaiuscula(opcoes.uf) ? new Set(listaMaiuscula(opcoes.uf)) : null,
      situacoes: new Set((opcoes.situacao || '02').split(',').map((s) => s.trim().padStart(2, '0'))),
      soMatriz: !!opcoes['so-matriz'], incluirEI: !!opcoes['incluir-ei'], comSocios: !opcoes['sem-socios'],
      cnpjs: opcoes['cnpjs-arquivo'] ? lerListaDeCnpjs(resolve(opcoes['cnpjs-arquivo'])) : null,
    });
    log(`\n${r.estabelecimentos.toLocaleString('pt-BR')} estabelecimentos · ${r.empresas.toLocaleString('pt-BR')} empresas · ${r.socios.toLocaleString('pt-BR')} sócios`);
    if (opcoes['apagar-zips']) { rmSync(pasta, { recursive: true, force: true }); log('Zips apagados.'); }
  } catch (e) {
    console.error(`\nErro: ${e.message}`);
    process.exit(1);
  }
}
