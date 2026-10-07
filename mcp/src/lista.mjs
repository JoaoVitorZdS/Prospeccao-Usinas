// lista.mjs — lê uma lista de CNPJs de um arquivo .txt/.csv (um por linha, ou a 1ª coluna do CSV).
// Usada no ETL (--cnpjs-arquivo) e na ferramenta MCP (cnpjs_arquivo): por exemplo, os CNPJs dos donos
// de usina exportados da base da ANEEL no app, para cruzar com o cadastro da Receita.

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const LIMITE_BYTES = 50 * 1048576;

/** Devolve um Set com CNPJs de 14 dígitos (ou "básicos" de 8). Lança erro claro se o arquivo não serve. */
export function lerListaDeCnpjs(caminho) {
  const ext = extname(caminho).toLowerCase();
  if (!['.txt', '.csv', '.tsv', ''].includes(ext)) throw new Error(`Só leio listas .txt, .csv ou .tsv (recebi "${ext}").`);
  const st = statSync(caminho);
  if (!st.isFile()) throw new Error(`${caminho} não é um arquivo.`);
  if (st.size > LIMITE_BYTES) throw new Error(`${caminho} tem mais de 50 MB — grande demais para uma lista de CNPJs.`);
  const set = new Set();
  for (const linha of readFileSync(caminho, 'latin1').split(/\r?\n/)) {
    const d = String(linha.split(/[;,\t]/)[0] ?? '').replace(/\D/g, '');
    if (d.length === 14 || d.length === 8) set.add(d);
    else if (d.length === 13) set.add(d.padStart(14, '0')); // o Excel comeu o zero à esquerda
  }
  if (!set.size) throw new Error(`Nenhum CNPJ (14 dígitos) encontrado em ${caminho}. Coloque um por linha ou na primeira coluna.`);
  return set;
}
