import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carregar, passaNoFiltro } from '../etl/carregar.mjs';
import { resolverCnaes } from '../src/cnaes.mjs';
import { lerListaDeCnpjs } from '../src/lista.mjs';
import { criarPastaRfb, criarZip, estab, linhaRfb } from './ajudas.mjs';

const novoDb = () => join(mkdtempSync(join(tmpdir(), 'cnpj-db-')), 'cnpj.sqlite');
const q = (caminho, sql, ...p) => { const db = new DatabaseSync(caminho, { readOnly: true }); try { return db.prepare(sql).all(...p); } finally { db.close(); } };

test('carga com filtros — só ativas dos CNAEs/UFs pedidos; EI e empresas sem cadastro ficam de fora', async () => {
  const pasta = criarPastaRfb();
  const saida = novoDb();
  const r = await carregar({
    pasta, saida, competencia: '2026-09', cnaes: resolverCnaes(['geracao', 'instalacao']), ufs: new Set(['SP', 'RJ']),
  });
  assert.equal(r.estabelecimentos, 3);
  assert.equal(r.empresas, 2);
  assert.equal(r.socios, 2, 'só os sócios de empresas mantidas (o do empresário individual e o alheio ficam fora)');

  const cnpjs = q(saida, 'select cnpj from estabelecimento order by cnpj').map((x) => x.cnpj);
  assert.deepEqual(cnpjs, ['11111111000100', '11111111000262', '66666666000140']);
  // fora: MG (22222222), baixada (33333333), agro (44444444), empresário individual (55555555), sem Empresas (77777777)
  assert.equal(q(saida, "select count(*) n from empresa where cnpj_basico = '55555555'")[0].n, 0);
});

test('carga — campos convertidos: contato, capital, porte, CNAEs e metadados', async () => {
  const pasta = criarPastaRfb();
  const saida = novoDb();
  await carregar({ pasta, saida, competencia: '2026-09', cnaes: resolverCnaes(['3511501']), ufs: new Set(['SP']) });
  const [e] = q(saida, `select e.*, m.razao_social, m.capital_social, m.porte, m.natureza_codigo from estabelecimento e
    join empresa m using (cnpj_basico) where e.cnpj = '11111111000100'`);
  assert.equal(e.razao_social, 'SOLAR VALE ENERGIA LTDA');
  assert.equal(e.capital_social, 1250000.5);
  assert.equal(e.porte, 'Demais');
  assert.equal(e.email, 'contato@solarvale.com.br', 'e-mail em minúsculas');
  assert.equal(e.telefone1, '1933334444');
  assert.equal(e.telefone2, null, 'telefone 2 igual ao 1 não é duplicado');
  assert.equal(e.cnaes_secundarios, '4321500,4742300');
  assert.equal(e.abertura, '2010-01-01');
  assert.equal(e.matriz, 1);
  const cn = q(saida, "select cnae, principal from estab_cnae where cnpj = '11111111000100' order by principal desc, cnae");
  assert.deepEqual(cn.map((x) => `${x.cnae}:${x.principal}`), ['3511501:1', '4321500:0', '4742300:0']);
  const meta = Object.fromEntries(q(saida, 'select chave, valor from meta').map((x) => [x.chave, x.valor]));
  assert.equal(meta.competencia, '2026-09');
  assert.deepEqual(JSON.parse(meta.filtros).uf, ['SP']);
  assert.ok(meta.carregado_em);
});

test('carga — incluirEI mantém o empresário individual; o padrão o remove', async () => {
  const pasta = criarPastaRfb();
  const com = novoDb();
  const sem = novoDb();
  const base = { pasta, cnaes: resolverCnaes(['geracao']), ufs: new Set(['SP']) };
  const a = await carregar({ ...base, saida: com, incluirEI: true });
  const b = await carregar({ ...base, saida: sem });
  assert.equal(a.empresas - b.empresas, 1);
  assert.equal(q(com, "select natureza_codigo from empresa where cnpj_basico = '55555555'")[0].natureza_codigo, '2135');
});

