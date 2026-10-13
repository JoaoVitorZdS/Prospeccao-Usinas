// aneel.mjs — etapa "aneel" do `pnpm sincronizar`: baixa a base de usinas da ANEEL, filtra PJ e grava em `usina_aneel`.
//
// A decisão de cada linha (PJ ou PF, dono, distribuidora, código) é a da tela de Importar: `analisarAneel`
// (js/aneel-importacao.js) é o mesmo módulo. Aqui só mudam a origem do arquivo (download em vez de arrastar) e o
// RECORTE opcional (UF e potência), que existe porque a base inteira ocupa metade do plano grátis do Supabase.

import { openAsBlob, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RECURSOS_ANEEL, lerZipCsvStream } from '../../js/aneel.js';
import { CAMPOS_ANEEL, autoMapear, aplicarMapa, decodificar, parseTexto } from '../../js/parse.js';
import { slug } from '../../js/util.js';
import { CONCESSIONARIAS } from '../../js/seed.js';
import { analisarAneel } from '../../js/aneel-importacao.js';
import * as db from '../../js/db.js';
import { baixarArquivo } from './baixar.mjs';

const LOTE_ANALISE = 20000; // linhas analisadas por vez
const LOTE_GRAVACAO = 20000; // usinas por rodada de gravação (o db.putMuitos ainda fatia em 2000 por requisição)

// Bytes que cada linha ocupa no Postgres do Supabase, índices incluídos. MEDIDO com a base real da ANEEL
// (390.149 usinas = ~151 MB; 281.857 empresas agregadas = ~104 MB) — é estimativa, não leitura do seu banco.
export const BYTES_POR_USINA = 406;
export const BYTES_POR_EMPRESA_ANEEL = 388;

/** Lê o ZIP da GD filtrando PJ EM STREAMING (4,6 milhões de linhas, ~92% PF que nunca ficam na memória). */
export async function lerGdZip(caminho, { log = () => {} } = {}) {
  const arquivo = await openAsBlob(caminho);
  let cabecalho = null;
  let idxTipo = -1;
  let lidas = 0;
  let ultimoPct = 0;
  const linhas = [];
  await lerZipCsvStream(arquivo, {
    onCabecalho: (c) => {
      cabecalho = c;
      idxTipo = c.map(slug).indexOf('sigtipoconsumidor');
      if (idxTipo < 0) log('  ! coluna de tipo (PJ/PF) não encontrada — mantendo todas as linhas');
    },
    onLinha: (l) => { lidas++; if (idxTipo < 0 || l[idxTipo] === 'PJ') linhas.push(l); },
    onProgresso: ({ bytesLidos, bytesTotal }) => {
      const pct = bytesTotal ? Math.floor((bytesLidos / bytesTotal) * 100) : 0;
      if (pct >= ultimoPct + 10) { ultimoPct = pct - (pct % 10); log(`  ${pct}% do ZIP · ${linhas.length.toLocaleString('pt-BR')} usinas PJ até agora`); }
    },
  });
  if (!cabecalho) throw new Error(`${caminho} não tem cabeçalho de CSV — o arquivo da ANEEL mudou?`);
  return { cabecalho, linhas, lidas };
}

/** SIGA: CSV simples (~10 MB), já com o dono em texto livre. */
export function lerSigaCsv(caminho) {
  const [cabecalho, ...linhas] = parseTexto(decodificar(readFileSync(caminho)));
  if (!cabecalho) throw new Error(`${caminho} está vazio.`);
  return { cabecalho, linhas, lidas: linhas.length };
}

/**
 * Casador de distribuidora por NOME, com o cadastro do banco — ou, se o banco ainda está vazio (primeira execução
 * em --dry-run), com a lista embutida no app. Mesmas funções puras que `db.casarConcessionaria` usa.
 */
export async function criarCasador() {
  const cadastro = await db.todos('concessionaria');
  const indice = db.montarIndiceAliases(cadastro.length ? cadastro : CONCESSIONARIAS);
  return async (texto, opcoes) => db.casarComIndice(indice, texto, opcoes);
}

