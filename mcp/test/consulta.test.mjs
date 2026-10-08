import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carregar } from '../etl/carregar.mjs';
import { resolverCnaes } from '../src/cnaes.mjs';
import {
  contar, buscar, percorrer, detalhe, buscarCnae, buscarMunicipio, montarSelecao, normalizarFiltros,
} from '../src/consulta.mjs';
import { criarPastaRfb } from './ajudas.mjs';

let db;
before(async () => {
  const saida = join(mkdtempSync(join(tmpdir(), 'cnpj-consulta-')), 'cnpj.sqlite');
  // carga ampla (todas as UFs, ativas e baixadas) para as consultas poderem filtrar de verdade
  await carregar({
    pasta: criarPastaRfb(), saida, competencia: '2026-09',
    cnaes: resolverCnaes(['geracao', 'instalacao', 'material']), situacoes: new Set(['02', '08']),
  });
  db = new DatabaseSync(saida, { readOnly: true });
});
const n = (f) => contar(db, f);

test('situação — padrão é só ativa; aceita nome e código', () => {
  assert.equal(n({}), 4);                                   // 11111111 ×2, 22222222, 66666666
  assert.equal(n({ situacao: ['baixada'] }), 1);
  assert.equal(n({ situacao: ['ativa', '08'] }), 5);
});

test('CNAE — exato, principal x qualquer, prefixo e preset', () => {
  assert.equal(n({ cnae: ['3511501'] }), 2);
  assert.equal(n({ cnae: ['4321500'] }), 2, 'qualquer: pega o secundário do 11111111/0001');
  assert.equal(n({ cnae: ['4321500'], cnae_modo: 'principal' }), 1);
  assert.equal(n({ cnae: ['4742'] }), 2, 'prefixo de 4 dígitos (principal de 22222222 + secundário de 11111111/0001)');
  assert.equal(n({ cnae: ['3511-5/01'] }), 2, 'código formatado');
  assert.equal(n({ cnae: ['material'] }), 2, 'preset');
  assert.throws(() => n({ cnae: ['abc'] }), /CNAE inválido/);
});

test('UF, município, porte, natureza', () => {
  assert.equal(n({ uf: ['sp'] }), 2);
  assert.equal(n({ uf: ['RJ'] }), 1);
  assert.equal(n({ municipio: 'campinas' }), 1);
  assert.equal(n({ municipio: 'SÃO PAULO' }), 1, 'sem acento e sem diferença de caixa');
  assert.equal(n({ porte: ['micro'] }), 1);
  assert.equal(n({ porte: ['epp'] }), 1);
  assert.equal(n({ natureza: ['2062'] }), 4);
  assert.throws(() => n({ porte: ['gigante'] }), /Porte inválido/);
});

test('capital, abertura, matriz, contato e texto', () => {
  assert.equal(n({ capital_min: 100000 }), 2);
  assert.equal(n({ capital_max: 40000 }), 1);
  assert.equal(n({ abertura_de: '2023-01-01' }), 1);
  assert.equal(n({ abertura_ate: '2022-12-31' }), 3);
  assert.equal(n({ matriz: true }), 3);
  assert.equal(n({ matriz: false }), 1);
  assert.equal(n({ com_telefone: true }), 2);
  assert.equal(n({ com_email: true }), 2);
  assert.equal(n({ texto: 'solar' }), 2);
  assert.equal(n({ texto: 'material eletrico' }), 1);
  assert.throws(() => n({ abertura_de: '01/02/2023' }), /AAAA-MM-DD/);
  assert.throws(() => n({ capital_min: 'muito' }), /deve ser um número/);
});

test('lista de CNPJs — completos ou "básicos"', () => {
  assert.equal(n({ cnpjs: ['11111111'] }), 2);
  assert.equal(n({ cnpjs: ['66.666.666/0001-40'] }), 1);
  assert.equal(n({ cnpjs: ['123'] }), 4, 'lista sem CNPJ válido é ignorada, não vira "nada"');
});

