// test/util.test.mjs — cobre as funções puras de normalização/CSV/data.
// Rodar: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normCnpj, cnpjValido, maskCnpj, normFone, foneKey, maskFone, waLink, normEmail,
  slug, parseData, fmtData, parseNum, fmtNum, fmtPotencia, detectarSep, parseCSV,
  paraCSV, limpar, addDias, diasEntre, dataLocal, urlSegura,
} from '../js/util.js';

test('normCnpj — 14 dígitos, zero à esquerda perdido, lixo com máscara', () => {
  assert.equal(normCnpj('12.005.360/0001-65'), '12005360000165');
  assert.equal(normCnpj('12005360000165'), '12005360000165');
  assert.equal(normCnpj('2005360000165'), '02005360000165'); // Excel comeu o zero (13 dígitos)
  assert.equal(normCnpj(''), null);
  assert.equal(normCnpj(null), null);
  // PF mascarado da ANEEL (6 dígitos) NÃO pode virar CNPJ inventado por padding
  assert.equal(normCnpj('***.754.418-**'), null);
  assert.equal(normCnpj('123'), null);
  assert.equal(normCnpj('123456789012345'), null); // 15 dígitos: lixo, não trunca
});

test('cnpjValido — dígito verificador real', () => {
  assert.equal(cnpjValido('12005360000165'), true); // CNPJ real usado no exemplo do plano
  assert.equal(cnpjValido('11111111111111'), false); // repetido
  assert.equal(cnpjValido('12345678901234'), false); // DV errado
});

test('maskCnpj', () => {
  assert.equal(maskCnpj('12005360000165'), '12.005.360/0001-65');
  assert.equal(maskCnpj('123'), '123'); // fail-open, não quebra
});

test('normFone / foneKey / maskFone — absorve DDI, máscara, 9º dígito', () => {
  assert.equal(normFone('(19) 99876-5432'), '19998765432');
  assert.equal(normFone('+55 19 99876-5432'), '19998765432');
  assert.equal(normFone('5519998765432'), '19998765432');
  assert.equal(foneKey('(19) 99876-5432'), foneKey('19998765432'));
  assert.equal(foneKey('+55 19 99876-5432'), foneKey('19998765432'));
  assert.equal(maskFone('19998765432'), '(19) 99876-5432');
  assert.equal(normFone(''), null);
});

test('waLink sempre prefixa DDI 55', () => {
  assert.equal(waLink('(19) 99876-5432'), 'https://wa.me/5519998765432');
  assert.equal(waLink(''), null);
});

test('normEmail', () => {
  assert.equal(normEmail('Contato@Elite.com.br'), 'contato@elite.com.br');
  assert.equal(normEmail('não é email'), null);
});

test('slug — acento, caixa, separador, cobre o typo real da ANEEL (Muninicpios)', () => {
  assert.equal(slug('Descrição do contato'), 'descricaodocontato');
  assert.equal(slug('DscMuninicpios'), 'dscmuninicpios');
  assert.equal(slug(''), '');
  assert.equal(slug(null), '');
});

test('parseData — dd/mm/aaaa, aaaa-mm-dd, serial do Excel', () => {
  assert.equal(parseData('10/01/2026'), '2026-01-10');
  assert.equal(parseData('2026-01-10'), '2026-01-10');
  assert.equal(parseData('2026-01-10T12:00:00.000Z'), '2026-01-10');
  assert.equal(parseData(''), null);
  assert.equal(parseData(null), null);
});

test('fmtData', () => {
  assert.equal(fmtData('2026-01-10'), '10/01/2026');
  assert.equal(fmtData(null), '');
});

test('parseNum — pt-BR (1.234,56) e en (1234.56)', () => {
  assert.equal(parseNum('1.234,56'), 1234.56);
  assert.equal(parseNum('412,50'), 412.5);
  assert.equal(parseNum('32,50'), 32.5); // valor real do exemplo ANEEL
  assert.equal(parseNum(1234.5), 1234.5);
  assert.equal(parseNum(''), null);
});

test('fmtPotencia — kW até 999, MW a partir de 1000', () => {
  assert.equal(fmtPotencia(32.5), '32,50 kW');
  assert.equal(fmtPotencia(1500), '1,50 MW');
});

test('detectarSep — escolhe o separador com mais ocorrências fora de aspas', () => {
  assert.equal(detectarSep('a;b;c\n1;2;3'), ';');
  assert.equal(detectarSep('a,b,c\n1,2,3'), ',');
  assert.equal(detectarSep('"a;b",c,d\n1,2,3'), ','); // ';' está dentro de aspas, não conta
});

test('parseCSV — RFC4180, aspas duplicadas, BOM', () => {
  const linhas = parseCSV('﻿a;"b;c";"d""e"\n1;2;3');
  assert.deepEqual(linhas, [['a', 'b;c', 'd"e'], ['1', '2', '3']]);
});

test('paraCSV — BOM + CRLF + separador ; (dialeto Excel-pt)', () => {
  const csv = paraCSV(['A', 'B'], [['1', '2']]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('A;B\r\n1;2\r\n'));
});

test('limpar — filtra null/false/undefined e achata arrays, como o h() interno faz', () => {
  assert.deepEqual(limpar('a', null, 'b', false, undefined, ['c', null, 'd']), ['a', 'b', 'c', 'd']);
});

test('dataLocal — não confunde a data UTC com a data local em fuso negativo (bug real do Painel/Conversas)', () => {
  const tzOriginal = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo'; // UTC-3, mesmo fuso do plano (Brasil)
  try {
    // 2026-01-11T01:30Z é 2026-01-10 22:30 em SP: dia local ainda é 10, não 11.
    // `.slice(0,10)` (o jeito ingênuo, já removido de todo o código) devolveria
    // "2026-01-11" — um toque feito à noite "adiantava" pro dia seguinte nos
    // filtros de período do Painel, no contador da fila e em Conversas.
    assert.equal(dataLocal('2026-01-11T01:30:00.000Z'), '2026-01-10');
    assert.equal('2026-01-11T01:30:00.000Z'.slice(0, 10), '2026-01-11', 'confirma que o slice ingênuo erraria');
    // manhã, sem ambiguidade de fuso
    assert.equal(dataLocal('2026-01-10T14:00:00.000Z'), '2026-01-10');
    assert.equal(dataLocal(null), null);
    assert.equal(dataLocal(''), null);
  } finally {
    if (tzOriginal === undefined) delete process.env.TZ; else process.env.TZ = tzOriginal;
  }
});

test('urlSegura — bloqueia javascript:/data: nos links configuráveis do cockpit, deixa passar http(s)', () => {
  assert.equal(urlSegura('https://cnpj.biz/12005360000165'), 'https://cnpj.biz/12005360000165');
  assert.equal(urlSegura('http://example.com'), 'http://example.com/');
  assert.equal(urlSegura('javascript:alert(1)'), '#');
  assert.equal(urlSegura('data:text/html,<script>alert(1)</script>'), '#');
  assert.equal(urlSegura('vbscript:msgbox(1)'), '#');
  assert.equal(urlSegura('não é uma url'), '#');
  assert.equal(urlSegura(''), '#');
});

test('addDias / diasEntre', () => {
  assert.equal(addDias('2026-08-13', 3), '2026-08-16');
  assert.equal(diasEntre('2026-08-10', '2026-08-13'), 3);
  assert.equal(diasEntre('2026-08-16', '2026-08-13'), -3);
});
