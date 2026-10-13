#!/usr/bin/env node
// sincronizar.mjs — `pnpm sincronizar`: traz as bases públicas para o WattScout, sem abrir o navegador.
//
//   distribuidoras  cadastro de distribuidoras e backlog inicial (só o que falta)
//   aneel           usinas da ANEEL (GD + SIGA) → usina_aneel → empresa
//   receita         cadastro de CNPJ da Receita Federal → empresa (donos de usina + CNAEs de energia)
//
// Entra no banco como uma conta de GESTOR (e-mail e senha) — o RLS vale igual ao do app. Nada de service_role.
// Veja `pnpm sincronizar --ajuda`.

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lerArgumentos } from '../mcp/etl/args.mjs';
import { carregarCredenciais, ehSim, lerSenha, perguntar } from './sync/ambiente.mjs';

const RAIZ = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const ETAPAS = ['distribuidoras', 'aneel', 'receita'];

export const AJUDA = `
WattScout — sincronizar as bases públicas

  pnpm sincronizar                         tudo: distribuidoras, ANEEL e Receita
  pnpm sincronizar --dry-run               faz tudo MENOS gravar no banco (mostra o que seria feito)
  pnpm sincronizar --so aneel              só as etapas citadas (${ETAPAS.join(', ')})

Recorte (o plano grátis do Supabase tem 500 MB; a base inteira da ANEEL ocupa ~255 MB):
  --potencia-min 75                        só empresas que SOMAM 75 kW ou mais (a mesma régua da tela Prospecção)
  --uf SP,MG                               só usinas destas UFs; na Receita, limita também os CNAEs de energia

Opções da Receita:
  --cnae geracao,comercializacao           CNAEs além dos donos de usina (padrão: geracao,comercializacao)
  --so-donos                               só os donos de usina da ANEEL, nenhum outro CNAE
  --competencia 2026-09                    mês da base da Receita (padrão: o mais recente)
  --csv arquivo.csv                        importa este CSV (exportação do MCP) e pula download e carga
  --apagar-zips                            apaga os ~6 GB de zips depois de carregar
  --baixar-receita                         com --dry-run, baixa os ~6 GB da Receita também (por padrão a simulação só
                                           mostra quanto falta baixar e segue sem baixar)

Geral:
  --sem-download                           usa os arquivos já baixados (ANEEL e Receita)
  --sim                                    não pergunta antes de gravar (para execução agendada)
  --pasta caminho                          onde ficam os arquivos baixados (padrão: mcp/dados/sincronizacao)

Credenciais — conta de GESTOR do WattScout:
  WATTSCOUT_EMAIL e WATTSCOUT_SENHA no ambiente ou em .env.local (fora do git); se faltar, pergunta no terminal.
`;

/** Lê e valida a linha de comando. Pura — é o que os testes exercitam. */
export function lerOpcoes(argv) {
  const { opcoes: o } = lerArgumentos(argv.filter((a) => a !== '--'), {
    so: 'valor', cnae: 'valor', uf: 'valor', 'potencia-min': 'valor', competencia: 'valor', csv: 'valor', pasta: 'valor',
    'dry-run': 'flag', sim: 'flag', 'sem-download': 'flag', 'so-donos': 'flag', 'apagar-zips': 'flag', 'baixar-receita': 'flag', ajuda: 'flag',
  });
  const etapas = o.so ? o.so.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) : [...ETAPAS];
  for (const e of etapas) if (!ETAPAS.includes(e)) throw new Error(`Etapa desconhecida: "${e}". Use: ${ETAPAS.join(', ')}.`);
  if (o.competencia && !/^\d{4}-\d{2}$/.test(o.competencia)) throw new Error('--competencia deve ser AAAA-MM, ex.: 2026-09.');
  if (o.csv && !etapas.includes('receita')) throw new Error('--csv só faz sentido com a etapa receita.');
  if (o['so-donos'] && o.cnae) throw new Error('--so-donos não combina com --cnae: ele pede só os donos de usina.');
  const potenciaMin = o['potencia-min'] == null ? null : Number(String(o['potencia-min']).replace(',', '.'));
  if (potenciaMin != null && !(potenciaMin > 0)) throw new Error('--potencia-min deve ser um número de kW maior que zero, ex.: --potencia-min 75.');
  if ((potenciaMin != null || o.uf) && !etapas.includes('aneel') && !etapas.includes('receita')) throw new Error('--uf e --potencia-min valem para as etapas aneel e receita.');
  return {
    ajuda: !!o.ajuda, etapas: ETAPAS.filter((e) => etapas.includes(e)), dryRun: !!o['dry-run'], sim: !!o.sim,
    semDownload: !!o['sem-download'], pasta: o.pasta ? resolve(o.pasta) : null,
    aneel: { uf: o.uf || null, potenciaMin },
    receita: {
      cnae: o.cnae || null, uf: o.uf || null, soDonos: !!o['so-donos'], competencia: o.competencia || null,
      csv: o.csv || null, apagarZips: !!o['apagar-zips'], semDownload: !!o['sem-download'], baixarReceita: !!o['baixar-receita'],
    },
  };
}

