#!/usr/bin/env node
// server.mjs — servidor MCP (stdio) para filtrar e exportar a base de CNPJ dos dados abertos da Receita.
//
// Por que existe: o Casa dos Dados (e sites parecidos) mostram o cadastro de CNPJ que a própria Receita
// publica como dado aberto — mas atrás de Cloudflare, com limite de plano e termos que proíbem raspar.
// Aqui a mesma base é lida direto da fonte (etl/baixar.mjs + etl/carregar.mjs → SQLite local) e
// consultada pelo Claude sem sair da máquina, exportando o CSV que o WattScout importa (Importar →
// Base CNPJ). Nenhum dado sai do computador; o servidor só lê o SQLite e escreve CSVs em dados/exportacoes.
//
// ATENÇÃO (protocolo stdio): NUNCA escreva em stdout aqui (console.log) — é o canal do protocolo.
// Mensagens para humanos vão para stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { abrirBanco, metadados, CAMINHO_PADRAO_DB, PASTA_DADOS } from './banco.mjs';
import {
  contar, buscar, percorrer, detalhe, buscarCnae, buscarMunicipio, normalizarFiltros, SITUACOES,
} from './consulta.mjs';
import { descricaoDosPresets } from './cnaes.mjs';
import { lerListaDeCnpjs } from './lista.mjs';
import { CABECALHO_EXPORTACAO, linhaExportacao, linhaCsv, BOM, mascaraCnpj, mascaraTelefone } from './formato.mjs';

const INSTRUCOES = `Base de CNPJ da Receita Federal (dados abertos), filtrada e local.
Fluxo típico: cnpj_status (ver o que foi carregado) → cnpj_presets / cnpj_cnae_buscar (achar CNAEs) →
cnpj_contar (quantas empresas atendem) → cnpj_buscar (amostra) → cnpj_exportar (CSV para o WattScout:
Importar → Base CNPJ). Só empresas ATIVAS por padrão; empresário individual/MEI (pessoa física) fica fora
por padrão. Não existe CNAE específico de energia solar: usinas solares se registram em "Geração de energia
elétrica" (3511-5/01) — os donos de usina de outros ramos vêm da base da ANEEL no app (use cnpjs_arquivo
para cruzar uma lista de CNPJs com o cadastro).`;

/* ── esquema dos filtros, compartilhado por contar/buscar/exportar ── */
const filtros = {
  cnae: z.array(z.string()).optional().describe('CNAEs: códigos de 7 dígitos ("3511501" ou "3511-5/01"), prefixos ("3511") ou presets (geracao, comercializacao, instalacao, material, rede). Veja cnpj_presets.'),
  cnae_modo: z.enum(['qualquer', 'principal']).optional().describe('"qualquer" (padrão) casa também CNAEs secundários; "principal" só a atividade principal.'),
  uf: z.array(z.string().length(2)).optional().describe('Siglas das UFs, ex.: ["SP","MG"].'),
  municipio: z.string().optional().describe('Parte do nome do município (sem acento): "campinas".'),
  porte: z.array(z.string()).optional().describe('micro, epp, demais ou "nao informado".'),
  natureza: z.array(z.string()).optional().describe('Códigos de natureza jurídica, ex.: ["2062"] (Ltda).'),
  capital_min: z.number().optional().describe('Capital social mínimo em reais.'),
  capital_max: z.number().optional().describe('Capital social máximo em reais.'),
  abertura_de: z.string().optional().describe('Abertura a partir de AAAA-MM-DD.'),
  abertura_ate: z.string().optional().describe('Abertura até AAAA-MM-DD.'),
  matriz: z.boolean().optional().describe('true = só matrizes; false = só filiais.'),
  com_telefone: z.boolean().optional().describe('Só quem tem telefone cadastrado.'),
  com_email: z.boolean().optional().describe('Só quem tem e-mail cadastrado.'),
  texto: z.string().optional().describe('Trecho da razão social ou do nome fantasia.'),
  situacao: z.array(z.string()).optional().describe(`Situação cadastral: ${Object.values(SITUACOES).join(', ')} (padrão: ativa).`),
  incluir_empresario_individual: z.boolean().optional().describe('Padrão false: empresário individual/MEI é pessoa física e fica de fora.'),
  cnpjs_arquivo: z.string().optional().describe('Caminho de um .txt/.csv com CNPJs (um por linha) para restringir o resultado a essa lista.'),
};

const texto = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const falha = (e) => ({ isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }] });

function resumoEmpresa(r) {
  return {
    cnpj: mascaraCnpj(r.cnpj), razao_social: r.razao_social, nome_fantasia: r.nome_fantasia,
    situacao: SITUACOES[r.situacao] ?? r.situacao, matriz: !!r.matriz, abertura: r.abertura,
    cnae_principal: r.cnae_principal, cnae_descricao: r.cnae_descricao, porte: r.porte, capital_social: r.capital_social,
    natureza: r.natureza, municipio: r.municipio, uf: r.uf,
    telefone1: mascaraTelefone(r.telefone1), telefone2: mascaraTelefone(r.telefone2), email: r.email,
  };
}

