// importacao-pura.test.mjs — a lógica de importação que a tela de Importar e o `pnpm sincronizar` compartilham.
// Sem banco e sem DOM: é por isso que as duas entradas podem decidir igual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CAMPOS_ANEEL, autoMapear, aplicarMapa } from '../js/parse.js';
import { lerZipCsvStream } from '../js/aneel.js';
import { parseCSV } from '../js/util.js';
import { analisarAneel, proprietariosDaLinha } from '../js/aneel-importacao.js';
import { CAMPOS_CNPJ, converterLinhasCnpj, classificarLinhasCnpj, gruposParaGravar } from '../js/cnpj-importacao.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const semConcessionaria = async () => null;

/* ═══════════════ ANEEL ═══════════════ */

test('analisarAneel — ZIP real da GD: 60 PJ viram usinas, 15 PF ficam de fora, PF nunca é reidentificado', async () => {
  const file = new File([readFileSync(path.join(RAIZ, 'etl/amostras/aneel-gd-amostra.zip'))], 'amostra.zip');
  let cab = null;
  const linhas = [];
  await lerZipCsvStream(file, { onCabecalho: (c) => { cab = c; }, onLinha: (l) => { linhas.push(l); } });
  const brutos = aplicarMapa(linhas, autoMapear(cab, CAMPOS_ANEEL));
  const { tipo, itens } = await analisarAneel(brutos, { casarConcessionaria: semConcessionaria });

  assert.equal(tipo, 'aneel');
  const por = (v) => itens.filter((i) => i.veredito === v);
  assert.equal(por('novo').length, 60);
  assert.equal(por('pf').length, 15);
  for (const { usina } of por('novo')) {
    assert.match(usina.cnpj, /^\d{14}$/, 'CNPJ normalizado');
    assert.equal(usina.tipo_consumidor, 'PJ');
    assert.equal(usina.fonte, 'aneel_gd');
    assert.ok(usina.cod_empreendimento);
  }
  const elite = por('novo').find((i) => i.usina.cnpj === '12005360000165');
  assert.equal(elite.usina.titular, 'ELITE ENGENHARIA LTDA');
});

test('analisarAneel — código repetido no arquivo vira duplicado_lote, não segunda usina', async () => {
  const linha = { _linha: 0, cnpj: '12005360000165', titular: 'X LTDA', cod_empreendimento: 'GD.SP.1', tipo_consumidor: 'PJ', potencia_kw: '10,5' };
  const { itens } = await analisarAneel([linha, { ...linha, _linha: 1 }], { casarConcessionaria: semConcessionaria });
  assert.deepEqual(itens.map((i) => i.veredito), ['novo', 'duplicado_lote']);
  assert.equal(itens[0].usina.potencia_kw, 10.5);
});

test('analisarAneel — usa o casamento de distribuidora injetado e avisa quando não casa', async () => {
  const linha = { _linha: 0, cnpj: '12005360000165', cod_empreendimento: 'A', distribuidora_nome: 'ENEL SP' };
  const casa = await analisarAneel([linha], { casarConcessionaria: async (t) => (t === 'ENEL SP' ? 'ENEL-SP' : null) });
  assert.equal(casa.itens[0].usina.concessionaria_codigo, 'ENEL-SP');
  assert.equal(casa.itens[0].avisoConc, undefined);
  const nao = await analisarAneel([linha], { casarConcessionaria: semConcessionaria });
  assert.equal(nao.itens[0].usina.concessionaria_codigo, null);
  assert.equal(nao.itens[0].avisoConc, 'ENEL SP');
});

test('analisarAneel — SIGA real: usina em coparticipação gera um item por dono', async () => {
  const texto = readFileSync(path.join(RAIZ, 'etl/amostras/aneel-siga-amostra.csv'), 'utf8');
  const [cab, ...linhas] = parseCSV(texto);
  const brutos = aplicarMapa(linhas, autoMapear(cab, CAMPOS_ANEEL));
  const donos = brutos.reduce((n, b) => n + proprietariosDaLinha(b).length, 0);
  const { itens } = await analisarAneel(brutos, { casarConcessionaria: semConcessionaria });
  const novos = itens.filter((i) => i.veredito === 'novo');
  assert.ok(novos.length > 0);
  assert.equal(novos.length + itens.filter((i) => i.veredito === 'duplicado_lote').length, donos);
  assert.ok(novos.every((i) => i.usina.fonte === 'aneel_siga'));
});

/* ═══════════════ Base CNPJ ═══════════════ */

const CAB = ['CNPJ', 'Razão Social', 'Situação Cadastral', 'Natureza Jurídica', 'Telefone 1', 'E-mail', 'Município', 'UF'];
const brutosDe = (...linhas) => aplicarMapa(linhas, autoMapear(CAB, CAMPOS_CNPJ));
const semOptOut = { testar: () => null };