/**
 * Analisa as linhas em lotes e devolve as usinas (NÃO grava: o recorte por potência precisa do total de cada
 * empresa, que só se conhece depois de ler tudo). `ufs`: Set de siglas ou null.
 */
export async function analisarLinhas({ cabecalho, linhas, rotulo, log, casar, ufs = null }) {
  const mapa = autoMapear(cabecalho, CAMPOS_ANEEL);
  if (mapa.cnpj == null && mapa.proprietario_regime == null) {
    throw new Error(`${rotulo}: não achei coluna de CNPJ nem de proprietário no cabeçalho — o layout da ANEEL mudou?`);
  }
  const r = { linhas: linhas.length, usinas: [], pf: 0, semId: 0, repetidas: 0, foraDaUf: 0, semDistribuidora: new Map() };
  for (let i = 0; i < linhas.length; i += LOTE_ANALISE) {
    const brutos = aplicarMapa(linhas.slice(i, i + LOTE_ANALISE), mapa).map((b) => ({ ...b, _linha: b._linha + i }));
    const { itens } = await analisarAneel(brutos, { casarConcessionaria: casar });
    for (const it of itens) {
      if (it.veredito === 'novo') {
        if (ufs && !ufs.has(it.usina.uf)) { r.foraDaUf++; continue; }
        r.usinas.push(it.usina);
        if (it.avisoConc) r.semDistribuidora.set(it.avisoConc, (r.semDistribuidora.get(it.avisoConc) || 0) + 1);
      } else if (it.veredito === 'pf') r.pf++;
      else if (it.veredito === 'sem_id') r.semId++;
      else if (it.veredito === 'duplicado_lote') r.repetidas++;
    }
    log(`  ${rotulo}: ${Math.min(i + LOTE_ANALISE, linhas.length).toLocaleString('pt-BR')}/${linhas.length.toLocaleString('pt-BR')} linhas analisadas`);
  }
  return r;
}

/**
 * Recorte por POTÊNCIA SOMADA DA EMPRESA — o mesmo critério com que a tela Prospecção prioriza. Fica a empresa
 * inteira (todas as suas usinas) ou nenhuma; uma empresa com 5 usinas de 20 kW (100 kW) passa de um mínimo de 75.
 * Pura — testada.
 */
export function filtrarPorPotencia(usinas, potenciaMin) {
  const total = new Map();
  for (const u of usinas) total.set(u.cnpj, (total.get(u.cnpj) || 0) + Number(u.potencia_kw || 0));
  if (!potenciaMin) return { usinas, empresas: total.size, empresasTotal: total.size };
  const ficam = new Set([...total].filter(([, kw]) => kw >= potenciaMin).map(([cnpj]) => cnpj));
  return { usinas: usinas.filter((u) => ficam.has(u.cnpj)), empresas: ficam.size, empresasTotal: total.size };
}

/** Megabytes estimados que estas usinas e empresas vão ocupar no banco. */
export const estimarMB = ({ usinas, empresas }) => (usinas * BYTES_POR_USINA + empresas * BYTES_POR_EMPRESA_ANEEL) / 1048576;

/**
 * Etapa completa. `opcoes`: { uf: 'SP,MG'|null, potenciaMin: kW|null }. `deps` existe para os testes (sem rede).
 * @returns {{ gd, siga, donos:Set<string>, empresas:number, recasadas:object|null, recorte, estimativaMB }}
 */
