// sincronizar.test.mjs — o `pnpm sincronizar` de ponta a ponta, SEM rede: banco falso em memória, arquivos reais de
// amostra da ANEEL e zips no formato real da Receita (os mesmos dos testes do mcp/).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarSupabaseFalso } from './ajudas-supabase.mjs';

const RAIZ = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const fake = criarSupabaseFalso({
  usuarios: {
    'gestor@x.com': { senha: 'segredo123', perfil: { id: 'p-gestor', nome: 'Marina', papel: 'gestor', ativo: true } },
    'agente@x.com': { senha: 'segredo123', perfil: { id: 'p-agente', nome: 'Carlos', papel: 'agente', ativo: true } },
    'pendente@x.com': { senha: 'segredo123', perfil: { id: 'p-pend', nome: 'Bia', papel: 'agente', ativo: false } },
  },
});
fake.instalar(); // antes de qualquer abrir() de js/db.js

const db = await import('../js/db.js');
const { entrar } = await import('../scripts/sync/conexao.mjs');
const { baixarArquivo } = await import('../scripts/sync/baixar.mjs');
const { sincronizarAneel } = await import('../scripts/sync/aneel.mjs');
const { sincronizarReceita, importarCsvReceita, competenciaMaisRecente } = await import('../scripts/sync/receita.mjs');
const { lerOpcoes, ETAPAS } = await import('../scripts/sincronizar.mjs');
const { lerEnv, carregarEnvLocal, ehSim } = await import('../scripts/sync/ambiente.mjs');
const mcpBaixar = await import('../mcp/etl/baixar.mjs');
const mcpCarregar = await import('../mcp/etl/carregar.mjs');
const mcpExportar = await import('../mcp/etl/exportar.mjs');
const { resolverCnaes } = await import('../mcp/src/cnaes.mjs');
const { criarPastaRfb } = await import('../mcp/test/ajudas.mjs');

const pasta = () => mkdtempSync(join(tmpdir(), 'sync-'));
const mudo = () => {};
const gestor = { id: 'p-gestor', nome: 'Marina', papel: 'gestor' };
beforeEach(() => fake.limpar());

/** Download falso: em vez da rede, copia as amostras REAIS da ANEEL que vêm no repositório. */
const baixarAmostras = async (url, destino) => {
  const origem = url.includes('datastore') ? 'etl/amostras/aneel-siga-amostra.csv' : 'etl/amostras/aneel-gd-amostra.zip';
  mkdirSync(dirname(destino), { recursive: true });
  copyFileSync(resolve(RAIZ, origem), destino);
  return { reutilizado: false };
};

/* ═══════════════ linha de comando e ambiente ═══════════════ */

test('lerOpcoes — padrão faz tudo; --so filtra e mantém a ordem; erros são claros', () => {
  assert.deepEqual(lerOpcoes([]).etapas, ETAPAS);
  assert.deepEqual(lerOpcoes(['--so', 'receita,aneel']).etapas, ['aneel', 'receita'], 'a ordem das etapas é sempre a do fluxo');
  assert.equal(lerOpcoes(['--', '--dry-run']).dryRun, true, 'o "--" que o pnpm repassa é ignorado');
  const o = lerOpcoes(['--uf', 'SP,MG', '--cnae', 'geracao', '--competencia', '2026-09', '--sem-download']);
  assert.deepEqual([o.receita.uf, o.receita.cnae, o.receita.competencia, o.semDownload], ['SP,MG', 'geracao', '2026-09', true]);
  assert.throws(() => lerOpcoes(['--so', 'foo']), /Etapa desconhecida/);
  assert.throws(() => lerOpcoes(['--competencia', '09/2026']), /AAAA-MM/);
  assert.throws(() => lerOpcoes(['--so-donos', '--cnae', 'geracao']), /não combina/);
  assert.throws(() => lerOpcoes(['--so', 'aneel', '--csv', 'x.csv']), /só faz sentido com a etapa receita/);
  assert.throws(() => lerOpcoes(['--inexistente']), /Opção desconhecida/);
});

test('ambiente — .env com aspas e comentários; o ambiente real vence o arquivo; sem arquivo não é erro', () => {
  const lido = lerEnv('# comentário\nWATTSCOUT_EMAIL=a@b.com  # do gestor\nexport WATTSCOUT_SENHA="com espaço # e hash"\nVAZIA=\n\nlixo sem igual\n');
  assert.deepEqual(lido, { WATTSCOUT_EMAIL: 'a@b.com', WATTSCOUT_SENHA: 'com espaço # e hash', VAZIA: '' });
  const arq = join(pasta(), '.env.local');
  writeFileSync(arq, 'A=do-arquivo\nB=do-arquivo\n');
  const amb = { A: 'do-ambiente' };
  assert.equal(carregarEnvLocal(arq, amb), true);
  assert.deepEqual(amb, { A: 'do-ambiente', B: 'do-arquivo' });
  assert.equal(carregarEnvLocal(join(pasta(), 'nao-existe'), {}), false);
  assert.deepEqual(['s', 'SIM', 'y', 'n', '', 'talvez'].map(ehSim), [true, true, true, false, false, false]);
});

