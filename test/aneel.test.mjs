// test/aneel.test.mjs — extração de dados da ANEEL, contra amostras REAIS
// (baixadas de dadosabertos.aneel.gov.br em 14/08/2026, ver etl/amostras/).
// Node 24+ tem File/Blob/DecompressionStream/TextDecoderStream nativos, então
// `lerZipCsvStream` roda aqui exatamente como no navegador — sem mock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  extrairProprietariosSiga, splitMunicipioUF, criarParserIncremental, lerZipCsvStream,
} from '../js/aneel.js';
import { parseCSV } from '../js/util.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..');

/* ═══════════════ extrairProprietariosSiga ═══════════════ */

test('extrairProprietariosSiga — dono único, real', () => {
  const out = extrairProprietariosSiga(
    '100% para ANGLOGOLD ASHANTI CORREGO DO SITIO MINERACAO S.A. - 18.565.382/0001-66 (APE)');
  assert.deepEqual(out, [{ nome: 'ANGLOGOLD ASHANTI CORREGO DO SITIO MINERACAO S.A.', cnpj: '18565382000166', regime: 'APE' }]);
});

test('extrairProprietariosSiga — dois donos (co-participação), real', () => {
  const out = extrairProprietariosSiga(
    '50% para CRERAL- COOPERATIVA DE GERACAO DE ENERGIA E DESENVOLVIMENTO - 11.192.351/0001-68 (REG), '
    + '50% para HIPPO SUPERMERCADOS LTDA - 01.936.465/0001-11 (REG)');
  assert.equal(out.length, 2);
  assert.equal(out[0].cnpj, '11192351000168');
  assert.equal(out[0].nome, 'CRERAL- COOPERATIVA DE GERACAO DE ENERGIA E DESENVOLVIMENTO');
  assert.equal(out[1].cnpj, '01936465000111');
  assert.equal(out[1].nome, 'HIPPO SUPERMERCADOS LTDA');
});

test('extrairProprietariosSiga — nome com caractere estranho (&amp- real, sem quebrar)', () => {
  const out = extrairProprietariosSiga('100% para ELOI BRUNETTA &amp- CIA. LTDA. - 06.074.064/0001-13 (REG)');
  assert.equal(out.length, 1);
  assert.equal(out[0].cnpj, '06074064000113');
});

test('extrairProprietariosSiga — vazio ou sem padrão de CNPJ devolve lista vazia', () => {
  assert.deepEqual(extrairProprietariosSiga(''), []);
  assert.deepEqual(extrairProprietariosSiga(null), []);
  assert.deepEqual(extrairProprietariosSiga('texto qualquer sem cnpj'), []);
});

test('extrairProprietariosSiga — dedup quando o mesmo CNPJ aparece duas vezes na string', () => {
  const out = extrairProprietariosSiga(
    '50% para X - 11.192.351/0001-68 (REG), 50% para X DUPLICADO - 11.192.351/0001-68 (REG)');
  assert.equal(out.length, 1);
});

/* ═══════════════ splitMunicipioUF ═══════════════ */

test('splitMunicipioUF — campo combinado real do SIGA', () => {
  assert.deepEqual(splitMunicipioUF('Nova Lima - MG'), { municipio: 'Nova Lima', uf: 'MG' });
});

test('splitMunicipioUF — sem UF reconhecível devolve o texto inteiro como município', () => {
  assert.deepEqual(splitMunicipioUF('Município Composto Sem UF'), { municipio: 'Município Composto Sem UF', uf: null });
  assert.deepEqual(splitMunicipioUF(''), { municipio: null, uf: null });
});

/* ═══════════════ criarParserIncremental — equivalente ao parseCSV, alimentado aos pedaços ═══════════════ */

test('criarParserIncremental — produz as mesmas linhas que parseCSV, mesmo cortando no meio de campos com aspas', () => {
  const csvCompleto = 'a;"b;c";"d""e"\r\n1;2;3\r\n"x";"y";"z"\r\n';
  const esperado = parseCSV(csvCompleto);

  // alimenta 3 caracteres por vez — corta propositalmente no meio de aspas e separadores
  const p = criarParserIncremental();
  const obtidas = [];
  for (let i = 0; i < csvCompleto.length; i += 3) {
    obtidas.push(...p.alimentar(csvCompleto.slice(i, i + 3)));
  }
  obtidas.push(...p.finalizar());

  // a 1ª linha do parseCSV é o cabeçalho; o parser incremental não distingue —
  // comparamos a lista completa de linhas (cabeçalho incluso) elemento a elemento
  assert.deepEqual(obtidas, esperado);
});

