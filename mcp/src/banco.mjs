// banco.mjs — o SQLite local com a base de CNPJ filtrada (node:sqlite, sem dependência nativa).
//
// O arquivo é gerado por `etl/carregar.mjs` e lido (somente leitura) pelo servidor MCP. Fica em
// mcp/dados/ — fora do git e fora do deploy: tem dado cadastral em massa.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ_MCP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PASTA_DADOS = process.env.CNPJ_DADOS || resolve(RAIZ_MCP, 'dados');
export const CAMINHO_PADRAO_DB = process.env.CNPJ_DB || resolve(PASTA_DADOS, 'cnpj.sqlite');

export const SCHEMA = `
create table meta (chave text primary key, valor text);
create table cnae (codigo text primary key, descricao text not null, busca text not null);
create table municipio (codigo text primary key, nome text not null, busca text not null);
create table natureza (codigo text primary key, descricao text not null);
create table qualificacao (codigo text primary key, descricao text not null);

create table estabelecimento (
  cnpj text primary key, cnpj_basico text not null, matriz integer not null,
  nome_fantasia text, situacao text not null, data_situacao text, abertura text,
  cnae_principal text, cnaes_secundarios text,
  logradouro text, numero text, complemento text, bairro text, cep text, uf text, municipio_codigo text,
  telefone1 text, telefone2 text, email text
) without rowid;

-- principal e secundários numa tabela só, para filtrar por qualquer CNAE com índice
create table estab_cnae (
  cnpj text not null, cnae text not null, principal integer not null,
  primary key (cnpj, cnae)
) without rowid;

create table empresa (
  cnpj_basico text primary key, razao_social text, natureza_codigo text, porte text, capital_social real
) without rowid;

create table socio (
  cnpj_basico text not null, tipo text, nome text, qualificacao_codigo text, entrada text, faixa_etaria text
);
`;

// criados DEPOIS da carga em massa (inserir com índice é bem mais lento)
export const INDICES = `
create index if not exists estab_basico_idx on estabelecimento (cnpj_basico);
create index if not exists estab_uf_idx on estabelecimento (uf);
create index if not exists estab_situacao_idx on estabelecimento (situacao);
create index if not exists estab_municipio_idx on estabelecimento (municipio_codigo);
create index if not exists estab_cnae_principal_idx on estabelecimento (cnae_principal);
create index if not exists estab_cnae_idx on estab_cnae (cnae);
create index if not exists socio_basico_idx on socio (cnpj_basico);
`;

/** Normaliza para busca: sem acento, maiúsculo. */
export const normalizarBusca = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

export function criarBanco(caminho) {
  mkdirSync(dirname(caminho), { recursive: true });
  const db = new DatabaseSync(caminho);
  db.exec('pragma journal_mode = off; pragma synchronous = off; pragma temp_store = memory;');
  db.exec(SCHEMA);
  return db;
}

export function abrirBanco(caminho = CAMINHO_PADRAO_DB, { somenteLeitura = true } = {}) {
  if (!existsSync(caminho)) {
    const e = new Error(`A base de CNPJ ainda não foi carregada (não achei ${caminho}). `
      + 'Rode: pnpm --dir mcp baixar && pnpm --dir mcp carregar (veja mcp/README.md).');
    e.codigo = 'SEM_BASE';
    throw e;
  }
  return new DatabaseSync(caminho, { readOnly: somenteLeitura });
}

/** Executa `fn` dentro de BEGIN/COMMIT (ROLLBACK se lançar). */
export function emTransacao(db, fn) {
  db.exec('begin');
  try { const r = fn(); db.exec('commit'); return r; } catch (e) { db.exec('rollback'); throw e; }
}

export function metadados(db) {
  const meta = Object.fromEntries(db.prepare('select chave, valor from meta').all().map((r) => [r.chave, r.valor]));
  const n = (t) => db.prepare(`select count(*) as n from ${t}`).get().n;
  return {
    ...meta,
    estabelecimentos: n('estabelecimento'),
    empresas: n('empresa'),
    socios: n('socio'),
    cnaes_cadastrados: n('cnae'),
  };
}
