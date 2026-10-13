// dicas.test.mjs — onde cai a etiqueta ("hover tag") de cada item do menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posicionarDica } from '../js/dicas.js';

const janela = { largura: 1366, altura: 768 };
const dica = { width: 120, height: 28 };
// um item da barra lateral: 44×42 no canto esquerdo
const itemRail = { left: 10, top: 300, width: 44, height: 42 };

test('direita — a etiqueta fica ao lado do item, centrada na altura dele', () => {
  const p = posicionarDica(itemRail, dica, janela, 'direita');
  assert.equal(p.lado, 'direita');
  assert.equal(p.left, 10 + 44 + 10);
  assert.equal(p.top, 300 + 21 - 14);
});

test('baixo e cima — centradas no item; sem espaço embaixo, sobe', () => {
  const alvo = { left: 600, top: 100, width: 40, height: 32 };
  const baixo = posicionarDica(alvo, dica, janela, 'baixo');
  assert.deepEqual([baixo.lado, baixo.left, baixo.top], ['baixo', 600 + 20 - 60, 100 + 32 + 10]);
  const noFundo = posicionarDica({ ...alvo, top: 740 }, dica, janela, 'baixo');
  assert.equal(noFundo.lado, 'cima', 'embaixo não cabe: vira para cima');
  assert.equal(noFundo.top, 740 - 28 - 10);
});

test('lado sem espaço vira o oposto: etiqueta "esquerda" de um item colado na borda esquerda vai para a direita', () => {
  const p = posicionarDica({ left: 4, top: 300, width: 44, height: 42 }, dica, janela, 'esquerda');
  assert.equal(p.lado, 'direita');
  assert.ok(p.left > 4 + 44);
});

test('nunca sai da janela, mesmo quando nenhum lado cabe (celular estreito, etiqueta larga)', () => {
  const estreita = { largura: 160, altura: 400 };
  const larga = { width: 220, height: 28 };
  const p = posicionarDica({ left: 120, top: 10, width: 36, height: 36 }, larga, estreita, 'baixo');
  assert.equal(p.left, 8, 'maior que a janela: não cabe de jeito nenhum, então começa na margem (lê-se o início do texto)');
  assert.ok(p.top >= 8 && p.top + 28 <= 400 - 8);
  const canto = posicionarDica({ left: 1340, top: 750, width: 30, height: 30 }, dica, janela, 'baixo');
  assert.ok(canto.left + 120 <= 1366 - 8 && canto.top + 28 <= 768 - 8, 'canto inferior direito: fica dentro');
});

test('lado desconhecido não quebra (cai em "baixo")', () => {
  // o chamador passa o atributo cru; um valor errado não pode virar NaN na tela
  const p = posicionarDica({ left: 300, top: 100, width: 40, height: 40 }, dica, janela, undefined);
  assert.equal(p.lado, 'baixo');
  assert.ok(Number.isFinite(p.left) && Number.isFinite(p.top));
});