/* ═══════════════ login ═══════════════ */

test('entrar — gestor entra; agente, pendente e senha errada são recusados com motivo', async () => {
  const p = await entrar({ email: 'gestor@x.com', senha: 'segredo123' });
  assert.equal(p.papel, 'gestor');
  await assert.rejects(entrar({ email: 'agente@x.com', senha: 'segredo123' }), /é de agente.*só gestor pode gravar/);
  await assert.rejects(entrar({ email: 'pendente@x.com', senha: 'segredo123' }), /ainda não foi aprovada/);
  await assert.rejects(entrar({ email: 'gestor@x.com', senha: 'errada' }), /Login recusado/);
  assert.equal((await entrar({ email: 'agente@x.com', senha: 'segredo123', exigirGestor: false })).papel, 'agente');
});

/* ═══════════════ download ═══════════════ */

const resposta = (corpo, extra = {}) => async () => new Response(corpo, { status: 200, headers: { 'content-length': String(Buffer.byteLength(corpo)), ...extra } });

test('baixarArquivo — grava, reaproveita o recente e nunca deixa arquivo incompleto passando por completo', async () => {
  const destino = join(pasta(), 'sub', 'a.csv');
  const r1 = await baixarArquivo('http://x/a', destino, { buscar: resposta('conteudo'), log: mudo });
  assert.equal(r1.reutilizado, false);
  assert.equal(readFileSync(destino, 'utf8'), 'conteudo');
  const r2 = await baixarArquivo('http://x/a', destino, { buscar: () => { throw new Error('não devia baixar de novo'); }, log: mudo });
  assert.equal(r2.reutilizado, true);

  const incompleto = join(pasta(), 'b.csv');
  const curto = async () => new Response('abc', { status: 200, headers: { 'content-length': '10' } });
  await assert.rejects(baixarArquivo('http://x/b', incompleto, { buscar: curto, log: mudo }), /Download incompleto/);
  assert.equal(existsSync(incompleto), false);
  assert.equal(existsSync(`${incompleto}.parcial`), false);

  await assert.rejects(baixarArquivo('http://x/c', join(pasta(), 'c.csv'), { buscar: async () => new Response('x', { status: 404 }), log: mudo }), /respondeu 404/);
});

/* ═══════════════ etapa ANEEL ═══════════════ */

test('sincronizarAneel — amostras reais: grava usinas PJ, agrega empresas por CNPJ e registra o lote', async () => {
  await db.semearConcessionarias();
  const r = await sincronizarAneel({ pasta: pasta(), perfil: gestor, dryRun: false, semDownload: false, log: mudo, deps: { baixar: baixarAmostras } });

  assert.equal(r.gd.linhas, 60, 'o ZIP tem 60 PJ + 15 PF; o PF é descartado ainda na leitura');
  assert.equal(r.gd.usinas.length, 60);
  assert.ok(r.siga.usinas.length > 0);
  assert.equal(fake.db.usina_aneel.length, r.gd.usinas.length + r.siga.usinas.length);
  assert.ok(fake.db.usina_aneel.every((u) => /^\d{14}$/.test(u.cnpj) && u.tipo_consumidor === 'PJ'), 'só CNPJ de 14 dígitos: PF nunca entra');
  assert.ok(r.donos.has('12005360000165'), 'ELITE ENGENHARIA, da amostra real');

  assert.equal(r.empresas, fake.db.empresa.length);
  assert.equal(fake.db.empresa.length, r.donos.size, 'uma empresa por CNPJ de dono');
  assert.equal(fake.db.empresa.reduce((s, e) => s + e.qtd_usinas, 0), fake.db.usina_aneel.length, 'nenhuma usina fica sem empresa');
  const lote = fake.db.import_lote;
  assert.equal(lote.length, 1);
  assert.deepEqual([lote[0].tipo, lote[0].agente_id, lote[0].criados], ['aneel', 'p-gestor', r.gd.usinas.length + r.siga.usinas.length]);
});

test('sincronizarAneel — rodar duas vezes não duplica nada (upsert pela chave da usina)', async () => {
  await db.semearConcessionarias();
  const args = { pasta: pasta(), perfil: gestor, dryRun: false, semDownload: false, log: mudo, deps: { baixar: baixarAmostras } };
  await sincronizarAneel(args);
  const usinas = fake.db.usina_aneel.length;
  const empresas = fake.db.empresa.length;
  await sincronizarAneel(args);
  assert.equal(fake.db.usina_aneel.length, usinas);
  assert.equal(fake.db.empresa.length, empresas);
});

test('sincronizarAneel --dry-run — analisa tudo e NÃO grava nada', async () => {
  const r = await sincronizarAneel({ pasta: pasta(), perfil: gestor, dryRun: true, semDownload: false, log: mudo, deps: { baixar: baixarAmostras } });
  assert.equal(r.gd.usinas.length, 60);
  assert.ok(r.donos.size > 0);
  assert.ok(r.estimativaMB > 0, 'a simulação já diz quanto espaço ocuparia');
  assert.equal(fake.chamadas.filter((c) => c.op === 'upsert').length, 0, 'nenhuma gravação');
  assert.equal(fake.db.usina_aneel.length, 0);
});