export async function sincronizarAneel({ pasta, perfil, dryRun, semDownload, log, opcoes = {}, deps = {} }) {
  const baixar = deps.baixar || baixarArquivo;
  const gravar = deps.gravar || db.putMuitos;
  const dir = resolve(pasta, 'aneel');
  const zip = resolve(dir, 'aneel-gd.zip');
  const csv = resolve(dir, 'aneel-siga.csv');
  const ufs = opcoes.uf ? new Set(opcoes.uf.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)) : null;
  const potenciaMin = Number(opcoes.potenciaMin) > 0 ? Number(opcoes.potenciaMin) : 0;

  log('ANEEL: obtendo os arquivos');
  await baixar(RECURSOS_ANEEL.gdZip.url, zip, { log, reaproveitar: semDownload });
  await baixar(RECURSOS_ANEEL.sigaCsv.url, csv, { log, reaproveitar: semDownload });

  const casar = await criarCasador();

  log('ANEEL: GD (todas as usinas) — filtrando PJ');
  const gdLido = await lerGdZip(zip, { log });
  log(`  ${gdLido.lidas.toLocaleString('pt-BR')} linhas no ZIP · ${gdLido.linhas.length.toLocaleString('pt-BR')} PJ`);
  const gd = await analisarLinhas({ ...gdLido, rotulo: 'GD', log, casar, ufs });
  gdLido.linhas.length = 0; // libera a memória antes do SIGA

  log('ANEEL: SIGA (inclui usinas ainda em construção)');
  const sigaLido = lerSigaCsv(csv);
  const siga = await analisarLinhas({ ...sigaLido, rotulo: 'SIGA', log, casar, ufs });

  // ── recorte por potência somada da empresa ──
  const todas = [...gd.usinas, ...siga.usinas];
  const corte = filtrarPorPotencia(todas, potenciaMin);
  const recorte = {
    uf: ufs ? [...ufs] : null, potenciaMin: potenciaMin || null,
    usinasAntes: todas.length, usinasDepois: corte.usinas.length, empresasAntes: corte.empresasTotal, empresasDepois: corte.empresas,
  };
  if (ufs || potenciaMin) {
    log(`ANEEL: recorte${ufs ? ` UF ${[...ufs].join(',')}` : ''}${potenciaMin ? ` · empresas com ≥ ${potenciaMin} kW somados` : ''}: `
      + `${corte.empresas.toLocaleString('pt-BR')} de ${corte.empresasTotal.toLocaleString('pt-BR')} empresas · `
      + `${corte.usinas.length.toLocaleString('pt-BR')} de ${todas.length.toLocaleString('pt-BR')} usinas`);
  }
  const donos = new Set(corte.usinas.map((u) => u.cnpj));
  const estimativaMB = estimarMB({ usinas: corte.usinas.length, empresas: donos.size });

  // ── gravar ──
  if (!dryRun) {
    log(`ANEEL: gravando ${corte.usinas.length.toLocaleString('pt-BR')} usinas`);
    for (let i = 0; i < corte.usinas.length; i += LOTE_GRAVACAO) {
      await gravar('usina_aneel', corte.usinas.slice(i, i + LOTE_GRAVACAO));
      log(`  usinas: ${Math.min(i + LOTE_GRAVACAO, corte.usinas.length).toLocaleString('pt-BR')}/${corte.usinas.length.toLocaleString('pt-BR')} gravadas`);
    }
  }

  let recasadas = null;
  let empresas = 0;
  if (!dryRun) {
    try {
      log('ANEEL: ligando usinas sem código à distribuidora (só casamento exato)');
      recasadas = await db.recasarConcessionarias();
    } catch (e) {
      log(`  ! não consegui reassociar distribuidoras (${e.message}). Falta rodar a migration 0007? As usinas foram gravadas mesmo assim.`);
    }
    log('ANEEL: agregando empresas por CNPJ');
    empresas = await db.agregarEmpresas();
    await db.registrarLote({
      tipo: 'aneel', agente_id: perfil.id, arquivo: 'aneel-gd.zip + aneel-siga.csv',
      nome: `Base ANEEL — sincronização ${new Date().toISOString().slice(0, 10)}${potenciaMin ? ` (≥ ${potenciaMin} kW)` : ''}${ufs ? ` (${[...ufs].join(',')})` : ''}`,
      total: gd.linhas + siga.linhas, criados: corte.usinas.length, duplicados: gd.repetidas + siga.repetidas, erros: gd.semId + siga.semId,
    });
  }
  return { gd, siga, donos, empresas, recasadas, recorte, estimativaMB };
}
