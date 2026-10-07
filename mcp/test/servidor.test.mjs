// servidor.test.mjs — sobe o servidor MCP de verdade (processo filho, stdio) e conversa com ele
// por um cliente MCP, exatamente como o Claude faz.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { carregar } from '../etl/carregar.mjs';
import { resolverCnaes } from '../src/cnaes.mjs';
import { nomeSeguro } from '../src/server.mjs';
import { criarPastaRfb } from './ajudas.mjs';

const SERVIDOR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/server.mjs');
let cliente; let exportacoes; let dbPath;

async function conectar(env) {
  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', SERVIDOR],
    env: { ...process.env, ...env },
    stderr: 'pipe',
  });
  const c = new Client({ name: 'teste', version: '1.0.0' });
  await c.connect(transporte);
  return c;
}
const chamar = async (nome, args = {}) => {
  const r = await cliente.callTool({ name: nome, arguments: args });
  const texto = r.content[0].text;
  return { erro: !!r.isError, texto, json: r.isError ? null : JSON.parse(texto) };
};

before(async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'cnpj-servidor-'));
  dbPath = join(raiz, 'cnpj.sqlite');
  exportacoes = join(raiz, 'exportacoes');
  await carregar({ pasta: criarPastaRfb(), saida: dbPath, competencia: '2026-09', cnaes: resolverCnaes(['geracao', 'instalacao']), ufs: new Set(['SP', 'RJ']) });
  cliente = await conectar({ CNPJ_DB: dbPath, CNPJ_EXPORT_DIR: exportacoes });
});
after(async () => { await cliente?.close(); });

test('o servidor anuncia as 8 ferramentas e as instruções de uso', async () => {
  const { tools } = await cliente.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'cnpj_buscar', 'cnpj_cnae_buscar', 'cnpj_contar', 'cnpj_detalhe', 'cnpj_exportar',
    'cnpj_municipio_buscar', 'cnpj_presets', 'cnpj_status',
  ]);
  assert.ok(tools.every((t) => t.description?.length > 20), 'todas descritas');
  assert.match(cliente.getInstructions() ?? '', /Receita Federal/);
  const exportar = tools.find((t) => t.name === 'cnpj_exportar');
  assert.equal(exportar.annotations.readOnlyHint, false);
  assert.equal(tools.find((t) => t.name === 'cnpj_buscar').annotations.readOnlyHint, true);
});

test('cnpj_status — competência, filtros usados e contagens', async () => {
  const { json } = await chamar('cnpj_status');
  assert.equal(json.competencia, '2026-09');
  assert.equal(json.estabelecimentos, 3);
  assert.equal(json.empresas, 2);
  assert.deepEqual(json.filtros.uf, ['SP', 'RJ']);
});

test('cnpj_presets e cnpj_cnae_buscar', async () => {
  const p = (await chamar('cnpj_presets')).json;
  assert.ok(p.presets.some((x) => x.nome === 'geracao' && x.cnaes.includes('3511501')));
  assert.match(p.observacao, /Não existe CNAE específico de energia solar/);
  assert.equal((await chamar('cnpj_cnae_buscar', { texto: 'instalação' })).json.resultados[0].codigo, '4321500');
});

test('cnpj_contar / cnpj_buscar — filtros, página e resumo do resultado', async () => {
  assert.equal((await chamar('cnpj_contar', { uf: ['SP'] })).json.total, 2);
  const r = (await chamar('cnpj_buscar', { cnae: ['geracao'], limite: 1, pagina: 1 })).json;
  assert.equal(r.total, 2);
  assert.equal(r.resultados.length, 1);
  assert.equal(r.resultados[0].cnpj, '11.111.111/0001-00');
  assert.equal(r.resultados[0].telefone1, '(19) 3333-4444');
  assert.equal(r.resultados[0].situacao, 'Ativa');
  const p2 = (await chamar('cnpj_buscar', { cnae: ['geracao'], limite: 1, pagina: 2 })).json;
  assert.equal(p2.resultados[0].cnpj, '11.111.111/0002-62');
});

test('cnpj_detalhe — com sócios; CNPJ fora da base é erro explicado', async () => {
  const d = (await chamar('cnpj_detalhe', { cnpj: '11.111.111/0001-00' })).json;
  assert.equal(d.razao_social, 'SOLAR VALE ENERGIA LTDA');
  assert.equal(d.socios.length, 2);
  assert.equal(d.cnaes_secundarios.length, 2);
  const nao = await chamar('cnpj_detalhe', { cnpj: '99999999000199' });
  assert.equal(nao.erro, true);
  assert.match(nao.texto, /não está na base carregada/);
});

