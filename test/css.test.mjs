// css.test.mjs — as cores do WattScout, conferidas por conta: contraste (WCAG 2.1) dos pares de texto nos DOIS temas, e
// garantia de que o tema escuro redefine todas as cores do claro (senão um valor claro "vaza" para o escuro).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'css', 'wattscout.css'), 'utf8');

/** Variáveis `--x: valor;` de um bloco que começa em `seletor {`. */
function variaveisDo(seletor) {
  const ini = CSS.indexOf(`${seletor} {`);
  assert.ok(ini >= 0, `bloco ${seletor} não encontrado`);
  const fim = CSS.indexOf('\n}', ini);
  const vars = {};
  for (const m of CSS.slice(ini, fim).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}
const claro = variaveisDo(':root');
const escuro = { ...claro, ...variaveisDo(':root[data-tema="escuro"]') };

/* ── contraste ── */
const hex = (v) => {
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
};
const luz = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contraste = (a, b) => { const [x, y] = [luz(a), luz(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const cor = (tema, nome) => {
  const c = hex(tema[nome]);
  assert.ok(c, `${nome} deveria ser #rrggbb (é "${tema[nome]}")`);
  return c;
};

// [texto, fundo, mínimo]. 4.5 = texto normal (AA); 3 = texto grande/componente de interface.
const PARES = [
  ['--texto', '--bg', 4.5], ['--texto', '--bg-elevado', 4.5], ['--texto', '--bg-sutil', 4.5],
  ['--texto-fraco', '--bg', 4.5], ['--texto-fraco', '--bg-elevado', 4.5], ['--texto-fraco', '--bg-sutil', 4.5],
  ['--texto-mais-fraco', '--bg-elevado', 4.5], ['--texto-mais-fraco', '--bg', 4.5], ['--texto-mais-fraco', '--bg-sutil', 4.5],
  ['--primaria-texto', '--primaria', 4.5], ['--primaria-texto', '--primaria-hover', 4.5],
  ['--primaria', '--bg-elevado', 4.5], ['--primaria', '--bg', 4.5], ['--primaria-forte', '--primaria-suave', 4.5],
  ['--acento-texto', '--acento', 4.5],
  ['--ok', '--ok-bg', 4.5], ['--erro', '--erro-bg', 4.5], ['--aviso', '--aviso-bg', 4.5], ['--info', '--info-bg', 4.5],
  ['--erro', '--bg-elevado', 4.5], ['--ok', '--bg-elevado', 4.5], ['--aviso', '--bg-elevado', 4.5],
  ['--b-cinza-fg', '--b-cinza-bg', 4.5], ['--b-azul-fg', '--b-azul-bg', 4.5], ['--b-roxo-fg', '--b-roxo-bg', 4.5],
  ['--b-ciano-fg', '--b-ciano-bg', 4.5], ['--b-verde-fg', '--b-verde-bg', 4.5], ['--b-ambar-fg', '--b-ambar-bg', 4.5],
  ['--b-vermelho-fg', '--b-vermelho-bg', 4.5],
  ['--dica-texto', '--dica-bg', 4.5], ['--toast-texto', '--toast-bg', 4.5],
  // bordas e barras precisam ser VISÍVEIS (3:1), não legíveis
  ['--borda-forte', '--bg-elevado', 1.6],
  ['--g-azul', '--bg-sutil', 2], ['--g-verde', '--bg-sutil', 2], ['--g-vermelho', '--bg-sutil', 2], ['--g-ambar', '--bg-sutil', 1.6],
];

for (const [nomeTema, tema] of [['claro', claro], ['escuro', escuro]]) {
  test(`contraste (${nomeTema}) — todo par de texto/fundo cumpre o mínimo`, () => {
    const falhas = [];
    for (const [fg, bg, minimo] of PARES) {
      const razao = contraste(cor(tema, fg), cor(tema, bg));
      if (razao < minimo) falhas.push(`${fg} sobre ${bg}: ${razao.toFixed(2)}:1 (mínimo ${minimo})`);
    }
    assert.deepEqual(falhas, [], `pares abaixo do mínimo no tema ${nomeTema}`);
  });
}

test('contraste — o ícone/texto da barra lateral (branco ~74%) fica legível sobre o fundo dela, nos dois temas', () => {
  for (const [nome, tema] of [['claro', claro], ['escuro', escuro]]) {
    for (const fundo of ['--lateral-1', '--lateral-2']) {
      const base = cor(tema, fundo);
      const alfa = Number(/rgba\(255, 255, 255, ([.\d]+)\)/.exec(tema['--lateral-item'])?.[1]);
      assert.ok(alfa > 0, 'lateral-item deve ser branco com transparência');
      const misturado = base.map((c) => Math.round(255 * alfa + c * (1 - alfa)));
      assert.ok(contraste(misturado, base) >= 4.5, `barra lateral ${nome} (${fundo}) com texto/ícone apagado demais`);
    }
  }
});

test('tema escuro — redefine TODAS as cores do claro (nada do tema claro vaza para o escuro)', () => {
  const soNoClaro = Object.keys(claro).filter((k) => !(k in variaveisDo(':root[data-tema="escuro"]')))
    // medidas e fontes são iguais nos dois temas de propósito
    .filter((k) => !/^--(fonte|mono|raio|raio-peq|raio-grande|raio-card|lateral-largura|topo-altura|nav-mobile)$/.test(k));
  assert.deepEqual(soNoClaro, [], 'variáveis de cor que o tema escuro esqueceu de redefinir');
});

test('toda variável usada no CSS está definida (e nenhuma cor do Garden sobrou)', () => {
  const definidas = new Set(Object.keys(claro));
  const usadas = [...CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(usadas.filter((v) => !definidas.has(v)))], []);
  assert.ok(!/--zd-color/.test(CSS), 'o CSS não deve mais depender dos tokens do Zendesk Garden');
});

test('o fim da página não fica sob a barra inferior: html/body sem altura fixa e padding que respeita a barra e o recorte do iPhone', () => {
  assert.ok(!/html,\s*body\s*\{\s*height:\s*100%/.test(CSS), 'html/body com height:100% escondia o fim de toda página no celular');
  assert.match(CSS, /#conteudo\s*\{[^}]*padding:\s*16px 14px calc\(var\(--nav-mobile\) \+ env\(safe-area-inset-bottom\)/s);
});