/* ═══════════════ etapa Receita ═══════════════ */

const CAB = 'CNPJ;Razão Social;Situação Cadastral;Natureza Jurídica;Telefone 1;Telefone 2;E-mail;Município;UF';
const csv = (...linhas) => [CAB, ...linhas].join('\r\n');

test('importarCsvReceita — reimportar NÃO apaga telefone/e-mail enriquecidos nem os agregados da ANEEL', async () => {
  await db.putMuitos('empresa', [
    { cnpj: '10000000000000', razao_social: 'ANTIGA LTDA', telefone1: '1933334444', telefone2: '11999990000', email: 'enriquecido@opencnpj.org', qtd_usinas: 3, potencia_total_kw: 450, distribuidoras: ['ENEL-SP'] },
    { cnpj: '20000000000000', razao_social: 'OUTRA LTDA', telefone1: '2133330000', email: 'outra@x.com', qtd_usinas: 1 },
  ]);
  fake.chamadas.length = 0;
  const texto = csv(
    '10.000.000/0000-00;ANTIGA LTDA ATUALIZADA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP',                       // vazia de contato
    '20.000.000/0000-00;OUTRA LTDA;Ativa;Sociedade Empresária Limitada;(21) 3333-0000;;nova@x.com;Niterói;RJ',          // traz e-mail novo
    '30.000.000/0000-00;NOVA LTDA;Ativa;Sociedade Empresária Limitada;(11) 4444-5555;;;São Paulo;SP',                   // nova
  );
  const r = await importarCsvReceita({ texto, competencia: '2026-09', dryRun: false, log: mudo });
  assert.deepEqual([r.novas, r.atualizadas], [1, 2]);

  const a = fake.db.empresa.find((e) => e.cnpj === '10000000000000');
  assert.equal(a.razao_social, 'ANTIGA LTDA ATUALIZADA', 'o que veio preenchido vence');
  assert.equal(a.telefone1, '1933334444', 'telefone enriquecido continua');
  assert.equal(a.telefone2, '11999990000');
  assert.equal(a.email, 'enriquecido@opencnpj.org');
  assert.equal(a.qtd_usinas, 3, 'agregado da ANEEL continua');
  assert.deepEqual(a.distribuidoras, ['ENEL-SP']);
  assert.equal(fake.db.empresa.find((e) => e.cnpj === '20000000000000').email, 'nova@x.com');
  assert.equal(fake.db.empresa.find((e) => e.cnpj === '30000000000000').qtd_usinas, 0, 'empresa nova nasce com o padrão do banco');

  const lotes = fake.chamadas.filter((c) => c.tabela === 'empresa');
  assert.equal(lotes.length, 2, 'novas e existentes em requisições separadas');
});

test('MODELO do PostgREST — misturar linha nova (parcial) e existente num lote apagaria o dado: é o que gruposParaGravar evita', async () => {
  await db.putMuitos('empresa', [{ cnpj: '10000000000000', razao_social: 'ANTIGA', telefone1: '1933334444' }]);
  // lote misto: a existente SEM telefone + uma nova COM telefone → a união de colunas inclui telefone1
  await db.putMuitos('empresa', [{ cnpj: '10000000000000', razao_social: 'NOVA RAZAO' }, { cnpj: '30000000000000', razao_social: 'X', telefone1: '1144445555' }]);
  assert.equal(fake.db.empresa.find((e) => e.cnpj === '10000000000000').telefone1, null, 'o banco real se comporta assim: NULL por cima do telefone');
});