/** Nome de arquivo seguro: sem caminho, só [a-z0-9_.-], termina em .csv. */
export function nomeSeguro(pedido) {
  const agora = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  // separa por / e \ (independe do SO) e fica só com o último trecho: o caminho pedido é descartado
  const ultimo = String(pedido || `cnpj-${agora}`).split(/[\\/]/).pop();
  const base = ultimo.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[.-]+/, '');
  const limpo = base.replace(/\.csv$/, '') || `cnpj-${agora}`;
  return `${limpo}.csv`;
}

export function criarServidor({ caminhoDb = CAMINHO_PADRAO_DB, pastaExportacao = process.env.CNPJ_EXPORT_DIR || resolve(PASTA_DADOS, 'exportacoes') } = {}) {
  const server = new McpServer({ name: 'wattscout-cnpj', version: '1.0.0' }, { instructions: INSTRUCOES });
  let db = null;
  const banco = () => { db ??= abrirBanco(caminhoDb); return db; };

  /** Aplica `cnpjs_arquivo` (tabela temporária da conexão) e devolve os filtros no formato do consulta.mjs. */
  function prepararFiltros(args = {}) {
    const { cnpjs_arquivo: arquivo, ...resto } = args;
    const f = { ...resto };
    if (arquivo) {
      const lista = lerListaDeCnpjs(resolve(arquivo));
      const d = banco();
      d.exec('drop table if exists temp.lista_cnpj; create temp table lista_cnpj (cnpj text primary key)');
      const ins = d.prepare('insert or ignore into temp.lista_cnpj values (?)');
      d.exec('begin');
      for (const c of lista) ins.run(c);
      d.exec('commit');
      f.listaTemporaria = true;
    }
    normalizarFiltros(f); // valida cedo, com mensagem clara
    return f;
  }

  const somenteLeitura = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('cnpj_status', {
    title: 'Status da base de CNPJ',
    description: 'Mostra o que está carregado: mês da base da Receita, filtros usados na carga e contagens. Rode primeiro.',
    inputSchema: {}, annotations: somenteLeitura,
  }, async () => {
    try {
      const m = metadados(banco());
      return texto({ ...m, filtros: m.filtros ? JSON.parse(m.filtros) : null, arquivo: caminhoDb, pasta_exportacao: pastaExportacao });
    } catch (e) { return falha(e); }
  });

  server.registerTool('cnpj_presets', {
    title: 'Presets de CNAE do setor de energia',
    description: 'Lista os grupos de CNAE prontos (geração, comercialização, instalação elétrica, material elétrico, redes) e seus códigos oficiais.',
    inputSchema: {}, annotations: somenteLeitura,
  }, async () => texto({
    presets: descricaoDosPresets(),
    observacao: 'Não existe CNAE específico de energia solar: usinas solares se registram em Geração de energia elétrica (3511-5/01). '
      + 'Donos de usina de outros ramos só aparecem pela base da ANEEL (use cnpjs_arquivo).',
  }));

  server.registerTool('cnpj_cnae_buscar', {
    title: 'Buscar CNAE por texto',
    description: 'Procura códigos CNAE pela descrição ou pelo início do código.',
    inputSchema: { texto: z.string().min(2).describe('Ex.: "energia elétrica", "instalação", "3511"'), limite: z.number().int().min(1).max(100).optional() },
    annotations: somenteLeitura,
  }, async ({ texto: t, limite }) => {
    try { return texto({ resultados: buscarCnae(banco(), t, limite ?? 20) }); } catch (e) { return falha(e); }
  });

  server.registerTool('cnpj_municipio_buscar', {
    title: 'Buscar município',
    description: 'Procura municípios pelo nome (sem acento). Com `uf`, só os que têm estabelecimento naquela UF na base carregada.',
    inputSchema: { texto: z.string().min(2), uf: z.string().length(2).optional(), limite: z.number().int().min(1).max(100).optional() },
    annotations: somenteLeitura,
  }, async ({ texto: t, uf, limite }) => {
    try { return texto({ resultados: buscarMunicipio(banco(), t, uf, limite ?? 20) }); } catch (e) { return falha(e); }
  });

  server.registerTool('cnpj_contar', {
    title: 'Contar empresas que atendem aos filtros',
    description: 'Quantos estabelecimentos atendem aos filtros — barato; use antes de buscar ou exportar.',
    inputSchema: filtros, annotations: somenteLeitura,
  }, async (args) => {
    try { const f = prepararFiltros(args); return texto({ total: contar(banco(), f) }); } catch (e) { return falha(e); }
  });

  server.registerTool('cnpj_buscar', {
    title: 'Buscar empresas',
    description: 'Amostra paginada das empresas que atendem aos filtros (até 100 por página), ordenadas por capital social por padrão.',
    inputSchema: {
      ...filtros,
      limite: z.number().int().min(1).max(100).optional().describe('Resultados por página (padrão 20).'),
      pagina: z.number().int().min(1).optional().describe('Página, começando em 1.'),
      ordenar_por: z.enum(['capital', 'abertura', 'razao', 'cnpj', 'municipio']).optional(),
      ordem: z.enum(['asc', 'desc']).optional(),
    },
    annotations: somenteLeitura,
  }, async (args) => {
    try {
      const { limite = 20, pagina = 1, ...resto } = args;
      const f = prepararFiltros(resto);
      const total = contar(banco(), f);
      const linhas = buscar(banco(), f, { limite, deslocamento: (pagina - 1) * limite });
      return texto({ total, pagina, por_pagina: limite, resultados: linhas.map(resumoEmpresa) });
    } catch (e) { return falha(e); }
  });

  server.registerTool('cnpj_detalhe', {
    title: 'Detalhe de um CNPJ',
    description: 'Cadastro completo de um CNPJ: endereço, CNAEs secundários e (opcional) sócios — nome, qualificação e faixa etária; o CPF não é guardado.',
    inputSchema: { cnpj: z.string().describe('CNPJ completo, com ou sem máscara.'), incluir_socios: z.boolean().optional() },
    annotations: somenteLeitura,
  }, async ({ cnpj, incluir_socios }) => {
    try {
      const d = detalhe(banco(), cnpj, { incluirSocios: incluir_socios ?? true });
      if (!d) return falha(`CNPJ ${cnpj} não está na base carregada (ela é filtrada na carga — veja cnpj_status).`);
      return texto({ ...resumoEmpresa(d), cep: d.cep, logradouro: d.logradouro, numero: d.numero, complemento: d.complemento, bairro: d.bairro,
        cnaes_secundarios: d.cnaes_secundarios_detalhe, socios: d.socios });
    } catch (e) { return falha(e); }
  });

  server.registerTool('cnpj_exportar', {
    title: 'Exportar CSV para o WattScout',
    description: 'Grava um CSV com as empresas que atendem aos filtros, no formato que o WattScout importa (Importar → Base CNPJ). '
      + 'O arquivo vai para a pasta de exportações do servidor; informe só um nome.',
    inputSchema: {
      ...filtros,
      arquivo: z.string().optional().describe('Nome do arquivo (ex.: "geradoras-sp.csv"). Vazio = nome com data e hora.'),
      limite: z.number().int().min(1).max(200000).optional().describe('Máximo de linhas (padrão 5000).'),
      incluir_socios: z.boolean().optional().describe('Inclui a coluna Sócios (nome e qualificação; sem CPF). Padrão false.'),
      ordenar_por: z.enum(['capital', 'abertura', 'razao', 'cnpj', 'municipio']).optional(),
      ordem: z.enum(['asc', 'desc']).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    let fd = null;
    try {
      const { arquivo, limite = 5000, incluir_socios: comSocios = false, ...resto } = args;
      const f = prepararFiltros(resto);
      const total = contar(banco(), f);
      if (!total) return falha('Nenhuma empresa atende aos filtros — nada a exportar. Afrouxe os critérios ou confira cnpj_status.');
      mkdirSync(pastaExportacao, { recursive: true });
      const caminho = resolve(pastaExportacao, nomeSeguro(arquivo));
      const stmtSocios = comSocios ? banco().prepare(`select s.nome, q.descricao as qualificacao from socio s
        left join qualificacao q on q.codigo = s.qualificacao_codigo where s.cnpj_basico = ? order by s.entrada, s.nome limit 12`) : null;
      fd = openSync(caminho, 'w');
      writeSync(fd, BOM + linhaCsv(CABECALHO_EXPORTACAO));
      let n = 0;
      for (const r of percorrer(banco(), f, { limiteTotal: limite })) {
        writeSync(fd, linhaCsv(linhaExportacao(r, { socios: stmtSocios ? stmtSocios.all(r.cnpj_basico) : [] })));
        n++;
      }
      closeSync(fd);
      fd = null;
      return texto({
        arquivo: caminho, linhas_exportadas: n, total_que_atende_aos_filtros: total, truncado: n < total,
        colunas: CABECALHO_EXPORTACAO,
        proximo_passo: 'No WattScout: Importar → "Base CNPJ (Receita)" → arraste este arquivo. As colunas já são reconhecidas sem mapeamento manual.',
        aviso_lgpd: 'Empresário individual/MEI (pessoa física) fica de fora por padrão. Use os dados só para prospecção B2B com legítimo interesse e respeite a lista de opt-out do WattScout (a importação aplica a supressão).',
      });
    } catch (e) {
      if (fd != null) { try { closeSync(fd); } catch { /* ignora */ } }
      return falha(e);
    }
  });

  server.server.onclose = () => { try { db?.close(); } catch { /* ignora */ } };
  return server;
}

// ── execução como servidor stdio ──
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const servidor = criarServidor();
  await servidor.connect(new StdioServerTransport());
  console.error('wattscout-cnpj (MCP) pronto — base:', CAMINHO_PADRAO_DB);
}