test('classificarLinhasCnpj — novo, atualiza, PF, inativa, repetido, sem CNPJ e opt-out', () => {
  const brutos = brutosDe(
    ['11.222.333/0001-81', 'NOVA LTDA', 'Ativa', 'Sociedade Empresária Limitada', '(19) 3333-4444', 'a@nova.com.br', 'Campinas', 'SP'],
    ['10.000.000/0000-00', 'EXISTENTE LTDA', 'Ativa', 'Sociedade Empresária Limitada', '', '', 'Campinas', 'SP'],
    ['55.555.555/0001-25', 'JOAO DA SILVA 12345678900', 'Ativa', 'Empresário (Individual)', '', '', 'Campinas', 'SP'],
    ['33.333.333/0001-44', 'BAIXADA LTDA', 'Baixada', 'Sociedade Empresária Limitada', '', '', 'Campinas', 'SP'],
    ['11.222.333/0001-81', 'NOVA REPETIDA', 'Ativa', 'Sociedade Empresária Limitada', '', '', 'Campinas', 'SP'],
    ['123', 'SEM CNPJ VALIDO', 'Ativa', '', '', '', '', ''],
    ['99.999.999/0001-91', 'SUPRIMIDA LTDA', 'Ativa', 'Sociedade Empresária Limitada', '', '', 'Campinas', 'SP'],
  );
  const supressao = { testar: (a) => (a.cnpj === '99999999000191' ? 'cnpj' : null) };
  const { itens } = classificarLinhasCnpj(converterLinhasCnpj(brutos), {
    supressao, existentes: new Map([['10000000000000', { cnpj: '10000000000000', razao_social: 'ANTIGA' }]]),
  });
  assert.deepEqual(itens.map((i) => i.veredito),
    ['novo', 'atualiza', 'pf', 'inativa', 'duplicado_lote', 'sem_id', 'suprimido']);
});

test('classificarLinhasCnpj — atualizar NÃO apaga o que o CSV veio sem (telefone, e-mail e agregados da ANEEL)', () => {
  const atual = {
    cnpj: '10000000000000', razao_social: 'ANTIGA', telefone1: '1933334444', email: 'enriquecido@opencnpj.org',
    qtd_usinas: 3, potencia_total_kw: 450, distribuidoras: ['ENEL-SP'], created_at: '2026-01-01T00:00:00Z',
  };
  const brutos = brutosDe(['10.000.000/0000-00', 'RAZAO NOVA LTDA', 'Ativa', 'Sociedade Empresária Limitada', '', '', 'Campinas', 'SP']);
  const { itens } = classificarLinhasCnpj(converterLinhasCnpj(brutos), { supressao: semOptOut, existentes: new Map([[atual.cnpj, atual]]) });
  const e = itens[0].empresa;
  assert.equal(itens[0].veredito, 'atualiza');
  assert.equal(e.razao_social, 'RAZAO NOVA LTDA', 'o que veio preenchido vence');
  assert.equal(e.telefone1, '1933334444', 'telefone enriquecido continua');
  assert.equal(e.email, 'enriquecido@opencnpj.org', 'e-mail enriquecido continua');
  assert.equal(e.qtd_usinas, 3);
  assert.deepEqual(e.distribuidoras, ['ENEL-SP']);
  assert.equal(e.created_at, '2026-01-01T00:00:00Z');
  assert.ok(e.updated_at, 'carimba a atualização');
});

test('classificarLinhasCnpj — telefone em opt-out é descartado, mas a empresa entra', () => {
  const brutos = brutosDe(['11.222.333/0001-81', 'NOVA LTDA', 'Ativa', 'Sociedade Empresária Limitada', '(19) 3333-4444', 'a@nova.com.br', 'Campinas', 'SP']);
  const supressao = { testar: (a) => (a.telefone ? 'telefone' : null) };
  const { itens } = classificarLinhasCnpj(converterLinhasCnpj(brutos), { supressao, existentes: new Map() });
  assert.equal(itens[0].veredito, 'novo');
  assert.equal(itens[0].empresa.telefone1, undefined);
  assert.equal(itens[0].empresa.email, 'a@nova.com.br');
  assert.match(itens[0].detalhe, /opt-out/);
});

test('gruposParaGravar — novas e atualizadas nunca no mesmo lote; o que ficou de fora não é gravado', () => {
  const itens = [
    { veredito: 'novo', empresa: { cnpj: '1' } },
    { veredito: 'atualiza', empresa: { cnpj: '2', telefone1: 'x' } },
    { veredito: 'pf', empresa: { cnpj: '3' } },
    { veredito: 'novo', empresa: { cnpj: '4' } },
    { veredito: 'suprimido', empresa: { cnpj: '5' } },
  ];
  const { novos, atualizados } = gruposParaGravar(itens);
  assert.deepEqual(novos.map((e) => e.cnpj), ['1', '4']);
  assert.deepEqual(atualizados.map((e) => e.cnpj), ['2']);
});
