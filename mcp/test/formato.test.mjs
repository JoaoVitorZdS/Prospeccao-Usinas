// formato.test.mjs — o CSV exportado é lido SEM mapeamento manual pelo importador do app.
// Importa o código do próprio app (../../js) para provar o contrato de ponta a ponta:
// base da Receita → SQLite → cnpj_exportar (CSV) → parser do app → objeto de `empresa`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carregar } from '../etl/carregar.mjs';
import { resolverCnaes } from '../src/cnaes.mjs';
import { percorrer, detalhe } from '../src/consulta.mjs';
import {
  CABECALHO_EXPORTACAO, linhaExportacao, linhaCsv, BOM, mascaraCnpj, mascaraTelefone,
} from '../src/formato.mjs';
import { criarPastaRfb } from './ajudas.mjs';
import { parseCSV } from '../../js/util.js';
import { autoMapear, aplicarMapa } from '../../js/parse.js';
import { CAMPOS_CNPJ, linhaParaEmpresa } from '../../js/cnpj-importacao.js';

let db;
before(async () => {
  const saida = join(mkdtempSync(join(tmpdir(), 'cnpj-formato-')), 'cnpj.sqlite');
  await carregar({ pasta: criarPastaRfb(), saida, competencia: '2026-09', cnaes: resolverCnaes(['geracao', 'instalacao']), ufs: new Set(['SP', 'RJ']) });
  db = new DatabaseSync(saida, { readOnly: true });
});

function exportar({ socios = false } = {}) {
  const linhas = [];
  for (const r of percorrer(db, {})) {
    const s = socios ? detalhe(db, r.cnpj, { incluirSocios: true }).socios : [];
    linhas.push(linhaExportacao(r, { socios: s.map((x) => ({ nome: x.nome, qualificacao: x.qualificacao })) }));
  }
  return BOM + linhaCsv(CABECALHO_EXPORTACAO) + linhas.map(linhaCsv).join('');
}

test('máscaras e linha CSV (aspas, ponto e vírgula, CRLF)', () => {
  assert.equal(mascaraCnpj('11111111000100'), '11.111.111/0001-00');
  assert.equal(mascaraTelefone('1933334444'), '(19) 3333-4444');
  assert.equal(mascaraTelefone('19988887777'), '(19) 98888-7777');
  assert.equal(linhaCsv(['a', 'b;c', 'd"e', '']), 'a;"b;c";"d""e";\r\n');
});

test('o cabeçalho exportado é mapeado inteiro e sem colisão pelo importador do app', () => {
  const mapa = autoMapear(CABECALHO_EXPORTACAO, CAMPOS_CNPJ);
  assert.equal(Object.keys(mapa).length, CAMPOS_CNPJ.length);
  assert.equal(new Set(Object.values(mapa)).size, CAMPOS_CNPJ.length, 'cada coluna vai para um campo diferente');
});

test('CSV exportado → parser do app → empresa: os dados chegam iguais', () => {
  const csv = exportar({ socios: true });
  assert.ok(csv.startsWith(BOM), 'BOM para o Excel abrir acentos');
  const linhas = parseCSV(csv);
  assert.equal(linhas.length, 1 + 3, 'cabeçalho + 3 estabelecimentos');
  const mapa = autoMapear(linhas[0], CAMPOS_CNPJ);
  const objetos = aplicarMapa(linhas.slice(1), mapa).map((b) => linhaParaEmpresa(b, { competencia: '2026-09' }));
  assert.ok(objetos.every((o) => !o.erro), 'todas as linhas viram empresa');

  const solar = objetos.map((o) => o.empresa).find((e) => e.cnpj === '11111111000100');
  assert.equal(solar.razao_social, 'SOLAR VALE ENERGIA LTDA');
  assert.equal(solar.nome_fantasia, 'SOLAR VALE');
  assert.equal(solar.situacao_cadastral, 'Ativa');
  assert.equal(solar.data_abertura, '2010-01-01');
  assert.equal(solar.cnae_principal, '3511501');
  assert.equal(solar.cnae_descricao, 'Geração de energia elétrica');
  assert.deepEqual(solar.cnaes_secundarios, ['4321500', '4742300']);
  assert.equal(solar.porte, 'Demais');
  assert.equal(solar.capital_social, 1250000.5);
  assert.equal(solar.natureza_juridica, 'Sociedade Empresária Limitada');
  assert.equal(solar.matriz, true);
  assert.equal(solar.logradouro, 'RUA DAS FLORES, 100, CENTRO');
  assert.equal(solar.cep, '13000000');
  assert.equal(solar.municipio_sede, 'CAMPINAS');
  assert.equal(solar.uf_sede, 'SP');
  assert.equal(solar.telefone1, '1933334444');
  assert.equal(solar.email, 'contato@solarvale.com.br');
  assert.deepEqual(solar.socios.map((s) => s.nome).sort(), ['HOLDING SOLAR SA', 'MARIA SOUZA']);
  assert.equal(solar.competencia_cadastro, '2026-09');
  assert.equal(solar.fonte_cadastro, 'receita_federal');

  const filial = objetos.map((o) => o.empresa).find((e) => e.cnpj === '11111111000262');
  assert.equal(filial.matriz, false);
  assert.equal(filial.telefone1, undefined, 'sem telefone no cadastro: o campo nem é enviado (não apaga nada no upsert)');
});

test('sem a opção, o CSV não leva a coluna de sócios preenchida', () => {
  const linhas = parseCSV(exportar());
  const iSocios = linhas[0].indexOf('Sócios');
  assert.ok(linhas.slice(1).every((l) => (l[iSocios] ?? '') === ''));
});