test('combinação de filtros é E (todos precisam valer)', () => {
  assert.equal(n({ cnae: ['3511501'], uf: ['SP'], matriz: true, com_email: true }), 1);
  assert.equal(n({ cnae: ['3511501'], uf: ['RJ'] }), 0);
});

test('SQL injection — valores de filtro nunca viram SQL', () => {
  assert.equal(n({ texto: "x' or 1=1 --" }), 0);
  assert.equal(n({ uf: ["SP' or '1'='1"] }), 0);
  assert.equal(n({ municipio: "%'; drop table estabelecimento; --" }), 0);
  assert.equal(n({}), 4, 'a tabela continua lá');
  const { sql } = montarSelecao({ texto: "x' or 1=1 --", uf: ['SP'] });
  assert.ok(!sql.includes('1=1') && !sql.includes('drop'), 'o valor não aparece no SQL, só como parâmetro');
});

test('ordenação padrão por capital (maior primeiro) e paginação estável', () => {
  const todos = buscar(db, {}, { limite: 10 });
  assert.equal(todos[0].cnpj_basico, '11111111');
  assert.deepEqual(todos.map((r) => r.capital_social), [...todos.map((r) => r.capital_social)].sort((a, b) => b - a));
  const p1 = buscar(db, {}, { limite: 2, deslocamento: 0 });
  const p2 = buscar(db, {}, { limite: 2, deslocamento: 2 });
  assert.equal(new Set([...p1, ...p2].map((r) => r.cnpj)).size, 4);
  assert.equal(buscar(db, { ordenar_por: 'abertura', ordem: 'desc' }, { limite: 1 })[0].cnpj_basico, '66666666');
});

test('percorrer — entrega tudo, em páginas, respeitando o limite', () => {
  assert.equal([...percorrer(db, {}, { tamanhoPagina: 3 })].length, 4);
  assert.equal([...percorrer(db, {}, { tamanhoPagina: 3, limiteTotal: 2 })].length, 2);
  assert.equal([...percorrer(db, { uf: ['XX'] })].length, 0);
});

test('detalhe — cadastro completo com sócios; sem CPF; desconhecido vira null', () => {
  const d = detalhe(db, '11.111.111/0001-00');
  assert.equal(d.razao_social, 'SOLAR VALE ENERGIA LTDA');
  assert.deepEqual(d.cnaes_secundarios_detalhe.map((x) => x.cnae), ['4321500', '4742300']);
  assert.equal(d.cnaes_secundarios_detalhe[0].descricao, 'Instalação e manutenção elétrica');
  assert.deepEqual(d.socios.map((s) => s.nome).sort(), ['HOLDING SOLAR SA', 'MARIA SOUZA']);
  assert.equal(JSON.stringify(d).includes('123456'), false);
  assert.equal(detalhe(db, '11111111000100', { incluirSocios: false }).socios, undefined);
  assert.equal(detalhe(db, '99999999000199'), null);
  assert.throws(() => detalhe(db, '123'), /14 dígitos/);
});

test('buscarCnae e buscarMunicipio — texto sem acento, por código e filtrando pela UF', () => {
  assert.deepEqual(buscarCnae(db, 'ENERGIA eletrica').map((x) => x.codigo), ['3511501']);
  assert.equal(buscarCnae(db, 'geração')[0].codigo, '3511501');
  assert.equal(buscarCnae(db, '4321')[0].codigo, '4321500');
  assert.equal(buscarMunicipio(db, 'campinas')[0].codigo, '6001');
  assert.equal(buscarMunicipio(db, 'campinas', 'SP').length, 1);
  assert.equal(buscarMunicipio(db, 'campinas', 'RJ').length, 0);
});

test('normalizarFiltros — valida cedo e aplica os padrões', () => {
  const f = normalizarFiltros({});
  assert.deepEqual(f.situacao, ['02']);
  assert.equal(f.incluirEI, false);
  assert.equal(f.cnaeModo, 'qualquer');
  assert.throws(() => normalizarFiltros({ situacao: ['vivinha'] }), /Situação inválida/);
});
