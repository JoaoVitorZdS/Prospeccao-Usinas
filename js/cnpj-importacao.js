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
 * Uma linha mapeada (campos de CAMPOS_CNPJ, tudo texto) → objeto pronto para `upsert` em `empresa`,
 * ou `{ erro }`. Só inclui o que veio preenchido: no upsert, coluna ausente não é sobrescrita, então
 * importar um CSV pobre nunca apaga dado já enriquecido nem os agregados da ANEEL.
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