test('cnpj_exportar — grava o CSV na pasta de exportações, com BOM, cabeçalho e linhas', async () => {
  const r = (await chamar('cnpj_exportar', { cnae: ['geracao'], arquivo: 'geradoras-sp.csv', incluir_socios: true })).json;
  assert.equal(r.linhas_exportadas, 2);
  assert.equal(r.total_que_atende_aos_filtros, 2);
  assert.equal(r.truncado, false);
  assert.equal(r.arquivo, join(exportacoes, 'geradoras-sp.csv'));
  assert.match(r.proximo_passo, /Base CNPJ/);
  const csv = readFileSync(r.arquivo, 'utf8');
  assert.ok(csv.startsWith('\uFEFFCNPJ;Razão Social;'));
  assert.equal(csv.trim().split('\r\n').length, 3);
  assert.match(csv, /11\.111\.111\/0001-00;SOLAR VALE ENERGIA LTDA;SOLAR VALE;Ativa;2010-01-01;3511-5\/01;/);
  assert.match(csv, /MARIA SOUZA \(Sócio-Administrador\)/);
});

test('cnpj_exportar — limite trunca e avisa; nada a exportar vira erro', async () => {
  const r = (await chamar('cnpj_exportar', { arquivo: 'amostra.csv', limite: 1 })).json;
  assert.equal(r.linhas_exportadas, 1);
  assert.equal(r.truncado, true);
  const vazio = await chamar('cnpj_exportar', { uf: ['AM'], arquivo: 'vazio.csv' });
  assert.equal(vazio.erro, true);
  assert.match(vazio.texto, /Nenhuma empresa atende/);
  assert.equal(existsSync(join(exportacoes, 'vazio.csv')), false);
});

test('cnpjs_arquivo — restringe o resultado a uma lista de CNPJs (ex.: donos de usina da ANEEL)', async () => {
  const lista = join(mkdtempSync(join(tmpdir(), 'lista-srv-')), 'donos.csv');
  writeFileSync(lista, 'CNPJ\r\n66.666.666/0001-40\r\n');
  assert.equal((await chamar('cnpj_contar', { cnpjs_arquivo: lista })).json.total, 1);
  const r = (await chamar('cnpj_exportar', { cnpjs_arquivo: lista, arquivo: 'da-lista.csv' })).json;
  assert.equal(r.linhas_exportadas, 1);
  assert.match(readFileSync(r.arquivo, 'utf8'), /INSTALADORA ELETRICA RIO LTDA/);
  // a lista some depois: a próxima chamada sem lista volta a ver tudo
  assert.equal((await chamar('cnpj_contar', {})).json.total, 3);
  const ruim = await chamar('cnpj_contar', { cnpjs_arquivo: join(tmpdir(), 'nao-existe.csv') });
  assert.equal(ruim.erro, true);
  const exe = await chamar('cnpj_contar', { cnpjs_arquivo: process.execPath });
  assert.equal(exe.erro, true, 'só lê .txt/.csv/.tsv');
});

test('filtro inválido volta como erro legível, não como falha do servidor', async () => {
  const r = await chamar('cnpj_contar', { cnae: ['abc'] });
  assert.equal(r.erro, true);
  assert.match(r.texto, /CNAE inválido/);
  const s = await chamar('cnpj_buscar', { situacao: ['vivinha'] });
  assert.match(s.texto, /Situação inválida/);
});

test('nomeSeguro — nunca sai da pasta de exportações', () => {
  assert.equal(nomeSeguro('geradoras-sp.csv'), 'geradoras-sp.csv');
  assert.equal(nomeSeguro('../../etc/passwd'), 'passwd.csv');
  assert.equal(nomeSeguro('C:\\Windows\\system32\\x.csv'), 'x.csv');
  assert.equal(nomeSeguro('Relatório Final (v2).CSV'), 'relat-rio-final-v2-.csv');
  assert.match(nomeSeguro(''), /^cnpj-\d{8}-\d{6}\.csv$/);
  assert.match(nomeSeguro('...'), /^cnpj-/);
});

test('sem a base carregada, o servidor responde com instrução de como carregar (não quebra)', async () => {
  const c2 = await conectar({ CNPJ_DB: join(tmpdir(), 'nao-existe', 'cnpj.sqlite'), CNPJ_EXPORT_DIR: exportacoes });
  try {
    const r = await c2.callTool({ name: 'cnpj_status', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /ainda não foi carregada/);
    assert.match(r.content[0].text, /baixar/);
  } finally { await c2.close(); }
});
