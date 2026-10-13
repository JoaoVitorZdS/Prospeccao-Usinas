// cnpj-importacao.js — a "Base CNPJ" (dados abertos da Receita Federal, a mesma origem do Casa dos
// Dados): campos do CSV, parsers de células com vários valores e a conversão para a tabela `empresa`.
//
// É o contrato entre o servidor MCP (`mcp/`, que filtra e exporta a base da Receita) e o app: o
// CSV que o MCP gera tem exatamente estes cabeçalhos, e qualquer exportação parecida (de outro
// site ou planilha) entra pelo mesmo mapeamento. Fica separado de js/parse.js porque os cabeçalhos
// de CNPJ colidem com os de lead — "Data Abertura" virava data de contato, "Sócios" virava nome do
// contato e "Situação" virava status do lead (ver test/cnpj-importacao.test.mjs).

import { normCnpj, normFone, normEmail, parseData, parseNum, digits } from './util.js';

/** Campos-alvo da importação de CNPJ. Aliases já normalizados (`slug`: sem acento, minúsculo, só a-z0-9). */
export const CAMPOS_CNPJ = [
  { campo: 'cnpj', label: 'CNPJ', aliases: ['cnpj', 'cnpjcompleto', 'numerocnpj'] },
  { campo: 'razao_social', label: 'Razão social', aliases: ['razaosocial', 'razao', 'nomeempresarial', 'nome'] },
  { campo: 'nome_fantasia', label: 'Nome fantasia', aliases: ['nomefantasia', 'fantasia'] },
  { campo: 'situacao_cadastral', label: 'Situação cadastral', aliases: ['situacaocadastral', 'situacao'] },
  { campo: 'data_abertura', label: 'Data de abertura', aliases: ['dataabertura', 'datadeabertura', 'datainicioatividade', 'abertura'] },
  { campo: 'cnae_principal', label: 'CNAE principal (código)', aliases: ['cnaeprincipal', 'cnaefiscalprincipal', 'cnae', 'atividadeprincipal'] },
  { campo: 'cnae_descricao', label: 'CNAE principal (descrição)', aliases: ['cnaeprincipaldescricao', 'descricaocnae', 'descricaoatividadeprincipal'] },
  { campo: 'cnaes_secundarios', label: 'CNAEs secundários', aliases: ['cnaessecundarios', 'cnaesecundario', 'cnaefiscalsecundaria', 'atividadessecundarias'] },
  { campo: 'porte', label: 'Porte', aliases: ['porte', 'porteempresa'] },
  { campo: 'capital_social', label: 'Capital social', aliases: ['capitalsocial', 'capital'] },
  { campo: 'natureza_juridica', label: 'Natureza jurídica', aliases: ['naturezajuridica', 'natureza'] },
  { campo: 'matriz', label: 'Matriz/Filial', aliases: ['matrizfilial', 'matriz', 'tipoestabelecimento', 'identificadormatrizfilial'] },
  { campo: 'logradouro', label: 'Logradouro', aliases: ['logradouro', 'endereco'] },
  { campo: 'numero', label: 'Número', aliases: ['numero', 'num'] },
  { campo: 'complemento', label: 'Complemento', aliases: ['complemento'] },
  { campo: 'bairro', label: 'Bairro', aliases: ['bairro'] },
  { campo: 'cep', label: 'CEP', aliases: ['cep'] },
  { campo: 'municipio', label: 'Município', aliases: ['municipio', 'cidade'] },
  { campo: 'uf', label: 'UF', aliases: ['uf', 'estado'] },
  { campo: 'telefone1', label: 'Telefone 1', aliases: ['telefone1', 'telefone', 'fone', 'tel'] },
  { campo: 'telefone2', label: 'Telefone 2', aliases: ['telefone2', 'fone2', 'telefonealternativo'] },
  { campo: 'email', label: 'E-mail', aliases: ['email', 'correioeletronico', 'mail'] },
  { campo: 'socios', label: 'Sócios', aliases: ['socios', 'quadrosocietario', 'qsa'] },
];

