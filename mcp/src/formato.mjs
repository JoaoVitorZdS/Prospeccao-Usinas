// formato.mjs — o CSV que `cnpj_exportar` gera. É o contrato com o app: os cabeçalhos abaixo são
// exatamente os que js/cnpj-importacao.js (CAMPOS_CNPJ) reconhece sem mapeamento manual
// (a compatibilidade é testada em test/formato.test.mjs, importando o código do app).

import { formatarCnae } from './cnaes.mjs';

export const CABECALHO_EXPORTACAO = [
  'CNPJ', 'Razão Social', 'Nome Fantasia', 'Situação Cadastral', 'Data Abertura', 'CNAE Principal',
  'CNAE Principal Descrição', 'CNAEs Secundários', 'Porte', 'Capital Social', 'Natureza Jurídica',
  'Matriz/Filial', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'CEP', 'Município', 'UF',
  'Telefone 1', 'Telefone 2', 'E-mail', 'Sócios',
];

const SITUACAO = { '01': 'Nula', '02': 'Ativa', '03': 'Suspensa', '04': 'Inapta', '08': 'Baixada' };

export const mascaraCnpj = (c) => (/^\d{14}$/.test(c ?? '')
  ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : (c ?? ''));
const mascaraCep = (c) => (/^\d{8}$/.test(c ?? '') ? `${c.slice(0, 5)}-${c.slice(5)}` : (c ?? ''));
export const mascaraTelefone = (t) => {
  if (!t) return '';
  if (t.length === 11) return `(${t.slice(0, 2)}) ${t.slice(2, 7)}-${t.slice(7)}`;
  if (t.length === 10) return `(${t.slice(0, 2)}) ${t.slice(2, 6)}-${t.slice(6)}`;
  return t;
};

/** Capital como a Receita escreve: vírgula decimal, sem milhar ("1250000,50"). */
const capitalTexto = (v) => (v == null ? '' : Number(v).toFixed(2).replace('.', ','));

/**
 * Linha da exportação a partir de uma linha da consulta. Sócios entram só se pedidos (lista de nomes
 * e qualificações; o CPF nunca é guardado nem exportado).
 */
export function linhaExportacao(r, { socios = [] } = {}) {
  return [
    mascaraCnpj(r.cnpj), r.razao_social ?? '', r.nome_fantasia ?? '', SITUACAO[r.situacao] ?? r.situacao ?? '',
    r.abertura ?? '', formatarCnae(r.cnae_principal), r.cnae_descricao ?? '',
    (r.cnaes_secundarios ? r.cnaes_secundarios.split(',').map(formatarCnae).join('; ') : ''),
    r.porte ?? '', capitalTexto(r.capital_social), r.natureza ?? '', r.matriz ? 'Matriz' : 'Filial',
    r.logradouro ?? '', r.numero ?? '', r.complemento ?? '', r.bairro ?? '', mascaraCep(r.cep), r.municipio ?? '', r.uf ?? '',
    mascaraTelefone(r.telefone1), mascaraTelefone(r.telefone2), r.email ?? '',
    socios.map((s) => `${s.nome}${s.qualificacao ? ` (${s.qualificacao})` : ''}`).join('; '),
  ];
}

/** Uma linha de CSV (dialeto Excel-pt: separador ";", aspas quando preciso, CRLF). */
export function linhaCsv(campos) {
  return `${campos.map((c) => {
    const s = String(c ?? '');
    return /[";\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }).join(';')}\r\n`;
}

export const BOM = '﻿';
