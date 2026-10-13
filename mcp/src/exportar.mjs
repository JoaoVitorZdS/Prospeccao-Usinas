// exportar.mjs — grava o CSV que o WattScout importa (Importar → Base CNPJ). Usada pela ferramenta MCP
// `cnpj_exportar` e pelo comando `pnpm --dir mcp exportar` (que o `pnpm sincronizar` chama): os dois produzem
// exatamente o mesmo arquivo, com o mesmo contrato de colunas (formato.mjs).

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { percorrer } from './consulta.mjs';
import { CABECALHO_EXPORTACAO, linhaExportacao, linhaCsv, BOM } from './formato.mjs';

/**
 * @param db        banco aberto (node:sqlite)
 * @param filtros   já normalizados (`normalizarFiltros`)
 * @param caminho   arquivo de saída (a pasta é criada se faltar)
 * @returns número de linhas gravadas
 */
export function exportarCsv(db, filtros, caminho, { limite = Infinity, comSocios = false } = {}) {
  mkdirSync(dirname(caminho), { recursive: true });
  const stmtSocios = comSocios ? db.prepare(`select s.nome, q.descricao as qualificacao from socio s
    left join qualificacao q on q.codigo = s.qualificacao_codigo where s.cnpj_basico = ? order by s.entrada, s.nome limit 12`) : null;
  const fd = openSync(caminho, 'w');
  let n = 0;
  try {
    writeSync(fd, BOM + linhaCsv(CABECALHO_EXPORTACAO));
    for (const r of percorrer(db, filtros, { limiteTotal: limite })) {
      writeSync(fd, linhaCsv(linhaExportacao(r, { socios: stmtSocios ? stmtSocios.all(r.cnpj_basico) : [] })));
      n++;
    }
  } finally {
    closeSync(fd);
  }
  return n;
}