/** Divide uma célula com vários valores (`;`, `|`, `/`, vírgula, quebra de linha). */
function dividir(v, separadores = /[;|\n]+/) {
  return String(v ?? '').split(separadores).map((x) => x.trim()).filter(Boolean);
}

/** "(11) 3333-4444 / 11 98888-7777" → ['1133334444', '11988887777'] (sem duplicados). */
export function parseTelefones(v) {
  const partes = dividir(v, /[;|/\n]+|\s{2,}|,(?=\s*\(?\d)/);
  const saida = [];
  for (const p of partes) {
    const f = normFone(p) || (digits(p).length >= 8 ? digits(p) : '');
    if (f && !saida.includes(f)) saida.push(f);
  }
  return saida;
}

/** Vários e-mails na mesma célula; devolve só os válidos, em minúsculas. */
export function parseEmails(v) {
  const saida = [];
  for (const p of dividir(v, /[;|,\s\n]+/)) {
    const e = normEmail(p);
    if (e && !saida.includes(e)) saida.push(e);
  }
  return saida;
}

/** "3511501; 4321500, 4742-3/00" → ['3511501', '4321500', '4742300'] (códigos de 7 dígitos). */
export function parseCnaes(v) {
  const saida = [];
  for (const p of dividir(v, /[;|,\n]+/)) {
    const c = digits(p);
    if (c.length === 7 && !saida.includes(c)) saida.push(c);
  }
  return saida;
}

/** "Fulano (Administrador); Beltrano — Sócio" → [{ nome, qualificacao }] (no máximo 12, como no enriquecimento). */
export function parseSocios(v) {
  const saida = [];
  for (const p of dividir(v, /[;|\n]+/)) {
    const m = p.match(/^(.*?)\s*(?:[(—–-]\s*([^)]*)\)?)?$/);
    const nome = (m?.[1] || p).trim();
    if (nome) saida.push({ nome, qualificacao: (m?.[2] || '').trim() || undefined });
    if (saida.length >= 12) break;
  }
  return saida;
}

/** "Matriz"/"1" → true; "Filial"/"2" → false; vazio → undefined. */
export function parseMatriz(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  if (/^(1|matriz|m|sim|s|true)$/.test(s)) return true;
  if (/^(2|filial|f|nao|não|n|false)$/.test(s)) return false;
  return undefined;
}