const hora = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.error(`[${hora()}]`, ...a);
const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');

async function credenciais() {
  const arquivos = carregarCredenciais(RAIZ);
  let email = process.env.WATTSCOUT_EMAIL;
  let senha = process.env.WATTSCOUT_SENHA;
  if (email && senha) {
    if (arquivos.length) log(`Credenciais lidas de ${arquivos.join(' e ')}.`);
    return { email, senha };
  }
  const faltam = [!email && 'WATTSCOUT_EMAIL', !senha && 'WATTSCOUT_SENHA'].filter(Boolean).join(' e ');
  if (arquivos.length) log(`${arquivos.join(' e ')} encontrado, mas falta ${faltam} — vou perguntar.`);
  if (!process.stdin.isTTY) {
    throw new Error(`Falta ${faltam} (ambiente, .env.local ou .env) e este terminal não permite perguntar. Use o PowerShell, o CMD ou o terminal do VS Code, ou preencha o .env.local.`);
  }
  email ||= await perguntar('E-mail da conta de gestor: ');
  senha ||= await lerSenha('Senha (a digitação aparece como *; pode colar com Ctrl+V): ');
  if (!email || !senha) throw new Error('E-mail e senha são obrigatórios.');
  return { email, senha };
}

function relatorio(resultados, opcoes) {
  const linhas = ['', `═══ Resumo${opcoes.dryRun ? ' (SIMULAÇÃO — nada foi gravado)' : ''} ═══`];
  const { distribuidoras: d, aneel: a, receita: r } = resultados;
  if (d) linhas.push(`Distribuidoras: ${n(d.concessionarias)} cadastradas · backlog: ${n(d.backlog)} linhas${d.simulado ? ' (simulado)' : ''}`);
  if (a) {
    linhas.push(`ANEEL: ${n(a.gd.usinas.length)} usinas PJ na GD (${n(a.gd.pf)} PF fora) + ${n(a.siga.usinas.length)} no SIGA`);
    if (a.recorte.uf || a.recorte.potenciaMin) {
      linhas.push(`       recorte${a.recorte.uf ? ` UF ${a.recorte.uf.join(',')}` : ''}${a.recorte.potenciaMin ? ` · ≥ ${n(a.recorte.potenciaMin)} kW somados` : ''}: `
        + `${n(a.recorte.empresasDepois)} de ${n(a.recorte.empresasAntes)} empresas, ${n(a.recorte.usinasDepois)} de ${n(a.recorte.usinasAntes)} usinas`);
    }
    linhas.push(`       ${n(a.donos.size)} CNPJs de dono`);
    if (!opcoes.dryRun) linhas.push(`       ${n(a.empresas)} empresas agregadas${a.recasadas ? ` · ${n(a.recasadas.casados)} distribuidoras ligadas (${n(a.recasadas.usinas)} usinas)` : ''}`);
    const sem = new Map([...a.gd.semDistribuidora, ...a.siga.semDistribuidora]);
    if (sem.size) linhas.push(`       ${n(sem.size)} nome(s) de distribuidora sem cadastro — confira em Mercado › Reassociar distribuidoras`);
    if (a.recasadas?.sugestoes?.length) linhas.push(`       ${n(a.recasadas.sugestoes.length)} casamento(s) APROXIMADO(S) aguardando a sua conferência em Mercado › Reassociar (não aplicados)`);
  }
  if (r?.pulada) {
    linhas.push(`Receita${r.competencia ? ` ${r.competencia}` : ''}: não simulada — faltam ${(r.faltamBytes / 1073741824).toFixed(2).replace('.', ',')} GB para baixar (${n(r.donos)} donos de usina conhecidos).`);
    linhas.push('         Rode sem --dry-run para baixar e gravar, ou --dry-run --baixar-receita para simular com o download.');
  } else if (r) {
    const x = r.resumo;
    linhas.push(`Receita${r.competencia ? ` ${r.competencia}` : ''}: ${n(x.linhas)} empresas lidas · ${n(x.novas)} novas · ${n(x.atualizadas)} atualizadas`
      + ` · fora: ${n(x.pf)} PF/MEI, ${n(x.inativas)} inativas, ${n(x.suprimidas)} opt-out, ${n(x.semId)} sem CNPJ`);
  }
  const mbAneel = a?.estimativaMB ?? 0;
  const mbReceita = r?.resumo?.estimativaMB ?? 0;
  if (a || r?.resumo) {
    const total = mbAneel + mbReceita;
    linhas.push('', `Espaço estimado no banco${opcoes.dryRun ? ' se gravar' : ' (gravado)'}: ≈ ${n(Math.round(total))} MB`
      + ` (ANEEL ≈ ${n(Math.round(mbAneel))} MB${r?.resumo ? ` + Receita ≈ ${n(Math.round(mbReceita))} MB` : ''})`);
    linhas.push('  O plano grátis do Supabase tem 500 MB POR PROJETO, somando o que você já tem (leads, conversas…); ao passar disso o projeto vira SOMENTE LEITURA.');
    if (total > 350) linhas.push('  ⚠ Isso passa de 350 MB. Reduza com --potencia-min e/ou --uf antes de gravar (veja --ajuda).');
  }
  for (const [etapa, erro] of Object.entries(resultados.erros)) linhas.push(`✖ ${etapa}: ${erro}`);
  return linhas.join('\n');
}

