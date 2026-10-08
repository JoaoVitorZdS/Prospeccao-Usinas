#!/usr/bin/env node
// baixar.mjs — baixa os arquivos mensais do CNPJ dos dados abertos da Receita Federal.
//
// Fonte oficial: o compartilhamento público da Receita (Nextcloud) em arquivos.receitafederal.gov.br.
// É download direto de dado aberto — sem login, sem raspagem e sem passar pelo Casa dos Dados.
// (O endereço antigo dadosabertos.rfb.gov.br/CNPJ/ saiu do ar; este é o que responde hoje.)
//
// Retomável: se a conexão cair, rode de novo — continua do byte onde parou. Arquivos já completos
// (tamanho igual ao do servidor) são pulados.
//
//   node etl/baixar.mjs                       # competência mais recente, tudo
//   node etl/baixar.mjs --competencia 2026-09 # um mês específico
//   node etl/baixar.mjs --so-tabelas          # só as tabelas pequenas (CNAE, município, natureza…)
//   node etl/baixar.mjs --sem-socios          # pula os 10 arquivos de sócios (~560 MB)
//   node etl/baixar.mjs --partes 0,1          # só as partes 0 e 1 de cada família (para teste)
//   node etl/baixar.mjs --listar              # só lista meses e arquivos, sem baixar

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { lerArgumentos } from './args.mjs';
import { PASTA_DADOS } from '../src/banco.mjs';

// Token do compartilhamento público oficial (aparece na própria URL pública da Receita; não é segredo).
const TOKEN = process.env.RFB_COMPARTILHAMENTO || 'YggdBLfdninEJX9';
const BASE = process.env.RFB_WEBDAV || 'https://arquivos.receitafederal.gov.br/public.php/webdav';
const AUTORIZACAO = `Basic ${Buffer.from(`${TOKEN}:`).toString('base64')}`;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

async function propfind(caminho) {
  const r = await fetch(`${BASE}/${caminho}`, { method: 'PROPFIND', headers: { Authorization: AUTORIZACAO, Depth: '1' } });
  if (r.status !== 207) throw new Error(`A Receita respondeu ${r.status} ao listar "${caminho}".`);
  return r.text();
}

/** Meses disponíveis (AAAA-MM), do mais antigo ao mais recente. */
export async function listarCompetencias() {
  const xml = await propfind('');
  return [...xml.matchAll(/<d:href>[^<]*\/(\d{4}-\d{2})\/<\/d:href>/g)].map((m) => m[1]).sort();
}

/** Arquivos de um mês: [{ nome, tamanho }]. */
export async function listarArquivos(competencia) {
  const xml = await propfind(`${competencia}/`);
  const itens = [];
  for (const bloco of xml.split('<d:response>').slice(1)) {
    const href = bloco.match(/<d:href>([^<]*)</)?.[1];
    const tamanho = bloco.match(/getcontentlength>(\d+)</)?.[1];
    if (href && tamanho) itens.push({ nome: decodeURIComponent(href.split('/').pop()), tamanho: Number(tamanho) });
  }
  return itens;
}

const FAMILIA = /^(Empresas|Estabelecimentos|Socios)(\d+)\.zip$/;
const TABELAS = ['Cnaes.zip', 'Municipios.zip', 'Naturezas.zip', 'Qualificacoes.zip', 'Motivos.zip'];

/** Aplica as opções (--so-tabelas, --sem-socios, --partes) à lista de arquivos do mês. */
export function selecionar(arquivos, { soTabelas = false, semSocios = false, partes = null } = {}) {
  return arquivos.filter(({ nome }) => {
    if (TABELAS.includes(nome)) return true;
    const m = nome.match(FAMILIA);
    if (!m || soTabelas) return false;
    if (semSocios && m[1] === 'Socios') return false;
    return !partes || partes.includes(m[2]);
  });
}