/** "02", "ATIVA", "Ativa" → "Ativa" (o texto que o resto do app mostra). */
export function normSituacao(v) {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const t = { '01': 'Nula', '1': 'Nula', '02': 'Ativa', '2': 'Ativa', '03': 'Suspensa', '3': 'Suspensa', '04': 'Inapta', '4': 'Inapta', '08': 'Baixada', '8': 'Baixada' };
  return t[s] || (s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
}

/**
 * Capital social em reais: aceita "1.250.000,50", "120000000000,00" (formato da Receita), "1250000.5"
 * e "R$ 10.000". Só um ponto seguido de exatamente 3 dígitos, repetido, é milhar ("10.000" = 10 mil);
 * "1250000.5" continua decimal.
 */
export function parseCapital(v) {
  const s = String(v ?? '').replace(/R\$/gi, '').trim();
  if (!s) return null;
  return parseNum(/^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s);
}

/**
 * Empresário Individual (natureza jurídica 2135) e MEI: a "razão social" é o nome de uma pessoa física
 * (com parte do CPF). O LIA do projeto proíbe tratar/reidentificar PF, então a importação os ignora
 * por padrão. Reconhece tanto o código quanto o texto ("Empresário (Individual)").
 */
export const ehEmpresarioIndividual = (e) =>
  /^\s*2135\b|empres[aá]rio\s*\(\s*individual\s*\)/i.test(String(e?.natureza_juridica ?? ''));

/**
 * Uma linha mapeada (campos de CAMPOS_CNPJ, tudo texto) → objeto com só o que veio preenchido, ou `{ erro }`.
 *
 * ATENÇÃO ao gravar: num upsert EM LOTE o PostgREST usa a união das colunas de todas as linhas e grava NULL nas
 * linhas que não têm uma delas — por cima do dado existente. Por isso este objeto NÃO vai direto para o banco
 * quando a empresa já existe: `classificarLinhasCnpj` o mescla com a linha atual (veredito `atualiza`) e
 * `gruposParaGravar` grava novas e atualizadas em lotes separados.
 */
export function linhaParaEmpresa(b, { fonte = 'receita_federal', competencia } = {}) {
  const cnpj = normCnpj(b.cnpj);
  if (!cnpj) return { erro: b.cnpj ? 'CNPJ inválido' : 'sem CNPJ' };

  const tels = [...parseTelefones(b.telefone1), ...parseTelefones(b.telefone2)];
  const emails = parseEmails(b.email);
  const socios = b.socios ? parseSocios(b.socios) : [];
  const cnaesSec = parseCnaes(b.cnaes_secundarios);
  const cnaeP = parseCnaes(b.cnae_principal)[0];
  const capital = b.capital_social ? parseCapital(b.capital_social) : null;
  const abertura = b.data_abertura ? parseData(b.data_abertura) : null;
  const endereco = [b.logradouro, b.numero, b.complemento, b.bairro].map((x) => String(x ?? '').trim()).filter(Boolean).join(', ');
  const uf = String(b.uf ?? '').trim().toUpperCase().slice(0, 2);
  const municipio = String(b.municipio ?? '').trim();
  const cep = digits(b.cep).slice(0, 8);

  const e = { cnpj, fonte_cadastro: fonte };
  const poe = (k, v) => { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) e[k] = v; };
  poe('razao_social', String(b.razao_social ?? '').trim());
  poe('nome_fantasia', String(b.nome_fantasia ?? '').trim());
  poe('situacao_cadastral', normSituacao(b.situacao_cadastral));
  poe('data_abertura', abertura);
  poe('cnae_principal', cnaeP);
  poe('cnae_descricao', String(b.cnae_descricao ?? '').trim());
  poe('cnaes_secundarios', cnaesSec);
  poe('porte', String(b.porte ?? '').trim());
  poe('capital_social', capital);
  poe('natureza_juridica', String(b.natureza_juridica ?? '').trim());
  poe('matriz', parseMatriz(b.matriz));
  poe('logradouro', endereco);
  poe('cep', cep);
  poe('municipio_sede', municipio);
  poe('uf_sede', uf);
  poe('telefone1', tels[0]);
  poe('telefone2', tels[1]);
  poe('email', emails[0]);
  poe('socios', socios);
  poe('competencia_cadastro', competencia);
  return { empresa: e };
}

/** Cada linha mapeada (CAMPOS_CNPJ) vira { b, r: { empresa } | { erro } }. */
export function converterLinhasCnpj(brutos, { competencia } = {}) {
  return brutos.map((b) => ({ b, r: linhaParaEmpresa(b, { competencia }) }));
}

/**
 * Veredito por linha da Base CNPJ — a parte PURA da análise. A tela de Importar e o `pnpm sincronizar` buscam
 * os dados de apoio (opt-out, empresas já gravadas, leads existentes) e chamam aqui, então os dois decidem igual.
 *
 * Cada linha vira uma `empresa`. Veredito: NOVO (não existia), ATUALIZA (já existia: o que veio preenchido é
 * mesclado sobre a linha atual — o que veio vazio NÃO apaga o que já está lá, nem os agregados da ANEEL) ou fora
 * (sem CNPJ, repetido, opt-out, pessoa física, não ativa). Contato (telefone/e-mail) em opt-out é descartado,
 * como no enriquecimento.
 *
 * @param conv        saída de `converterLinhasCnpj`
 * @param supressao   { testar({cnpj,telefone,email}) → motivo|null }  (db.carregarSupressao)
 * @param existentes  Map cnpj → linha atual de `empresa` (db.empresasPorCnpj)
 * @param cacheLeads  só com `criarLeads`: { porCnpj: Map } dos leads existentes (db.cacheDedup)
 */
