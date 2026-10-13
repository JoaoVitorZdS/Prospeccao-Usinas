// baixar.test.mjs — as partes do baixador que não precisam de rede: progresso, plano do que falta e seleção.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calcularPlano, criarProgresso, selecionar, textoDeProgresso } from '../etl/baixar.mjs';

const MB = 1048576;

test('textoDeProgresso — arquivo, MB feitos/total, porcentagem, velocidade em vírgula e tempo restante', () => {
  assert.equal(
    textoDeProgresso({ nome: 'Empresas0.zip', feitos: 373 * MB, tamanho: 537 * MB, bytesPorSegundo: 3.6 * MB }),
    '  Empresas0.zip 373/537 MB (69%) · 3,6 MB/s · faltam ~46 s',
  );
  assert.match(textoDeProgresso({ nome: 'x.zip', feitos: 0, tamanho: 900 * MB, bytesPorSegundo: 1 * MB }), /faltam ~15 min/, 'acima de 2 min vira minutos');
  assert.match(textoDeProgresso({ nome: 'x.zip', feitos: 10 * MB, tamanho: 20 * MB, bytesPorSegundo: 0 }), /— MB\/s$/, 'sem velocidade ainda: não inventa ETA');
});

test('criarProgresso — escreve no máximo uma linha por intervalo, com a velocidade do trecho', () => {
  let agora = 0;
  const linhas = [];
  const p = criarProgresso({ nome: 'a.zip', tamanho: 100 * MB, escrever: (l) => linhas.push(l), intervaloMs: 15000, agora: () => agora });
  for (let i = 0; i < 10; i++) { agora += 1000; p.avancar(2 * MB); } // 10 s: nada escrito ainda
  assert.equal(linhas.length, 0);
  agora += 5000; p.avancar(2 * MB);                                    // 15 s: primeira linha (22 MB em 15 s)
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /a\.zip 22\/100 MB \(22%\) · 1,5 MB\/s/);
  agora += 1000; p.avancar(2 * MB);
  assert.equal(linhas.length, 1, 'não escreve de novo antes do próximo intervalo');
  assert.equal(p.feitos, 24 * MB);
});

test('criarProgresso — retomada conta o que já estava no disco', () => {
  let agora = 0;
  const linhas = [];
  const p = criarProgresso({ nome: 'a.zip', tamanho: 100 * MB, inicial: 40 * MB, escrever: (l) => linhas.push(l), intervaloMs: 1000, agora: () => agora });
  agora += 1000; p.avancar(10 * MB);
  assert.match(linhas[0], /50\/100 MB \(50%\)/);
});

test('calcularPlano — o que existe no servidor × o que já está no disco, sem baixar nada', () => {
  const pasta = mkdtempSync(join(tmpdir(), 'plano-'));
  writeFileSync(join(pasta, 'Cnaes.zip'), Buffer.alloc(100));           // completo
  writeFileSync(join(pasta, 'Empresas0.zip'), Buffer.alloc(300));       // parcial (de 1000)
  const plano = calcularPlano([
    { nome: 'Cnaes.zip', tamanho: 100 }, { nome: 'Empresas0.zip', tamanho: 1000 }, { nome: 'Empresas1.zip', tamanho: 500 },
  ], pasta);
  assert.equal(plano.totalBytes, 1600);
  assert.equal(plano.faltamBytes, 700 + 500);
  assert.equal(plano.completos, 1);
  assert.deepEqual(plano.arquivos.map((a) => a.local), [100, 300, 0]);
  assert.equal(calcularPlano([{ nome: 'Cnaes.zip', tamanho: 100 }], pasta).faltamBytes, 0, 'tudo completo: nada falta');
});

test('selecionar — sem sócios, só as 5 tabelas + Empresas + Estabelecimentos (o que a carga usa)', () => {
  const todos = [
    'Cnaes.zip', 'Motivos.zip', 'Municipios.zip', 'Naturezas.zip', 'Qualificacoes.zip', 'Paises.zip', 'Simples.zip',
    'Empresas0.zip', 'Estabelecimentos0.zip', 'Socios0.zip',
  ].map((nome) => ({ nome, tamanho: 1 }));
  assert.deepEqual(selecionar(todos, { semSocios: true }).map((a) => a.nome),
    ['Cnaes.zip', 'Motivos.zip', 'Municipios.zip', 'Naturezas.zip', 'Qualificacoes.zip', 'Empresas0.zip', 'Estabelecimentos0.zip']);
});