async function baixarArquivo({ competencia, nome, tamanho }, destino) {
  const caminho = resolve(destino, nome);
  for (let tentativa = 1; tentativa <= 6; tentativa++) {
    const atual = existsSync(caminho) ? statSync(caminho).size : 0;
    if (atual === tamanho) { log(`  ✓ ${nome} (já completo)`); return caminho; }
    if (atual > tamanho) throw new Error(`${nome} local (${atual}) é maior que o do servidor (${tamanho}) — apague e baixe de novo.`);
    try {
      const headers = { Authorization: AUTORIZACAO, ...(atual ? { Range: `bytes=${atual}-` } : {}) };
      const r = await fetch(`${BASE}/${competencia}/${nome}`, { headers });
      if (!(r.status === 200 || r.status === 206)) throw new Error(`HTTP ${r.status}`);
      // 200 com arquivo parcial no disco = o servidor ignorou o Range: recomeça do zero
      const flags = atual && r.status === 206 ? 'a' : 'w';
      log(`  ↓ ${nome} ${(tamanho / 1048576).toFixed(0)} MB${atual && flags === 'a' ? ` (retomando de ${(atual / 1048576).toFixed(0)} MB)` : ''}`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(caminho, { flags }));
    } catch (e) {
      log(`  ! ${nome}: ${e.message} — tentativa ${tentativa}/6`);
      await dormir(2000 * tentativa);
    }
  }
  const final = existsSync(caminho) ? statSync(caminho).size : 0;
  if (final !== tamanho) throw new Error(`Não consegui baixar ${nome} por completo (${final}/${tamanho} bytes).`);
  return caminho;
}

/** Baixa o que foi selecionado para `<destino>/<competencia>/`. Devolve { competencia, pasta, arquivos }. */
export async function baixar({ competencia, destino = resolve(PASTA_DADOS, 'downloads'), ...selecao } = {}) {
  const meses = await listarCompetencias();
  const mes = competencia || meses.at(-1);
  if (!meses.includes(mes)) throw new Error(`Competência ${mes} não existe. Disponíveis: ${meses.slice(-6).join(', ')}…`);
  const pasta = resolve(destino, mes);
  mkdirSync(pasta, { recursive: true });
  const arquivos = selecionar(await listarArquivos(mes), selecao);
  if (!arquivos.length) throw new Error('Nenhum arquivo selecionado — confira --partes e as demais opções.');
  const total = arquivos.reduce((s, a) => s + a.tamanho, 0);
  log(`Competência ${mes}: ${arquivos.length} arquivo(s), ${(total / 1073741824).toFixed(2)} GB → ${pasta}`);
  for (const a of arquivos) await baixarArquivo({ competencia: mes, ...a }, pasta);
  return { competencia: mes, pasta, arquivos: arquivos.map((a) => a.nome) };
}

// ── linha de comando ──
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { opcoes } = lerArgumentos(process.argv.slice(2), {
      competencia: 'valor', dir: 'valor', partes: 'valor', 'so-tabelas': 'flag', 'sem-socios': 'flag', listar: 'flag',
    });
    if (opcoes.listar) {
      const meses = await listarCompetencias();
      const mes = opcoes.competencia || meses.at(-1);
      log(`Meses disponíveis: ${meses.join(' ')}`);
      for (const a of await listarArquivos(mes)) log(`  ${a.nome.padEnd(24)} ${(a.tamanho / 1048576).toFixed(1).padStart(9)} MB`);
    } else {
      const r = await baixar({
        competencia: opcoes.competencia,
        destino: opcoes.dir && resolve(opcoes.dir),
        soTabelas: !!opcoes['so-tabelas'],
        semSocios: !!opcoes['sem-socios'],
        partes: opcoes.partes ? opcoes.partes.split(',').map((x) => x.trim()) : null,
      });
      log(`Pronto: ${r.pasta}`);
    }
  } catch (e) {
    console.error(`\nErro: ${e.message}`);
    process.exit(1);
  }
}
