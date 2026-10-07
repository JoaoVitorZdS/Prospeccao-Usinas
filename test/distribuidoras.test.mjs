// distribuidoras.test.mjs — o casamento do nome da ANEEL com o cadastro, exato e aproximado.
// Usa a lista REAL do seed (os mesmos códigos/aliases que o app grava em `concessionaria`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarIndiceAliases, casarComIndice } from '../js/db.js';
import { CONCESSIONARIAS } from '../js/seed.js';

const idx = montarIndiceAliases(CONCESSIONARIAS);
const exato = (t) => casarComIndice(idx, t, { estrito: true });
const aprox = (t) => casarComIndice(idx, t);

test('exato — código, nome e alias do cadastro, sem acento nem pontuação', () => {
  assert.equal(exato('ENEL-SP'), 'ENEL-SP');
  assert.equal(exato('enel sp'), 'ENEL-SP');
  const nome = CONCESSIONARIAS.find((c) => c.codigo === 'ENERGISA-AC').nome;
  assert.equal(exato(nome.toUpperCase()), 'ENERGISA-AC');
  assert.equal(exato('  '), null);
  assert.equal(exato(null), null);
});

test('nomes que vêm da ANEEL casam (exato ou aproximado), como no import', () => {
  assert.equal(aprox('ENERGISA ACRE - DISTRIBUIDORA DE ENERGIA S.A'), 'ENERGISA-AC');
  assert.equal(aprox('CEMIG DISTRIBUICAO S.A'), 'CEMIG-D');
  assert.equal(aprox('ENEL DISTRIBUIÇÃO SÃO PAULO'), 'ENEL-SP');
});

test('estrito NÃO faz correspondência aproximada — evita ligar usina à distribuidora errada', () => {
  // começa com "coopera", código real de OUTRA permissionária: aproximado erra, estrito recusa
  assert.equal(aprox('COOPERATIVA ZETA DE ELETRIFICACAO'), 'COOPERA');
  assert.equal(exato('COOPERATIVA ZETA DE ELETRIFICACAO'), null);
  // variação do nome que só o aproximado alcança
  assert.equal(aprox('CEMIG DISTRIBUICAO S.A'), 'CEMIG-D');
});

test('texto sem nenhuma relação não casa em nenhum dos modos', () => {
  assert.equal(aprox('PADARIA DO ZÉ'), null);
  assert.equal(exato('PADARIA DO ZÉ'), null);
});
