import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carregar } from '../etl/carregar.mjs';
import { exportar } from '../etl/exportar.mjs';
import { resolverCnaes } from '../src/cnaes.mjs';
import { CABECALHO_EXPORTACAO } from '../src/formato.mjs';
import { criarPastaRfb } from './ajudas.mjs';

const pastaTemp = () => mkdtempSync(join(tmpdir(), 'exp-'));

test('exportar (linha de comando) — grava o mesmo CSV da ferramenta MCP: BOM, cabeçalho do contrato, só empresas do banco', async () => {
  const banco = join(pastaTemp(), 'cnpj.sqlite');
  await carregar({ pasta: criarPastaRfb(), saida: banco, cnaes: resolverCnaes(['geracao']), ufs: new Set(['SP']) });
  const saida = join(pastaTemp(), 'saida.csv');
  const r = exportar({ banco, saida });
  assert.equal(r.arquivo, saida);
  assert.ok(existsSync(saida));
  assert.equal(r.linhas, r.total);

  const texto = readFileSync(saida, 'utf8');
  assert.equal(texto.charCodeAt(0), 0xFEFF, 'BOM para o Excel abrir os acentos');
  const [cab, ...linhas] = texto.slice(1).trim().split(/\r?\n/);
  assert.equal(cab, CABECALHO_EXPORTACAO.join(';'));
  assert.equal(linhas.length, r.linhas);
  assert.ok(linhas.every((l) => !/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(l)), 'nenhum CPF no arquivo');
});

test('exportar — banco sem nada que atenda ao filtro é erro claro, sem criar arquivo', async () => {
  const banco = join(pastaTemp(), 'cnpj.sqlite');
  await carregar({ pasta: criarPastaRfb(), saida: banco, cnaes: resolverCnaes(['geracao']), ufs: new Set(['SP']) });
  const saida = join(pastaTemp(), 'nada.csv');
  assert.throws(() => exportar({ banco, saida, filtros: { uf: ['AC'] } }), /nada a exportar/);
  assert.equal(existsSync(saida), false);
});