test('importarCsvReceita — PF/MEI, inativas, opt-out, repetidas e sem CNPJ ficam de fora', async () => {
  await db.putMuitos('supressao', [{ id: 's1', cnpj: '99999999000191', motivo: 'pediu' }]);
  const texto = csv(
    '11.222.333/0001-81;BOA LTDA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP',
    '55.555.555/0001-25;JOAO DA SILVA 12345678900;Ativa;Empresário (Individual);;;;Campinas;SP',
    '33.333.333/0001-44;BAIXADA LTDA;Baixada;Sociedade Empresária Limitada;;;;Campinas;SP',
    '99.999.999/0001-91;SUPRIMIDA LTDA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP',
    '11.222.333/0001-81;BOA REPETIDA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP',
    '123;SEM CNPJ;Ativa;;;;;;',
  );
  const r = await importarCsvReceita({ texto, dryRun: false, log: mudo });
  assert.deepEqual([r.novas, r.pf, r.inativas, r.suprimidas, r.repetidas, r.semId], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(fake.db.empresa.map((e) => e.cnpj), ['11222333000181']);
});

test('importarCsvReceita — CSV que não é da Base CNPJ é recusado antes de gravar', async () => {
  await assert.rejects(importarCsvReceita({ texto: 'Nome;Idade\r\nAna;30', dryRun: false, log: mudo }), /não tem coluna de CNPJ/);
  assert.equal(fake.chamadas.length, 0);
});

/** MCP de verdade (download, carga em SQLite e exportação), só com o download trocado pelos zips de fixture. */
const mcpComFixture = ({ faltamBytes = 0 } = {}) => {
  const mcp = {
    baixou: 0, // quantas vezes o download de verdade seria disparado
    planoDeDownload: async ({ competencia }) => ({
      competencia: competencia || '2026-09', pasta: criarPastaRfb(), faltamBytes, totalBytes: 6.3 * 1073741824,
      arquivos: [{}, {}], completos: faltamBytes ? 0 : 2,
    }),
    baixar: async ({ competencia }) => { mcp.baixou++; return { competencia: competencia || '2026-09', pasta: criarPastaRfb() }; },
    carregar: mcpCarregar.carregar, exportar: mcpExportar.exportar, resolverCnaes, pastaDados: pasta(),
  };
  return mcp;
};

test('sincronizarReceita — donos de usina entram de qualquer ramo, somados aos CNAEs de energia; EI e baixadas ficam fora', async () => {
  await db.putMuitos('empresa', [{ cnpj: '11111111000100', razao_social: 'SOLAR VALE ANTIGA', email: 'enriquecido@opencnpj.org', qtd_usinas: 2, telefone2: '11999990000' }]);
  const donos = new Set(['44444444000190']); // dono de usina do AGRO: nenhum CNAE de energia
  const r = await sincronizarReceita({ pasta: pasta(), perfil: gestor, dryRun: false, donos, opcoes: {}, log: mudo, deps: { mcp: mcpComFixture() } });

  assert.equal(r.competencia, '2026-09');
  assert.deepEqual(fake.db.empresa.map((e) => e.cnpj).sort(), ['11111111000100', '11111111000262', '44444444000190']);
  assert.equal(r.resumo.novas, 2);
  assert.equal(r.resumo.atualizadas, 1);
  const solar = fake.db.empresa.find((e) => e.cnpj === '11111111000100');
  assert.equal(solar.razao_social, 'SOLAR VALE ENERGIA LTDA');
  assert.equal(solar.email, 'contato@solarvale.com.br', 'a Receita traz o e-mail dela');
  assert.equal(solar.telefone2, '11999990000', 'o que a Receita não tem não apaga o que já estava');
  assert.equal(solar.qtd_usinas, 2);
  assert.ok(fake.db.empresa.every((e) => !/2135|individual/i.test(e.natureza_juridica || '')), 'empresário individual (pessoa física) não entra');
  assert.equal(fake.db.import_lote.length, 1);
  assert.match(fake.db.import_lote[0].nome, /Base CNPJ — sincronização 2026-09/);
});

test('sincronizarReceita --so-donos — só quem tem usina; sem donos conhecidos é erro explicado', async () => {
  const r = await sincronizarReceita({
    pasta: pasta(), perfil: gestor, dryRun: false, donos: new Set(['44444444000190']), opcoes: { soDonos: true }, log: mudo,
    deps: { mcp: mcpComFixture() },
  });
  assert.deepEqual(fake.db.empresa.map((e) => e.cnpj), ['44444444000190']);
  assert.equal(r.resumo.novas, 1);
  await assert.rejects(
    sincronizarReceita({ pasta: pasta(), perfil: gestor, dryRun: false, donos: new Set(), opcoes: { soDonos: true }, log: mudo, deps: { mcp: mcpComFixture(), cnpjsDeDonos: async () => new Set() } }),
    /nenhum no banco.*etapa "aneel"/s,
  );
});

test('sincronizarReceita — sem donos na memória, busca no banco (empresa com usina), paginando', async () => {
  await db.putMuitos('empresa', Array.from({ length: 2300 }, (_, i) => ({ cnpj: String(i).padStart(14, '0'), razao_social: `E${i}`, qtd_usinas: i % 2 })));
  const { cnpjsDeDonos } = await import('../scripts/sync/receita.mjs');
  const donos = await cnpjsDeDonos();
  assert.equal(donos.size, 1150, 'só quem tem qtd_usinas > 0, inclusive passando de 1000 por página');
});

test('sincronizarReceita --dry-run — com os zips já no disco, carrega e exporta localmente, mas não grava no banco', async () => {
  const mcp = mcpComFixture();
  const r = await sincronizarReceita({ pasta: pasta(), perfil: gestor, dryRun: true, donos: new Set(['44444444000190']), opcoes: {}, log: mudo, deps: { mcp } });
  assert.equal(r.resumo.novas, 3);
  assert.equal(mcp.baixou, 0, 'nada a baixar: não dispara o download');
  assert.equal(fake.chamadas.filter((c) => c.op === 'upsert').length, 0);
  assert.equal(fake.db.empresa.length, 0);
});

test('sincronizarReceita --dry-run — faltando ~6 GB, NÃO baixa: mostra quanto falta e avisa como incluir o download', async () => {
  const mcp = mcpComFixture({ faltamBytes: 5.2 * 1073741824 });
  const linhas = [];
  const r = await sincronizarReceita({
    pasta: pasta(), perfil: gestor, dryRun: true, donos: new Set(['44444444000190']), opcoes: {}, log: (l) => linhas.push(l), deps: { mcp },
  });
  assert.equal(r.pulada, true);
  assert.equal(r.resumo, null);
  assert.equal(r.donos, 1);
  assert.equal(mcp.baixou, 0);
  assert.equal(fake.chamadas.length, 0);
  assert.match(linhas.join('\n'), /faltam 5,20 GB.*não vou baixar na simulação/s);
  assert.match(linhas.join('\n'), /--baixar-receita/);
});

test('sincronizarReceita --dry-run --baixar-receita — aí sim baixa, e continua sem gravar no banco', async () => {
  const mcp = mcpComFixture({ faltamBytes: 5.2 * 1073741824 });
  const r = await sincronizarReceita({
    pasta: pasta(), perfil: gestor, dryRun: true, donos: new Set(['44444444000190']), opcoes: { baixarReceita: true }, log: mudo, deps: { mcp },
  });
  assert.equal(mcp.baixou, 1);
  assert.equal(r.resumo.novas, 3);
  assert.equal(fake.chamadas.filter((c) => c.op === 'upsert').length, 0);
});

test('sincronizarReceita sem --dry-run — baixa direto, sem consultar o plano antes', async () => {
  const mcp = mcpComFixture({ faltamBytes: 5.2 * 1073741824 });
  await sincronizarReceita({ pasta: pasta(), perfil: gestor, dryRun: false, donos: new Set(['44444444000190']), opcoes: {}, log: mudo, deps: { mcp } });
  assert.equal(mcp.baixou, 1);
  assert.ok(fake.db.empresa.length > 0);
});

test('sincronizarReceita --csv — importa um arquivo pronto e pula download e carga', async () => {
  const arq = join(pasta(), 'minha-exportacao.csv');
  writeFileSync(arq, `\uFEFF${csv('11.222.333/0001-81;BOA LTDA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP')}`);
  const r = await sincronizarReceita({ pasta: pasta(), perfil: gestor, dryRun: false, opcoes: { csv: arq }, log: mudo, deps: { mcp: null } });
  assert.equal(r.resumo.novas, 1);
  assert.equal(fake.db.empresa[0].cnpj, '11222333000181');
});

test('competenciaMaisRecente — escolhe o AAAA-MM mais novo e ignora o resto', () => {
  const raiz = pasta();
  for (const n of ['2026-07', '2026-09', '2026-08', 'lixo']) writeFileSync(join(raiz, n), '');
  // arquivos não são pastas, mas o nome é o que conta para a escolha
  assert.equal(competenciaMaisRecente(raiz), '2026-09');
  assert.equal(competenciaMaisRecente(join(raiz, 'nao-existe')), null);
});

/* ═══════════════ o comando inteiro (principal) ═══════════════ */

const { principal } = await import('../scripts/sincronizar.mjs');

/** Roda `principal` calando o log e com as credenciais do ambiente. */
async function rodar(args, { email = 'gestor@x.com', senha = 'segredo123' } = {}) {
  const guardado = { e: process.env.WATTSCOUT_EMAIL, s: process.env.WATTSCOUT_SENHA, log: console.error };
  process.env.WATTSCOUT_EMAIL = email;
  process.env.WATTSCOUT_SENHA = senha;
  const saida = [];
  console.error = (...a) => saida.push(a.join(' '));
  try {
    const codigo = await principal([...args, '--pasta', pasta()]);
    return { codigo, saida: saida.join('\n') };
  } finally {
    console.error = guardado.log;
    for (const [k, v] of [['WATTSCOUT_EMAIL', guardado.e], ['WATTSCOUT_SENHA', guardado.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const csvPronto = () => {
  const arq = join(pasta(), 'receita.csv');
  writeFileSync(arq, csv('11.222.333/0001-81;BOA LTDA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP'));
  return arq;
};

test('principal --dry-run — entra, simula e NÃO grava (nem pergunta nada)', async () => {
  const { codigo, saida } = await rodar(['--so', 'receita', '--csv', csvPronto(), '--dry-run']);
  assert.equal(codigo, 0);
  assert.match(saida, /Conectado: Marina \(gestor\)/);
  assert.match(saida, /SIMULAÇÃO — nada foi gravado/);
  assert.match(saida, /1 novas/);
  assert.equal(fake.chamadas.filter((c) => c.op === 'upsert').length, 0);
});

test('principal sem --sim e sem terminal — recusa gravar (execução agendada precisa dizer --sim)', async () => {
  await assert.rejects(rodar(['--so', 'receita', '--csv', csvPronto()]), /Sem terminal para confirmar.*--sim/);
  assert.equal(fake.db.empresa.length, 0);
});

test('principal --sim — grava e resume', async () => {
  const { codigo, saida } = await rodar(['--so', 'receita', '--csv', csvPronto(), '--sim']);
  assert.equal(codigo, 0);
  assert.deepEqual(fake.db.empresa.map((e) => e.cnpj), ['11222333000181']);
  assert.match(saida, /Receita: 1 empresas lidas · 1 novas · 0 atualizadas/);
});

test('principal — etapa que falha não derruba as outras e o código de saída avisa', async () => {
  const { codigo, saida } = await rodar(['--so', 'receita', '--csv', join(pasta(), 'nao-existe.csv'), '--sim']);
  assert.equal(codigo, 1);
  assert.match(saida, /✖ receita falhou/);
});

test('principal — senha errada ou conta de agente: erro claro antes de qualquer gravação', async () => {
  await assert.rejects(rodar(['--so', 'receita', '--csv', csvPronto(), '--sim'], { senha: 'errada' }), /Login recusado/);
  await assert.rejects(rodar(['--so', 'receita', '--csv', csvPronto(), '--sim'], { email: 'agente@x.com' }), /só gestor pode gravar/);
  assert.equal(fake.chamadas.filter((c) => c.op === 'upsert').length, 0);
});

test('principal — etapa distribuidoras semeia o cadastro uma vez (idempotente)', async () => {
  const a = await rodar(['--so', 'distribuidoras', '--sim']);
  const total = fake.db.concessionaria.length;
  assert.ok(total > 40);
  assert.ok(fake.db.backlog.length > 0);
  await rodar(['--so', 'distribuidoras', '--sim']);
  assert.equal(fake.db.concessionaria.length, total);
  assert.match(a.saida, /Distribuidoras: \d+ cadastradas/);
});

test('lerOpcoes — --baixar-receita chega até a etapa da Receita', () => {
  assert.equal(lerOpcoes(['--dry-run', '--baixar-receita']).receita.baixarReceita, true);
  assert.equal(lerOpcoes(['--dry-run']).receita.baixarReceita, false);
});

/* ═══════════════ recorte (plano grátis do Supabase: 500 MB) ═══════════════ */

const { filtrarPorPotencia, estimarMB, BYTES_POR_USINA } = await import('../scripts/sync/aneel.mjs');
const { bytesDaEmpresa } = await import('../scripts/sync/receita.mjs');

test('filtrarPorPotencia — a empresa fica INTEIRA ou sai, pela potência SOMADA (5 usinas de 20 kW = 100 kW)', () => {
  const us = [
    ...Array.from({ length: 5 }, (_, i) => ({ cnpj: 'A', cod_empreendimento: `a${i}`, potencia_kw: 20 })), // soma 100
    { cnpj: 'B', cod_empreendimento: 'b0', potencia_kw: 60 },                                              // soma 60
    { cnpj: 'C', cod_empreendimento: 'c0', potencia_kw: 500 },                                             // soma 500
  ];
  const r = filtrarPorPotencia(us, 75);
  assert.deepEqual([...new Set(r.usinas.map((u) => u.cnpj))].sort(), ['A', 'C']);
  assert.equal(r.usinas.filter((u) => u.cnpj === 'A').length, 5, 'nenhuma usina da empresa que ficou é cortada');
  assert.deepEqual([r.empresas, r.empresasTotal], [2, 3]);
  assert.equal(filtrarPorPotencia(us, 0).usinas.length, 7, 'sem mínimo: tudo');
  assert.equal(filtrarPorPotencia(us, 100).empresas, 2, 'igual ao mínimo entra');
  assert.equal(filtrarPorPotencia([], 75).empresas, 0);
});

test('estimarMB — usa os bytes por linha medidos na base real e escala com a quantidade', () => {
  assert.equal(estimarMB({ usinas: 0, empresas: 0 }), 0);
  const base = estimarMB({ usinas: 390149, empresas: 281857 });
  assert.ok(base > 240 && base < 270, `a base inteira da ANEEL media ~255 MB (deu ${base.toFixed(0)})`);
  assert.ok(Math.abs(estimarMB({ usinas: 1000, empresas: 0 }) - (1000 * BYTES_POR_USINA) / 1048576) < 1e-9);
});

test('sincronizarAneel --potencia-min — grava só as empresas que somam o mínimo, e o resumo conta o recorte', async () => {
  await db.semearConcessionarias();
  const inteira = await sincronizarAneel({ pasta: pasta(), perfil: gestor, dryRun: true, semDownload: false, log: mudo, deps: { baixar: baixarAmostras } });
  const kw = (u) => Number(u.potencia_kw || 0);
  const somaPorCnpj = new Map();
  for (const u of [...inteira.gd.usinas, ...inteira.siga.usinas]) somaPorCnpj.set(u.cnpj, (somaPorCnpj.get(u.cnpj) || 0) + kw(u));
  const corte = [...somaPorCnpj.values()].sort((a, b) => a - b)[Math.floor(somaPorCnpj.size / 2)]; // a mediana: deixa metade de fora

  fake.limpar();
  const r = await sincronizarAneel({
    pasta: pasta(), perfil: gestor, dryRun: false, semDownload: false, log: mudo, opcoes: { potenciaMin: corte }, deps: { baixar: baixarAmostras },
  });
  assert.ok(r.recorte.empresasDepois < r.recorte.empresasAntes);
  assert.equal(r.donos.size, r.recorte.empresasDepois);
  assert.equal(fake.db.usina_aneel.length, r.recorte.usinasDepois);
  assert.ok(fake.db.empresa.every((e) => e.potencia_total_kw >= corte), 'só entram empresas acima do mínimo');
  assert.ok(r.estimativaMB < inteira.estimativaMB, 'o recorte reduz o espaço estimado');
  assert.match(fake.db.import_lote[0].nome, new RegExp(`≥ ${String(corte).replace('.', '\\.')} kW`), 'o lote registra o recorte usado');
});

test('sincronizarAneel --uf — só usinas das UFs pedidas', async () => {
  await db.semearConcessionarias();
  const todas = await sincronizarAneel({ pasta: pasta(), perfil: gestor, dryRun: true, semDownload: false, log: mudo, deps: { baixar: baixarAmostras } });
  const ufDe = [...todas.gd.usinas, ...todas.siga.usinas].map((u) => u.uf).filter(Boolean);
  const uf = ufDe.sort((a, b) => ufDe.filter((x) => x === b).length - ufDe.filter((x) => x === a).length)[0]; // a UF mais comum
  fake.limpar();
  const r = await sincronizarAneel({ pasta: pasta(), perfil: gestor, dryRun: false, semDownload: false, log: mudo, opcoes: { uf: uf.toLowerCase() }, deps: { baixar: baixarAmostras } });
  assert.ok(fake.db.usina_aneel.length > 0 && fake.db.usina_aneel.length < ufDe.length);
  assert.ok(fake.db.usina_aneel.every((u) => u.uf === uf), `só ${uf}`);
  assert.deepEqual(r.recorte.uf, [uf]);
  assert.ok(r.gd.foraDaUf + r.siga.foraDaUf > 0);
});

test('bytesDaEmpresa — texto pelo tamanho, número 8 B, lista soma os itens; vazio não ocupa', () => {
  assert.equal(bytesDaEmpresa({ cnpj: '12345678000190' }), 14);
  assert.equal(bytesDaEmpresa({ matriz: true, capital_social: 1250000.5 }), 1 + 8);
  assert.equal(bytesDaEmpresa({ cnaes_secundarios: ['4321500', '4742300'] }), 4 + (7 + 4) * 2);
  assert.equal(bytesDaEmpresa({ razao_social: 'Á', email: null, socios: undefined }), 2, 'acento = 2 bytes; nulo e indefinido não contam');
  assert.equal(bytesDaEmpresa(null), 0);
});

test('importarCsvReceita — estima o espaço: linha nova pesa mais que a atualização (que só ganha campos)', async () => {
  await db.putMuitos('empresa', [{ cnpj: '10000000000000', razao_social: 'ANTIGA LTDA' }]);
  const texto = csv(
    '10.000.000/0000-00;ANTIGA LTDA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP',
    '30.000.000/0000-00;NOVA LTDA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP',
  );
  const r = await importarCsvReceita({ texto, dryRun: true, log: mudo });
  assert.deepEqual([r.novas, r.atualizadas], [1, 1]);
  assert.ok(r.bytes > 124 && r.estimativaMB > 0);
  const soNova = await importarCsvReceita({ texto: csv('30.000.000/0000-00;NOVA LTDA;Ativa;Sociedade Empresária Limitada;;;;Campinas;SP'), dryRun: true, log: mudo });
  assert.ok(r.bytes > soNova.bytes, 'a atualização também soma (campos novos), mas menos que uma linha inteira nova');
  assert.ok(soNova.bytes >= 124 + 'NOVA LTDA'.length);
});

test('lerOpcoes — recorte: --potencia-min numérico (aceita vírgula) e --uf valem para a ANEEL; entradas ruins são recusadas', () => {
  const o = lerOpcoes(['--potencia-min', '75,5', '--uf', 'SP,MG']);
  assert.deepEqual(o.aneel, { uf: 'SP,MG', potenciaMin: 75.5 });
  assert.equal(lerOpcoes([]).aneel.potenciaMin, null);
  assert.throws(() => lerOpcoes(['--potencia-min', 'muito']), /número de kW maior que zero/);
  assert.throws(() => lerOpcoes(['--potencia-min', '0']), /maior que zero/);
  assert.throws(() => lerOpcoes(['--potencia-min', '10', '--so', 'distribuidoras']), /valem para as etapas aneel e receita/);
  assert.equal(lerOpcoes(['--so-donos', '--uf', 'SP']).receita.soDonos, true, '--so-donos + --uf agora é válido: a UF recorta a ANEEL');
  assert.throws(() => lerOpcoes(['--so-donos', '--cnae', 'geracao']), /não combina com --cnae/);
});

/* ═══════════════ senha: campo com * e leitura do .env ═══════════════ */

const { lerSenha, carregarCredenciais } = await import('../scripts/sync/ambiente.mjs');
const { EventEmitter } = await import('node:events');

/** Um "terminal" mínimo: o que o lerSenha usa de process.stdin. */
function terminalFalso({ tty = true } = {}) {
  const e = new EventEmitter();
  Object.assign(e, { isTTY: tty, raw: false, pausado: false });
  e.setRawMode = (v) => { e.raw = v; };
  e.setEncoding = () => {};
  e.resume = () => { e.pausado = false; };
  e.pause = () => { e.pausado = true; };
  return e;
}
const telaFalsa = () => ({ texto: '', write(t) { this.texto += t; } });
const digitar = (entrada, ...pedacos) => { for (const p of pedacos) entrada.emit('data', p); };

test('lerSenha — mostra um * por tecla (nunca a senha), aceita Backspace e devolve o que sobrou', async () => {
  const entrada = terminalFalso();
  const tela = telaFalsa();
  const p = lerSenha('Senha: ', { entrada, saida: tela });
  assert.equal(entrada.raw, true, 'entra em modo raw para não ecoar');
  digitar(entrada, 'a', 'b', '\u007f', 'c', '\r');
  assert.equal(await p, 'ac');
  assert.equal(tela.texto, 'Senha: **\b \b*\n');
  assert.equal(entrada.raw, false, 'devolve o terminal ao normal');
  assert.equal(entrada.pausado, true);
  assert.equal(entrada.listenerCount('data'), 0, 'não deixa ouvinte pendurado');
});

test('lerSenha — colar a senha inteira de uma vez, com acento; o que vier depois do Enter é descartado', async () => {
  const entrada = terminalFalso();
  const p = lerSenha('Senha: ', { entrada, saida: telaFalsa() });
  digitar(entrada, 'sénha-çã1\rLIXO');
  assert.equal(await p, 'sénha-çã1');
});

test('lerSenha — setas e teclas de controle não entram na senha', async () => {
  const entrada = terminalFalso();
  const p = lerSenha('Senha: ', { entrada, saida: telaFalsa() });
  digitar(entrada, '\u001b[A', 'a', '\u001b[D', 'b', '\u0009', '\n');
  assert.equal(await p, 'ab');
});

test('lerSenha — Ctrl+C cancela e devolve o terminal ao normal', async () => {
  const entrada = terminalFalso();
  const p = lerSenha('Senha: ', { entrada, saida: telaFalsa() });
  digitar(entrada, 'a', '\u0003');
  await assert.rejects(p, /Cancelado/);
  assert.equal(entrada.raw, false);
});

test('lerSenha — sem terminal de verdade (Git Bash/pipe), explica o que fazer em vez de ficar mudo', async () => {
  await assert.rejects(lerSenha('Senha: ', { entrada: terminalFalso({ tty: false }), saida: telaFalsa() }), /não permite digitar a senha.*\.env\.local/s);
});

test('carregarCredenciais — lê .env.local e .env, só WATTSCOUT_*, sem passar por cima do ambiente real', () => {
  const raiz = pasta();
  writeFileSync(join(raiz, '.env.local'), 'WATTSCOUT_EMAIL=local@x.com\n');
  writeFileSync(join(raiz, '.env'), 'WATTSCOUT_EMAIL=env@x.com\nWATTSCOUT_SENHA=do-env\nOUTRO_SEGREDO=nao-pode-vazar\nNODE_OPTIONS=--inspect\n');
  const amb = {};
  assert.deepEqual(carregarCredenciais(raiz, amb), ['.env.local', '.env']);
  assert.deepEqual(amb, { WATTSCOUT_EMAIL: 'local@x.com', WATTSCOUT_SENHA: 'do-env' }, '.env.local vence o .env; variáveis de outros projetos ficam de fora');
  const real = { WATTSCOUT_SENHA: 'do-ambiente' };
  carregarCredenciais(raiz, real);
  assert.equal(real.WATTSCOUT_SENHA, 'do-ambiente', 'o ambiente real vence os arquivos');
  assert.deepEqual(carregarCredenciais(pasta(), {}), [], 'sem arquivo nenhum não é erro');
});

test('principal — credenciais vindas do .env funcionam sem perguntar nada', async () => {
  const antes = { e: process.env.WATTSCOUT_EMAIL, s: process.env.WATTSCOUT_SENHA };
  delete process.env.WATTSCOUT_EMAIL;
  delete process.env.WATTSCOUT_SENHA;
  const raizFalsa = pasta();
  writeFileSync(join(raizFalsa, '.env'), 'WATTSCOUT_EMAIL=gestor@x.com\nWATTSCOUT_SENHA=segredo123\n');
  carregarCredenciais(raizFalsa); // o que `credenciais()` faz com a raiz do repositório
  try {
    const { codigo, saida } = await rodar(['--so', 'receita', '--csv', csvPronto(), '--dry-run'], { email: process.env.WATTSCOUT_EMAIL, senha: process.env.WATTSCOUT_SENHA });
    assert.equal(codigo, 0);
    assert.match(saida, /Conectado: Marina/);
  } finally {
    for (const [k, v] of [['WATTSCOUT_EMAIL', antes.e], ['WATTSCOUT_SENHA', antes.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
