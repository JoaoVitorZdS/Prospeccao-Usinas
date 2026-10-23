// tema.test.mjs — claro / escuro / automático, e o script que pinta antes do CSS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import {
  resolverTema, proximaPreferencia, lerPreferencia, aplicarTema, CHAVE_TEMA, COR_BARRA, PREFERENCIAS,
} from '../js/tema.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const armazenamentoFalso = (inicial = {}) => {
  const dados = { ...inicial };
  return {
    dados,
    getItem: (k) => (k in dados ? dados[k] : null),
    setItem: (k, v) => { dados[k] = String(v); },
    removeItem: (k) => { delete dados[k]; },
  };
};
const documentoFalso = () => {
  const meta = { conteudo: '', setAttribute(k, v) { if (k === 'content') this.conteudo = v; } };
  return { documentElement: { dataset: {}, style: {} }, querySelector: (s) => (s === 'meta[name="theme-color"]' ? meta : null), meta };
};

test('resolverTema — claro e escuro mandam; automático segue o sistema; lixo vira automático', () => {
  assert.equal(resolverTema('claro', true), 'claro');
  assert.equal(resolverTema('escuro', false), 'escuro');
  assert.equal(resolverTema('auto', true), 'escuro');
  assert.equal(resolverTema('auto', false), 'claro');
  assert.equal(resolverTema('roxo', true), 'escuro', 'valor desconhecido = automático');
  assert.equal(resolverTema(undefined, false), 'claro');
});

test('proximaPreferencia — auto → claro → escuro → auto, e valor estranho recomeça do automático', () => {
  assert.deepEqual(PREFERENCIAS, ['auto', 'claro', 'escuro']);
  assert.equal(proximaPreferencia('auto'), 'claro');
  assert.equal(proximaPreferencia('claro'), 'escuro');
  assert.equal(proximaPreferencia('escuro'), 'auto');
  assert.equal(proximaPreferencia('xyz'), 'auto');
});

test('lerPreferencia — lê o salvo, ignora lixo e não quebra sem armazenamento', () => {
  assert.equal(lerPreferencia(armazenamentoFalso({ [CHAVE_TEMA]: 'escuro' })), 'escuro');
  assert.equal(lerPreferencia(armazenamentoFalso({ [CHAVE_TEMA]: 'rosa' })), 'auto');
  assert.equal(lerPreferencia(armazenamentoFalso()), 'auto');
  assert.equal(lerPreferencia(null), 'auto');
  assert.equal(lerPreferencia({ getItem() { throw new Error('bloqueado'); } }), 'auto', 'localStorage bloqueado lança: tolera');
});

test('aplicarTema — grava o tema resolvido no <html>, ajusta a cor da barra e lembra só o que não é automático', () => {
  const documento = documentoFalso();
  const armazenamento = armazenamentoFalso();
  assert.equal(aplicarTema('escuro', { documento, armazenamento, sistemaEscuro: false }), 'escuro');
  assert.equal(documento.documentElement.dataset.tema, 'escuro');
  assert.equal(documento.documentElement.dataset.temaPref, 'escuro');
  assert.equal(documento.documentElement.style.colorScheme, 'escuro');
  assert.equal(documento.meta.conteudo, COR_BARRA.escuro);
  assert.equal(armazenamento.dados[CHAVE_TEMA], 'escuro');

  assert.equal(aplicarTema('auto', { documento, armazenamento, sistemaEscuro: false }), 'claro');
  assert.equal(documento.documentElement.dataset.temaPref, 'auto');
  assert.equal(documento.meta.conteudo, COR_BARRA.claro);
  assert.ok(!(CHAVE_TEMA in armazenamento.dados), 'automático não precisa ficar salvo: apaga a chave');

  aplicarTema('claro', { documento, armazenamento, sistemaEscuro: true, persistir: false });
  assert.ok(!(CHAVE_TEMA in armazenamento.dados), 'persistir:false não grava (é o que o boot usa)');
});

test('aplicarTema — armazenamento que lança erro não derruba o app', () => {
  const documento = documentoFalso();
  const armazenamento = { setItem() { throw new Error('cheio'); }, removeItem() { throw new Error('cheio'); } };
  assert.equal(aplicarTema('escuro', { documento, armazenamento, sistemaEscuro: false }), 'escuro');
});

test('tema-inicial.js (roda antes do CSS) decide IGUAL a resolverTema, em todas as combinações', () => {
  const codigo = readFileSync(join(RAIZ, 'js/tema-inicial.js'), 'utf8');
  for (const salvo of [null, 'claro', 'escuro', 'lixo']) {
    for (const sistemaEscuro of [false, true]) {
      const atributos = {};
      const sandbox = {
        localStorage: { getItem: () => salvo },
        matchMedia: () => ({ matches: sistemaEscuro }),
        document: { documentElement: { setAttribute: (k, v) => { atributos[k] = v; }, style: {} } },
      };
      sandbox.window = sandbox;
      vm.runInNewContext(codigo, sandbox);
      const esperado = resolverTema(PREFERENCIAS.includes(salvo) ? salvo : 'auto', sistemaEscuro);
      assert.equal(atributos['data-tema'], esperado, `salvo=${salvo} sistemaEscuro=${sistemaEscuro}`);
      assert.equal(sandbox.document.documentElement.style.colorScheme, esperado);
    }
  }
});

test('tema-inicial.js — localStorage bloqueado (lança) ainda resolve pelo sistema, sem exceção', () => {
  const codigo = readFileSync(join(RAIZ, 'js/tema-inicial.js'), 'utf8');
  const atributos = {};
  const sandbox = {
    localStorage: { getItem() { throw new Error('SecurityError'); } },
    matchMedia: () => ({ matches: true }),
    document: { documentElement: { setAttribute: (k, v) => { atributos[k] = v; }, style: {} } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(codigo, sandbox);
  assert.equal(atributos['data-tema'], 'escuro');
});

test('tema-inicial.js — marca iPhone/iPad (inclusive iPadOS que se diz Mac) com data-ios, e só eles', () => {
  const codigo = readFileSync(join(RAIZ, 'js/tema-inicial.js'), 'utf8');
  const casos = [
    [{ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }, true],
    [{ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }, false],
    [{ userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux armv8l', maxTouchPoints: 5 }, false],
  ];
  for (const [navigator, ios] of casos) {
    const atributos = {};
    const sandbox = {
      localStorage: { getItem: () => null },
      matchMedia: () => ({ matches: false }),
      navigator,
      document: { documentElement: { setAttribute: (k, v) => { atributos[k] = v; }, style: {} } },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(codigo, sandbox);
    assert.equal('data-ios' in atributos, ios, navigator.userAgent);
  }
});
