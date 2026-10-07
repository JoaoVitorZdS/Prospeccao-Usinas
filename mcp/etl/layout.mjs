// layout.mjs — o layout dos arquivos de dados abertos do CNPJ (Receita Federal).
//
// Conferido contra os arquivos REAIS da competência 2026-09 (primeiros MB de Estabelecimentos1,
// Empresas1 e Socios1 e as tabelas Cnaes/Municipios/Naturezas/Qualificacoes/Motivos):
//   • texto em ISO-8859-1 (latin1), separador ";", cada campo entre aspas, SEM cabeçalho;
//   • Estabelecimentos = 30 colunas, Empresas = 7, Sócios = 11;
//   • `municipio` do estabelecimento é o código da RECEITA (4 dígitos, tabela Municipios.zip),
//     não o código IBGE;
//   • datas AAAAMMDD ("0" ou "00000000" quando vazia), capital social com vírgula decimal.
// Se a Receita mudar o layout, `cabe()` falha (contagem de colunas) e o ETL aborta em vez de gravar lixo.

export const N_COLUNAS = { estabelecimento: 30, empresa: 7, socio: 11, tabela: 2 };

/** Índices das colunas de ESTABELECIMENTOS. */
export const E = {
  basico: 0, ordem: 1, dv: 2, matrizFilial: 3, fantasia: 4, situacao: 5, dataSituacao: 6, motivoSituacao: 7,
  cidadeExterior: 8, pais: 9, abertura: 10, cnaePrincipal: 11, cnaesSecundarios: 12,
  tipoLogradouro: 13, logradouro: 14, numero: 15, complemento: 16, bairro: 17, cep: 18, uf: 19, municipio: 20,
  ddd1: 21, tel1: 22, ddd2: 23, tel2: 24, dddFax: 25, fax: 26, email: 27, situacaoEspecial: 28, dataSituacaoEspecial: 29,
};

/** Índices das colunas de EMPRESAS. */
export const M = { basico: 0, razao: 1, natureza: 2, qualificacao: 3, capital: 4, porte: 5, ente: 6 };

/** Índices das colunas de SÓCIOS. */
export const S = {
  basico: 0, tipo: 1, nome: 2, documento: 3, qualificacao: 4, entrada: 5, pais: 6,
  representante: 7, nomeRepresentante: 8, qualificacaoRepresentante: 9, faixaEtaria: 10,
};

export const SITUACAO = { '01': 'Nula', '02': 'Ativa', '03': 'Suspensa', '04': 'Inapta', '08': 'Baixada' };
export const PORTE = { '00': 'Não informado', '01': 'Não informado', '02': 'Microempresa', '03': 'Empresa de pequeno porte', '05': 'Demais' };
export const TIPO_SOCIO = { 1: 'PJ', 2: 'PF', 3: 'Estrangeiro' };
export const FAIXA_ETARIA = {
  0: 'Não se aplica', 1: '0 a 12 anos', 2: '13 a 20 anos', 3: '21 a 30 anos', 4: '31 a 40 anos',
  5: '41 a 50 anos', 6: '51 a 60 anos', 7: '61 a 70 anos', 8: '71 a 80 anos', 9: 'Mais de 80 anos',
};

/** `"a";"b";""` → ['a', 'b', '']. Aspas internas vêm dobradas (`""`). */
export function dividirLinha(linha) {
  let s = linha.endsWith('\r') ? linha.slice(0, -1) : linha;
  if (s.startsWith('"')) s = s.slice(1);
  if (s.endsWith('"')) s = s.slice(0, -1);
  return s.split('";"').map((c) => (c.includes('""') ? c.replaceAll('""', '"') : c));
}

/** A linha tem o número de colunas esperado para o tipo de arquivo? */
export const cabe = (cols, tipo) => cols.length === N_COLUNAS[tipo];

/** AAAAMMDD → AAAA-MM-DD (null quando vazio, "0" ou inexistente, como 00000000). */
export function dataIso(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{8}$/.test(s) || s === '00000000') return null;
  const [a, m, d] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
  return Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31 ? `${a}-${m}-${d}` : null;
}

/** DDD + número → só dígitos ("47" + "33851125" → "4733851125"); null se faltar. */
export function telefone(ddd, numero) {
  const n = String(numero ?? '').replace(/\D/g, '');
  if (n.length < 7) return null;
  const d = String(ddd ?? '').replace(/\D/g, '');
  return `${d}${n}`;
}

/** "120000000000,00" → 120000000000. */
export function capital(v) {
  const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

const limpo = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

/** CNAEs secundários vêm separados por vírgula: "1411801,4639701". */
export const cnaesSecundarios = (v) => [...new Set(String(v ?? '').split(',').map((c) => c.trim()).filter((c) => /^\d{7}$/.test(c)))];

/** Linha de ESTABELECIMENTOS (já dividida) → objeto. */
export function converterEstabelecimento(c) {
  const logradouro = [limpo(c[E.tipoLogradouro]), limpo(c[E.logradouro])].filter(Boolean).join(' ');
  return {
    cnpj: `${c[E.basico]}${c[E.ordem]}${c[E.dv]}`,
    cnpjBasico: c[E.basico],
    matriz: c[E.matrizFilial] === '1',
    nomeFantasia: limpo(c[E.fantasia]),
    situacao: c[E.situacao],
    dataSituacao: dataIso(c[E.dataSituacao]),
    abertura: dataIso(c[E.abertura]),
    cnaePrincipal: limpo(c[E.cnaePrincipal]),
    cnaesSecundarios: cnaesSecundarios(c[E.cnaesSecundarios]),
    logradouro: limpo(logradouro),
    numero: limpo(c[E.numero]),
    complemento: limpo(c[E.complemento]),
    bairro: limpo(c[E.bairro]),
    cep: limpo(c[E.cep]),
    uf: limpo(c[E.uf]),
    municipioCodigo: limpo(c[E.municipio]),
    telefone1: telefone(c[E.ddd1], c[E.tel1]),
    telefone2: telefone(c[E.ddd2], c[E.tel2]),
    email: limpo(c[E.email])?.toLowerCase() ?? null,
  };
}

/** Linha de EMPRESAS → objeto. */
export function converterEmpresa(c) {
  return {
    cnpjBasico: c[M.basico],
    razaoSocial: limpo(c[M.razao]),
    naturezaCodigo: limpo(c[M.natureza]),
    porte: PORTE[c[M.porte]] ?? null,
    capitalSocial: capital(c[M.capital]),
  };
}

/** Linha de SÓCIOS → objeto. O documento (CPF/CNPJ mascarado) NÃO é guardado — não faz falta e é dado pessoal. */
export function converterSocio(c) {
  return {
    cnpjBasico: c[S.basico],
    tipo: TIPO_SOCIO[c[S.tipo]] ?? null,
    nome: limpo(c[S.nome]),
    qualificacaoCodigo: limpo(c[S.qualificacao]),
    entrada: dataIso(c[S.entrada]),
    faixaEtaria: FAIXA_ETARIA[Number(c[S.faixaEtaria])] ?? null,
  };
}

/** Natureza jurídica 2135 = Empresário (Individual): inclui o MEI; a razão social é nome de pessoa física. */
export const NATUREZA_EMPRESARIO_INDIVIDUAL = '2135';
