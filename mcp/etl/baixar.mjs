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
import { Readable, Transform } from 'node:stream';
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

const MB = 1048576;
const GB = 1073741824;
const SEM_DADOS_MS = 60000; // sem receber nem um byte por este tempo: aborta e retoma (o servidor às vezes só "pendura")

/** Uma linha de progresso: "  Empresas0.zip 373/537 MB (69%) · 3,6 MB/s · faltam ~46 s". Pura — testada. */
export function textoDeProgresso({ nome, feitos, tamanho, bytesPorSegundo }) {
  const pct = tamanho ? Math.floor((feitos / tamanho) * 100) : 0;
  const vel = bytesPorSegundo > 0 ? `${(bytesPorSegundo / MB).toFixed(1).replace('.', ',')} MB/s` : '— MB/s';
  const falta = bytesPorSegundo > 0 ? Math.ceil((tamanho - feitos) / bytesPorSegundo) : null;
  const eta = falta == null ? '' : falta >= 120 ? ` · faltam ~${Math.round(falta / 60)} min` : ` · faltam ~${falta} s`;
  return `  ${nome} ${Math.round(feitos / MB)}/${Math.round(tamanho / MB)} MB (${pct}%) · ${vel}${eta}`;
}

/**
 * Registra o avanço de um download e escreve UMA linha de progresso a cada `intervaloMs` — o mês inteiro leva
 * ~30 min e, sem isto, parece travado. `agora` é injetável para o teste.
 */
export function criarProgresso({ nome, tamanho, inicial = 0, escrever = log, intervaloMs = 15000, agora = Date.now }) {
  let feitos = inicial;
  let tUltimo = agora();
  let bytesUltimo = inicial;
  return {
    avancar(bytes) {
      feitos += bytes;
      const t = agora();
      if (t - tUltimo < intervaloMs) return;
      escrever(textoDeProgresso({ nome, feitos, tamanho, bytesPorSegundo: (feitos - bytesUltimo) / ((t - tUltimo) / 1000) }));
      tUltimo = t;
      bytesUltimo = feitos;
    },
    get feitos() { return feitos; },
  };
}

/**
 * O que falta baixar, sem baixar nada: compara o tamanho de cada arquivo no servidor com o que já está em `pasta`.
 * `arquivos`: [{ nome, tamanho }]. Devolve { pasta, arquivos:[…, local], totalBytes, faltamBytes, completos }.
 */
export function calcularPlano(arquivos, pasta) {
  const itens = arquivos.map((a) => {
    const caminho = resolve(pasta, a.nome);
    return { ...a, local: existsSync(caminho) ? statSync(caminho).size : 0 };
  });
  return {
    pasta,
    arquivos: itens,
    totalBytes: itens.reduce((s, a) => s + a.tamanho, 0),
    faltamBytes: itens.reduce((s, a) => s + Math.max(0, a.tamanho - a.local), 0),
    completos: itens.filter((a) => a.local === a.tamanho).length,
  };
}

async function escolherMes(competencia) {
  const meses = await listarCompetencias();
  const mes = competencia || meses.at(-1);
  if (!meses.includes(mes)) throw new Error(`Competência ${mes} não existe. Disponíveis: ${meses.slice(-6).join(', ')}…`);
  return mes;
}

/** Plano de download de um mês (o que existe no servidor × o que já está no disco), sem baixar. */
export async function planoDeDownload({ competencia, destino = resolve(PASTA_DADOS, 'downloads'), ...selecao } = {}) {
  const mes = await escolherMes(competencia);
  const arquivos = selecionar(await listarArquivos(mes), selecao);
  if (!arquivos.length) throw new Error('Nenhum arquivo selecionado — confira --partes e as demais opções.');
  return { competencia: mes, ...calcularPlano(arquivos, resolve(destino, mes)) };
}

async function baixarArquivo({ competencia, nome, tamanho, posicao = '' }, destino) {
  const caminho = resolve(destino, nome);
  for (let tentativa = 1; tentativa <= 6; tentativa++) {
    const atual = existsSync(caminho) ? statSync(caminho).size : 0;
    if (atual === tamanho) { log(`  ✓ ${posicao}${nome} (completo)`); return caminho; }
    if (atual > tamanho) throw new Error(`${nome} local (${atual}) é maior que o do servidor (${tamanho}) — apague e baixe de novo.`);
    const controle = new AbortController();
    let vigia = null;
    const armar = () => { clearTimeout(vigia); vigia = setTimeout(() => controle.abort(new Error(`sem receber dados há ${SEM_DADOS_MS / 1000} s`)), SEM_DADOS_MS); };
    try {
      const headers = { Authorization: AUTORIZACAO, ...(atual ? { Range: `bytes=${atual}-` } : {}) };
      armar();
      const r = await fetch(`${BASE}/${competencia}/${nome}`, { headers, signal: controle.signal });
      if (!(r.status === 200 || r.status === 206)) throw new Error(`HTTP ${r.status}`);
      // 200 com arquivo parcial no disco = o servidor ignorou o Range: recomeça do zero
      const retomando = atual && r.status === 206;
      const flags = retomando ? 'a' : 'w';
      log(`  ↓ ${posicao}${nome} ${(tamanho / MB).toFixed(0)} MB${retomando ? ` (retomando de ${(atual / MB).toFixed(0)} MB)` : ''}`);
      const progresso = criarProgresso({ nome, tamanho, inicial: retomando ? atual : 0 });
      const acompanhar = new Transform({
        transform(pedaco, _enc, pronto) { armar(); progresso.avancar(pedaco.length); pronto(null, pedaco); },
      });
      await pipeline(Readable.fromWeb(r.body), acompanhar, createWriteStream(caminho, { flags }));
    } catch (e) {
      const motivo = controle.signal.aborted ? controle.signal.reason?.message || e.message : e.message;
      log(`  ! ${nome}: ${motivo} — tentativa ${tentativa}/6 (retoma de onde parou)`);
      await dormir(2000 * tentativa);
    } finally {
      clearTimeout(vigia);
    }
  }
  const final = existsSync(caminho) ? statSync(caminho).size : 0;
  if (final !== tamanho) throw new Error(`Não consegui baixar ${nome} por completo (${final}/${tamanho} bytes).`);
  return caminho;
}

/** Baixa o que foi selecionado para `<destino>/<competencia>/`. Devolve { competencia, pasta, arquivos }. */
export async function baixar({ competencia, destino = resolve(PASTA_DADOS, 'downloads'), ...selecao } = {}) {
  const plano = await planoDeDownload({ competencia, destino, ...selecao });
  const { competencia: mes, pasta, arquivos } = plano;
  mkdirSync(pasta, { recursive: true });
  log(`Competência ${mes}: ${arquivos.length} arquivo(s), ${(plano.totalBytes / GB).toFixed(2)} GB → ${pasta}`);
  if (plano.faltamBytes < plano.totalBytes) {
    log(`  já no disco: ${plano.completos} arquivo(s) completo(s); faltam ${(plano.faltamBytes / GB).toFixed(2)} GB`);
  }
  let feitos = plano.totalBytes - plano.faltamBytes;
  for (const [i, a] of arquivos.entries()) {
    await baixarArquivo({ competencia: mes, nome: a.nome, tamanho: a.tamanho, posicao: `[${i + 1}/${arquivos.length}] ` }, pasta);
    feitos += Math.max(0, a.tamanho - a.local);
    log(`  → ${(feitos / GB).toFixed(2)} de ${(plano.totalBytes / GB).toFixed(2)} GB`);
  }
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