test('carga por lista de CNPJs — só os da lista (CNPJ completo ou "básico" de 8 dígitos)', async () => {
  const pasta = criarPastaRfb();
  const saida = novoDb();
  const lista = join(mkdtempSync(join(tmpdir(), 'lista-')), 'donos.csv');
  writeFileSync(lista, 'CNPJ;Titular\r\n11.111.111/0001-00;Solar Vale\r\n66666666\r\nlixo;x\r\n');
  const cnpjs = lerListaDeCnpjs(lista);
  assert.deepEqual([...cnpjs].sort(), ['11111111000100', '66666666']);
  const r = await carregar({ pasta, saida, cnpjs });
  assert.deepEqual(q(saida, 'select cnpj from estabelecimento order by cnpj').map((x) => x.cnpj), ['11111111000100', '66666666000140']);
  assert.equal(r.empresas, 2);
});

test('carga — sem sócios quando pedido; sem filtro que case, erro claro e nenhum arquivo deixado', async () => {
  const pasta = criarPastaRfb();
  const saida = novoDb();
  const r = await carregar({ pasta, saida, cnaes: resolverCnaes(['geracao']), comSocios: false });
  assert.equal(r.socios, 0);
  const vazio = novoDb();
  await assert.rejects(carregar({ pasta, saida: vazio, cnaes: resolverCnaes(['9999999']) }), /Nenhum estabelecimento passou nos filtros/);
  assert.equal(existsSync(vazio), false);
  assert.equal(existsSync(`${vazio}.carregando`), false, 'o arquivo temporário é apagado quando falha');
});

test('carga — layout mudou (linhas sem 30 colunas): aborta sem gravar nada', async () => {
  const pasta = criarPastaRfb();
  const ruins = Array.from({ length: 1500 }, (_, i) => linhaRfb([String(i), 'so', 'tres', 'colunas']));
  criarZip(join(pasta, 'Estabelecimentos2.zip'), 'K.ESTABELE', `${ruins.join('\n')}\n`);
  const saida = novoDb();
  await assert.rejects(carregar({ pasta, saida, cnaes: resolverCnaes(['geracao']) }), /layout da Receita mudou/);
  assert.equal(existsSync(saida), false);
});

test('carga — falta de arquivo obrigatório é erro explicado', async () => {
  const pasta = mkdtempSync(join(tmpdir(), 'vazia-'));
  await assert.rejects(carregar({ pasta, saida: novoDb(), cnaes: resolverCnaes(['geracao']) }), /Falta Cnaes\.zip/);
});

test('passaNoFiltro — cada critério sozinho', () => {
  const e = { cnpj: '11111111000100', cnpjBasico: '11111111', situacao: '02', matriz: true, uf: 'SP', cnaePrincipal: '3511501', cnaesSecundarios: ['4321500'] };
  const base = { situacoes: new Set(['02']), soMatriz: false, ufs: null, cnpjs: null, cnaes: null };
  assert.equal(passaNoFiltro(e, base), true);
  assert.equal(passaNoFiltro({ ...e, situacao: '08' }, base), false);
  assert.equal(passaNoFiltro({ ...e, matriz: false }, { ...base, soMatriz: true }), false);
  assert.equal(passaNoFiltro(e, { ...base, ufs: new Set(['MG']) }), false);
  assert.equal(passaNoFiltro(e, { ...base, cnaes: resolverCnaes(['4321500']) }), true, 'CNAE secundário também vale');
  assert.equal(passaNoFiltro(e, { ...base, cnaes: resolverCnaes(['3511']) }), true, 'prefixo');
  assert.equal(passaNoFiltro(e, { ...base, cnaes: resolverCnaes(['4742300']) }), false);
  assert.equal(passaNoFiltro(e, { ...base, cnpjs: new Set(['11111111']) }), true, 'CNPJ básico');
  assert.equal(passaNoFiltro(e, { ...base, cnpjs: new Set(['22222222']) }), false);
});

test('estab() de teste tem 30 colunas — protege os próprios testes', () => {
  assert.equal(estab({ basico: '1', cnae: '1' }).split('";"').length, 30);
});