export async function principal(argv = process.argv.slice(2)) {
  const opcoes = lerOpcoes(argv);
  if (opcoes.ajuda) { console.error(AJUDA); return 0; }

  const pasta = opcoes.pasta || resolve(RAIZ, 'mcp', 'dados', 'sincronizacao');
  mkdirSync(pasta, { recursive: true });

  // Os módulos que falam com o banco só entram aqui: `--ajuda` e a validação de argumentos não dependem deles.
  const { entrar } = await import('./sync/conexao.mjs');
  const db = await import('../js/db.js');
  const { SUPABASE_URL } = await import('../js/supabase-config.js');

  const { email, senha } = await credenciais();
  log(`Entrando em ${SUPABASE_URL} como ${email}…`);
  const perfil = await entrar({ email, senha });
  log(`Conectado: ${perfil.nome} (${perfil.papel}).`);

  if (!opcoes.dryRun && !opcoes.sim) {
    if (!process.stdin.isTTY) throw new Error('Sem terminal para confirmar a gravação. Use --sim (execução agendada) ou --dry-run.');
    const resp = await perguntar(`\nGravar no banco ${SUPABASE_URL} as etapas: ${opcoes.etapas.join(', ')}? [s/N] `);
    if (!ehSim(resp)) { log('Cancelado — nada foi gravado.'); return 0; }
  }

  const resultados = { erros: {} };
  const inicio = Date.now();
  const rodar = async (etapa, fn) => {
    const t = Date.now();
    log(`\n━━ ${etapa} ━━`);
    try {
      resultados[etapa] = await fn();
      log(`${etapa}: concluída em ${Math.round((Date.now() - t) / 1000)} s`);
    } catch (e) {
      resultados.erros[etapa] = e.message;
      log(`✖ ${etapa} falhou: ${e.message}`);
    }
  };

  if (opcoes.etapas.includes('distribuidoras')) {
    await rodar('distribuidoras', async () => {
      if (opcoes.dryRun) return { simulado: true, concessionarias: (await db.todos('concessionaria')).length, backlog: (await db.todos('backlog')).length };
      return { concessionarias: await db.semearConcessionarias(), backlog: await db.semearBacklog() };
    });
  }

  if (opcoes.etapas.includes('aneel')) {
    const { sincronizarAneel } = await import('./sync/aneel.mjs');
    await rodar('aneel', () => sincronizarAneel({ pasta, perfil, dryRun: opcoes.dryRun, semDownload: opcoes.semDownload, opcoes: opcoes.aneel, log }));
  }

  if (opcoes.etapas.includes('receita')) {
    const { sincronizarReceita } = await import('./sync/receita.mjs');
    await rodar('receita', () => sincronizarReceita({
      pasta, perfil, dryRun: opcoes.dryRun, donos: resultados.aneel?.donos, opcoes: opcoes.receita, log,
    }));
  }

  console.error(relatorio(resultados, opcoes));
  log(`Total: ${Math.round((Date.now() - inicio) / 1000)} s`);
  return Object.keys(resultados.erros).length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await principal();
  } catch (e) {
    console.error(`\nErro: ${e.message}`);
    process.exitCode = 1;
  }
}
