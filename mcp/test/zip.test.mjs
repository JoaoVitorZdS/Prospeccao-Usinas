import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linhasDoZip } from '../etl/zip.mjs';
import { criarZip } from './ajudas.mjs';

const pasta = mkdtempSync(join(tmpdir(), 'zip-teste-'));
const juntar = async (it) => { const o = []; for await (const l of it) o.push(l); return o; };

test('linhasDoZip — LF, CRLF e última linha sem quebra', async () => {
  criarZip(join(pasta, 'a.zip'), 'a.csv', 'um\ndois\r\ntres');
  assert.deepEqual(await juntar(linhasDoZip(join(pasta, 'a.zip'))), ['um', 'dois', 'tres']);
});

test('linhasDoZip — latin1: acentos chegam certos', async () => {
  criarZip(join(pasta, 'b.zip'), 'b.csv', '"Geração de energia elétrica"\n');
  assert.deepEqual(await juntar(linhasDoZip(join(pasta, 'b.zip'))), ['"Geração de energia elétrica"']);
});

test('linhasDoZip — arquivo grande (várias leituras de 1 MB) sem perder nem partir linhas', async () => {
  const linhas = Array.from({ length: 60000 }, (_, i) => `"${String(i).padStart(8, '0')}";"EMPRESA NUMERO ${i} LTDA";"2062"`);
  criarZip(join(pasta, 'c.zip'), 'c.csv', `${linhas.join('\n')}\n`);
  const lidas = await juntar(linhasDoZip(join(pasta, 'c.zip')));
  assert.equal(lidas.length, 60000);
  assert.equal(lidas[0], linhas[0]);
  assert.equal(lidas[59999], linhas[59999]);
});

test('linhasDoZip — zip truncado: recusa por padrão, tolera quando pedido (e descarta a linha cortada)', async () => {
  const linhas = Array.from({ length: 30000 }, (_, i) => `"${i}";"x${i}"`);
  criarZip(join(pasta, 'd.zip'), 'd.csv', `${linhas.join('\n')}\n`);
  const inteiro = readFileSync(join(pasta, 'd.zip'));
  writeFileSync(join(pasta, 'd-cortado.zip'), inteiro.subarray(0, Math.floor(inteiro.length / 2)));
  await assert.rejects(juntar(linhasDoZip(join(pasta, 'd-cortado.zip'))), /unexpected end|incomplete|premature/i);
  const parcial = await juntar(linhasDoZip(join(pasta, 'd-cortado.zip'), { tolerarTruncado: true }));
  assert.ok(parcial.length > 1000 && parcial.length < 30000);
  assert.ok(parcial.every((l, i) => l === linhas[i]), 'só linhas inteiras e na ordem');
});

test('linhasDoZip — arquivo que não é zip dá erro claro (download incompleto/corrompido)', async () => {
  writeFileSync(join(pasta, 'lixo.zip'), 'isto nao e um zip, e uma pagina de erro html');
  await assert.rejects(juntar(linhasDoZip(join(pasta, 'lixo.zip'))), /não parece um \.zip/);
});