test('criarParserIncremental — detecta separador só depois de ver a 1ª quebra de linha completa', () => {
  const p = criarParserIncremental();
  // alimenta 1 char de cada vez antes da quebra de linha: não deve devolver nada ainda
  let total = 0;
  const linha1 = 'a,b,c\r\n';
  for (const ch of linha1.slice(0, -2)) total += p.alimentar(ch).length;
  assert.equal(total, 0, 'não deve produzir linha sem ter visto o fim dela');
  const resto = p.alimentar(linha1.slice(-2) + '1,2,3\r\n');
  assert.equal(resto.length, 2);
  assert.deepEqual(resto[0], ['a', 'b', 'c']);
});

/* ═══════════════ lerZipCsvStream — contra o ZIP real da amostra ANEEL ═══════════════ */

test('lerZipCsvStream — lê o cabeçalho e todas as linhas do ZIP real da ANEEL (60 PJ + 15 PF)', async () => {
  const caminho = path.join(RAIZ, 'etl/amostras/aneel-gd-amostra.zip');
  const bytes = readFileSync(caminho);
  const file = new File([bytes], 'aneel-gd-amostra.zip', { type: 'application/zip' });

  let cabecalho = null;
  const linhas = [];
  const progresso = [];
  const r = await lerZipCsvStream(file, {
    onCabecalho: (c) => { cabecalho = c; },
    onLinha: (l) => { linhas.push(l); },
    onProgresso: (p) => progresso.push(p),
  });

  assert.equal(r.interrompido, false);
  assert.ok(cabecalho.includes('NumCPFCNPJ'), 'cabeçalho real da ANEEL deve trazer NumCPFCNPJ');
  assert.ok(cabecalho.includes('SigTipoConsumidor'));
  assert.ok(cabecalho.includes('NomTitularEmpreendimento'));
  assert.equal(linhas.length, 75, '60 PJ + 15 PF, exatamente como a amostra foi montada');

  const idxCnpj = cabecalho.indexOf('NumCPFCNPJ');
  const idxTipo = cabecalho.indexOf('SigTipoConsumidor');
  const idxNome = cabecalho.indexOf('NomTitularEmpreendimento');

  // a mesma ELITE ENGENHARIA LTDA / CNPJ 12005360000165 usada como exemplo no
  // plano original — está de verdade na base pública da ANEEL, não é dado fictício
  const elite = linhas.find((l) => l[idxCnpj] === '12005360000165');
  assert.ok(elite, 'CNPJ de exemplo do plano deve existir na amostra real');
  assert.equal(elite[idxNome], 'ELITE ENGENHARIA LTDA');
  assert.equal(elite[idxTipo], 'PJ');

  const pf = linhas.filter((l) => l[idxTipo] === 'PF');
  const pj = linhas.filter((l) => l[idxTipo] === 'PJ');
  assert.equal(pj.length, 60);
  assert.equal(pf.length, 15);
  // PF real da ANEEL vem com CPF/nome mascarado — nunca reidentificar (seção 9 do plano)
  assert.ok(pf.every((l) => l[idxCnpj].includes('*') || l[idxCnpj].length !== 14),
    'titular PF deve vir mascarado, nunca com CPF/CNPJ de 14 dígitos legível');

  assert.ok(progresso.length > 0);
  assert.equal(progresso.at(-1).bytesLidos, file.size);
});

test('lerZipCsvStream — onLinha pode interromper a leitura cedo (para "testar N primeiras linhas")', async () => {
  const caminho = path.join(RAIZ, 'etl/amostras/aneel-gd-amostra.zip');
  const file = new File([readFileSync(caminho)], 'x.zip');
  let vistas = 0;
  const r = await lerZipCsvStream(file, {
    onLinha: () => { vistas++; return vistas < 5 ? true : false; },
  });
  assert.equal(vistas, 5);
  assert.equal(r.interrompido, true);
});

/* ═══════════════ Amostra SIGA real — extração ponta a ponta ═══════════════ */

test('amostra SIGA real: header + extração de proprietário em pelo menos 90% das linhas', () => {
  const texto = readFileSync(path.join(RAIZ, 'etl/amostras/aneel-siga-amostra.csv'), 'utf-8');
  const linhas = parseCSV(texto, ',');
  const cabecalho = linhas[0];
  const idxProp = cabecalho.indexOf('DscPropriRegimePariticipacao');
  assert.ok(idxProp >= 0, 'coluna real do SIGA deve estar presente na amostra');

  const dados = linhas.slice(1);
  let comDono = 0;
  for (const l of dados) {
    const donos = extrairProprietariosSiga(l[idxProp]);
    if (donos.length) comDono++;
  }
  assert.ok(dados.length >= 70, 'amostra deve ter um volume razoável de linhas');
  assert.ok(comDono / dados.length >= 0.9, `esperava >=90% com dono extraído, obtive ${comDono}/${dados.length}`);
});