export function classificarLinhasCnpj(conv, {
  supressao, existentes, cacheLeads = null, incluirEI = false, soAtivas = true, criarLeads = false,
}) {
  const vistos = new Map();
  const itens = [];

  for (const { b, r } of conv) {
    const item = { _linha: b._linha, bruto: b, erros: [] };
    itens.push(item);
    if (r.erro) { item.veredito = 'sem_id'; item.erros.push(r.erro); continue; }
    const e = r.empresa;
    item.empresa = e;
    if (vistos.has(e.cnpj)) {
      item.veredito = 'duplicado_lote';
      item.detalhe = `igual à linha ${vistos.get(e.cnpj) + 1} deste mesmo arquivo`;
      continue;
    }
    vistos.set(e.cnpj, b._linha);

    const motivo = supressao.testar({ cnpj: e.cnpj, telefone: e.telefone1, email: e.email });
    if (motivo === 'cnpj') { item.veredito = 'suprimido'; item.detalhe = 'opt-out registrado por cnpj'; continue; }
    if (!incluirEI && ehEmpresarioIndividual(e)) {
      item.veredito = 'pf';
      item.detalhe = 'empresário individual (pessoa física)';
      continue;
    }
    if (soAtivas && e.situacao_cadastral && e.situacao_cadastral !== 'Ativa') {
      item.veredito = 'inativa';
      item.detalhe = `situação: ${e.situacao_cadastral}`;
      continue;
    }
    // contato em opt-out não entra na base (o CNPJ em si pode entrar)
    const tirados = [];
    if (e.telefone1 && supressao.testar({ telefone: e.telefone1 })) { delete e.telefone1; tirados.push('telefone'); }
    if (e.telefone2 && supressao.testar({ telefone: e.telefone2 })) { delete e.telefone2; tirados.push('telefone 2'); }
    if (e.email && supressao.testar({ email: e.email })) { delete e.email; tirados.push('e-mail'); }

    const atual = existentes.get(e.cnpj);
    if (atual) {
      item.veredito = 'atualiza';
      // linha COMPLETA (o que já está lá + o que veio preenchido): é o que impede o upsert em lote de gravar NULL
      item.empresa = { ...atual, ...e, updated_at: new Date().toISOString() };
    } else {
      item.veredito = 'novo';
    }
    const notas = [];
    if (tirados.length) notas.push(`${tirados.join(' e ')} em opt-out — descartado`);
    if (criarLeads) {
      if (cacheLeads.porCnpj.has(e.cnpj)) { item.jaTemLead = true; notas.push('já tem lead — só a empresa é gravada'); }
      else item.vaiViraLead = true;
    }
    if (notas.length) item.detalhe = notas.join(' · ');
  }
  return { tipo: 'cnpj', itens };
}

/**
 * As empresas a gravar, em dois grupos que NUNCA se misturam num mesmo lote de upsert (ver `linhaParaEmpresa`):
 * `novos` (só os campos preenchidos — coluna ausente vira NULL, que é o que a linha nova já tem) e `atualizados`
 * (linhas completas, mescladas). Itens fora do recorte (pf, inativa, suprimido…) não entram.
 */
export function gruposParaGravar(itens) {
  const novos = [];
  const atualizados = [];
  for (const i of itens) {
    if (i.veredito === 'novo') novos.push(i.empresa);
    else if (i.veredito === 'atualiza') atualizados.push(i.empresa);
  }
  return { novos, atualizados };
}
