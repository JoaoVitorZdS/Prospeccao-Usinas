#!/usr/bin/env node
// exportar.mjs — grava, pela linha de comando, o MESMO CSV que a ferramenta MCP `cnpj_exportar` gera
// (importável em WattScout → Importar → Base CNPJ). Serve para quem não quer abrir o Claude só para isso,
// e para o `pnpm sincronizar`, que roda tudo sem intervenção.
//
//   pnpm --dir mcp exportar                          # tudo o que está carregado → dados/exportacoes/cnpj-AAAAMMDD.csv
//   pnpm --dir mcp exportar -- --saida geradoras.csv --uf SP --cnae geracao
//
// O que sai é o que está no SQLite: o filtro de verdade acontece na carga (`carregar`). Aqui, por padrão, só
// empresas ativas e sem empresário individual/MEI (pessoa física), como na ferramenta.

import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lerArgumentos } from './args.mjs';
import { abrirBanco, CAMINHO_PADRAO_DB, PASTA_DADOS } from '../src/banco.mjs';
import { contar, normalizarFiltros } from '../src/consulta.mjs';
import { exportarCsv } from '../src/exportar.mjs';

/** Exporta e devolve { arquivo, linhas, total }. `filtros` no formato do MCP (uf: [], cnae: []…). */
export function exportar({ banco = CAMINHO_PADRAO_DB, saida, limite = Infinity, comSocios = false, filtros = {} } = {}) {
  const db = abrirBanco(banco);
  try {
    const f = normalizarFiltros(filtros);
    const total = contar(db, f);
    if (!total) throw new Error('Nenhuma empresa atende aos filtros — nada a exportar. Confira a carga (pnpm --dir mcp carregar).');
    const hoje = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const alvo = saida
      ? (isAbsolute(saida) ? saida : resolve(PASTA_DADOS, 'exportacoes', saida))
      : resolve(PASTA_DADOS, 'exportacoes', `cnpj-${hoje}.csv`);
    const linhas = exportarCsv(db, f, alvo, { limite, comSocios });
    return { arquivo: alvo, linhas, total };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { opcoes } = lerArgumentos(process.argv.slice(2), {
      db: 'valor', saida: 'valor', limite: 'valor', socios: 'flag', uf: 'valor', cnae: 'valor',
    });
    const lista = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
    const r = exportar({
      banco: opcoes.db ? resolve(opcoes.db) : CAMINHO_PADRAO_DB,
      saida: opcoes.saida, limite: opcoes.limite ? Number(opcoes.limite) : Infinity, comSocios: !!opcoes.socios,
      filtros: { uf: lista(opcoes.uf), cnae: lista(opcoes.cnae) },
    });
    console.error(`${r.linhas.toLocaleString('pt-BR')} de ${r.total.toLocaleString('pt-BR')} empresas → ${r.arquivo}`);
  } catch (e) {
    console.error(`\nErro: ${e.message}`);
    process.exit(1);
  }
}
