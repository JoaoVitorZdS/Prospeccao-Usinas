import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../etl/layout.mjs';
import { estab, empresaRfb, socioRfb, linhaRfb } from './ajudas.mjs';

test('dividirLinha — campos entre aspas, vazios e aspas dobradas', () => {
  assert.deepEqual(L.dividirLinha('"a";"";"c"'), ['a', '', 'c']);
  assert.deepEqual(L.dividirLinha('"a";"b"\r'), ['a', 'b']);
  assert.deepEqual(L.dividirLinha(linhaRfb(['LOJA "BOA" LTDA', 'x'])), ['LOJA "BOA" LTDA', 'x']);
});

test('cabe — conta as colunas de cada tipo de arquivo (é o que pega mudança de layout)', () => {
  assert.equal(L.cabe(L.dividirLinha(estab({ basico: '1', cnae: '3511501' })), 'estabelecimento'), true);
  assert.equal(L.cabe(L.dividirLinha(empresaRfb({ basico: '1', razao: 'X' })), 'empresa'), true);
  assert.equal(L.cabe(L.dividirLinha(socioRfb({ basico: '1', nome: 'X' })), 'socio'), true);
  assert.equal(L.cabe(['a', 'b'], 'estabelecimento'), false);
  assert.equal(L.cabe(['a', 'b'], 'tabela'), true);
});

test('dataIso, telefone e capital', () => {
  assert.equal(L.dataIso('20050518'), '2005-05-18');
  assert.equal(L.dataIso('00000000'), null);
  assert.equal(L.dataIso('0'), null);
  assert.equal(L.dataIso(''), null);
  assert.equal(L.dataIso('20051345'), null);
  assert.equal(L.telefone('47', '33851125'), '4733851125');
  assert.equal(L.telefone('', '33851125'), '33851125');
  assert.equal(L.telefone('47', ''), null);
  assert.equal(L.telefone('47', '123'), null);
  assert.equal(L.capital('120000000000,00'), 120000000000);
  assert.equal(L.capital('1250000,50'), 1250000.5);
  assert.equal(L.capital(''), 0);
});

test('converterEstabelecimento — CNPJ de 14 dígitos, CNAEs, contato e endereço', () => {
  const c = L.dividirLinha(estab({
    basico: '07396865', ordem: '0001', dv: '68', cnae: '1412602', secundarios: '1411801,1411801,abc', tipoLogr: 'RUA',
    logradouro: 'TUCANEIRA', ddd1: '47', tel1: '33851125', ddd2: '47', tel2: '33851125', email: 'FULANO@EMPRESA.COM', abertura: '20050518',
  }));
  const e = L.converterEstabelecimento(c);
  assert.equal(e.cnpj, '07396865000168');
  assert.equal(e.cnpjBasico, '07396865');
  assert.equal(e.matriz, true);
  assert.equal(e.abertura, '2005-05-18');
  assert.deepEqual(e.cnaesSecundarios, ['1411801'], 'sem duplicado nem lixo');
  assert.equal(e.logradouro, 'RUA TUCANEIRA');
  assert.equal(e.telefone1, '4733851125');
  assert.equal(e.email, 'fulano@empresa.com');
  assert.equal(L.converterEstabelecimento(L.dividirLinha(estab({ basico: '1', matriz: '2', cnae: '1' }))).matriz, false);
});

test('converterEmpresa e converterSocio — sem guardar o CPF do sócio', () => {
  const m = L.converterEmpresa(L.dividirLinha(empresaRfb({ basico: '1', razao: 'SOLAR LTDA', natureza: '2062', porte: '03', capital: '50000,00' })));
  assert.deepEqual(m, { cnpjBasico: '1', razaoSocial: 'SOLAR LTDA', naturezaCodigo: '2062', porte: 'Empresa de pequeno porte', capitalSocial: 50000 });
  const s = L.converterSocio(L.dividirLinha(socioRfb({ basico: '1', nome: 'MARIA', faixa: '5' })));
  assert.deepEqual(s, { cnpjBasico: '1', tipo: 'PF', nome: 'MARIA', qualificacaoCodigo: '49', entrada: '2010-01-01', faixaEtaria: '41 a 50 anos' });
  assert.equal(JSON.stringify(s).includes('123456'), false, 'o documento mascarado não é guardado');
});
