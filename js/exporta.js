// exporta.js — a entrega ao superior (seção 7.F).
//
// Regra que não pode quebrar: as colunas 1–10 saem na ordem exata da planilha atual.
// Quem recebe não muda de hábito; as colunas novas vêm depois, como bônus.
//
// Convenção de CSV do Excel-pt: BOM UTF-8, separador ';', CRLF. CNPJ/telefone/CEP
// saem COM máscara — sem isso o Excel converte em notação científica e come o zero
// à esquerda, e o superior recebe um arquivo quebrado.

import {
  paraCSV, baixar, nomeArquivo, maskCnpj, maskFone, maskCep,
  fmtData, fmtNum, esc, hojeISO, fmtDataHora,
} from './util.js';
import {
  COLUNAS_PLANILHA, COLUNAS_EXTRAS, STATUS_MAP, statusLabel, origemLabel, CANAIS,
} from './seed.js';

const desenvolveu = (status) => (STATUS_MAP[status]?.desenvolveu ? 'Sim' : 'Não');

/** Contexto de lookup para não repetir consulta por linha. */
export function contexto({ perfis = [], concessionarias = [], empresas = [] }) {
  return {
    agente: new Map(perfis.map((p) => [p.id, p.nome])),
    conc: new Map(concessionarias.map((c) => [c.codigo, c.nome])),
    empresa: new Map(empresas.map((e) => [e.cnpj, e])),
  };
}

function linhaLead(l, ctx) {
  const emp = l.cnpj ? ctx.empresa.get(l.cnpj) : null;
  const nome = l.contato_nome || l.razao_social || emp?.razao_social || '';
  const conc = ctx.conc.get(l.concessionaria_codigo) || l.concessionaria_raw || '';
  const potencia = l.potencia_kwp ?? emp?.potencia_total_kw ?? null;
  const usinas = emp?.qtd_usinas ?? '';

  return [
    // ── 1–10: a planilha de sempre ────────────────────────────────
    origemLabel(l.origem),
    nome,
    maskFone(l.telefone || emp?.telefone1 || ''),
    l.email || emp?.email || '',
    desenvolveu(l.status),
    fmtData(l.ultimo_contato_em),
    ctx.agente.get(l.owner_id) || '',
    conc,
    maskCep(l.cep || emp?.cep || ''),
    l.descricao || '',
    // ── 11+: o que a planilha não tinha ───────────────────────────
    l.razao_social || emp?.razao_social || '',
    maskCnpj(l.cnpj || ''),
    l.tipo === 'intermediador' ? 'Intermediador' : 'Usina geradora',
    statusLabel(l.status) + (l.status_motivo ? ` — ${l.status_motivo}` : ''),
    l.cidade || emp?.municipio_principal || '',
    l.uf || emp?.uf_principal || '',
    potencia == null ? '' : fmtNum(potencia, 2),
    usinas === '' ? '' : String(usinas),
    String(l.tentativas || 0),
    fmtData(l.primeiro_contato_em),
    fmtData(l.proxima_acao_em),
    l.id,
  ];
}

export function csvLeads(leads, ctx) {
  return paraCSV([...COLUNAS_PLANILHA, ...COLUNAS_EXTRAS], leads.map((l) => linhaLead(l, ctx)));
}

export function baixarLeads(leads, ctx, agente, base = 'leads') {
  baixar(csvLeads(leads, ctx), nomeArquivo(base, agente, 'csv'));
}

/** CSV de interações — auditoria e coaching. */
export function csvInteracoes(interacoes, leads, ctx) {
  const porId = new Map(leads.map((l) => [l.id, l]));
  const canal = new Map(CANAIS.map((c) => [c.v, c.label]));
  const linhas = interacoes
    .slice()
    .sort((a, b) => (a.ocorrido_em < b.ocorrido_em ? 1 : -1))
    .map((i) => {
      const l = porId.get(i.lead_id) || {};
      return [
        fmtDataHora(i.ocorrido_em),
        ctx.agente.get(i.agente_id) || '',
        l.razao_social || l.contato_nome || '',
        maskCnpj(l.cnpj || ''),
        canal.get(i.canal) || i.canal,
        i.sentido === 'entrada' ? 'Entrada' : 'Saída',
        i.resultado || '',
        statusLabel(i.status_apos),
        i.descricao || '',
        i.lead_id,
      ];
    });
  return paraCSV(
    ['Data/hora', 'Agente', 'Lead', 'CNPJ', 'Canal', 'Sentido', 'Resultado', 'Status após', 'Descrição', 'ID do lead'],
    linhas,
  );
}

/* ═══════════════ Relatório de impressão ═══════════════ */

/**
 * "Leads prontos para contrato": um bloco por lead, `page-break-inside: avoid`.
 * Ctrl+P salva PDF — sem dependência de gerador de PDF.
 */
export function htmlRelatorio(leads, ctx, { titulo = 'Leads prontos para contrato', autor = '' } = {}) {
  const blocos = leads.map((l) => {
    const emp = l.cnpj ? ctx.empresa.get(l.cnpj) : null;
    const conc = ctx.conc.get(l.concessionaria_codigo) || l.concessionaria_raw || '—';
    const pot = l.potencia_kwp ?? emp?.potencia_total_kw;
    const campo = (rot, val) => `<div class="c"><dt>${esc(rot)}</dt><dd>${esc(val || '—')}</dd></div>`;
    return `<article>
  <h2>${esc(l.razao_social || emp?.razao_social || l.contato_nome || 'Sem nome')}</h2>
  <p class="sub">${esc(maskCnpj(l.cnpj || '') || 'sem CNPJ')} · ${esc(statusLabel(l.status))} · ${esc(origemLabel(l.origem))}</p>
  <dl>
    ${campo('Contato', l.contato_nome)}
    ${campo('Cargo', l.contato_cargo)}
    ${campo('Telefone', maskFone(l.telefone || emp?.telefone1 || ''))}
    ${campo('E-mail', l.email || emp?.email)}
    ${campo('Concessionária', conc)}
    ${campo('Potência', pot == null ? '' : `${fmtNum(pot, 2)} kW`)}
    ${campo('Nº de usinas', emp?.qtd_usinas)}
    ${campo('Cidade/UF', [l.cidade || emp?.municipio_principal, l.uf || emp?.uf_principal].filter(Boolean).join('/'))}
    ${campo('CEP', maskCep(l.cep || emp?.cep || ''))}
    ${campo('Agente', ctx.agente.get(l.owner_id))}
    ${campo('Primeiro contato', fmtData(l.primeiro_contato_em))}
    ${campo('Último contato', fmtData(l.ultimo_contato_em))}
    ${campo('Tentativas', String(l.tentativas || 0))}
  </dl>
  ${l.descricao ? `<p class="desc"><strong>Descrição:</strong> ${esc(l.descricao)}</p>` : ''}
  <div class="assin"><span>Aprovação do gestor</span><span>Data</span></div>
</article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${esc(titulo)} — ${fmtData(hojeISO())}</title>
<style>
  :root { --tinta:#111827; --fraco:#6b7280; --linha:#d1d5db; }
  * { box-sizing:border-box }
  body { font:13px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif; color:var(--tinta);
         margin:0; padding:24px; background:#fff; }
  header { border-bottom:2px solid var(--tinta); padding-bottom:10px; margin-bottom:18px; }
  h1 { font-size:19px; margin:0 0 3px }
  header p { margin:0; color:var(--fraco); font-size:11px }
  article { border:1px solid var(--linha); border-radius:6px; padding:12px 14px;
            margin-bottom:12px; page-break-inside:avoid; break-inside:avoid; }
  h2 { font-size:15px; margin:0 0 2px }
  .sub { margin:0 0 10px; color:var(--fraco); font-size:11px }
  dl { display:grid; grid-template-columns:repeat(4,1fr); gap:7px 14px; margin:0 }
  .c dt { font-size:9px; text-transform:uppercase; letter-spacing:.05em; color:var(--fraco); margin:0 }
  .c dd { margin:1px 0 0; font-size:12px }
  .desc { margin:10px 0 0; padding-top:8px; border-top:1px dashed var(--linha); font-size:12px }
  .assin { display:flex; gap:28px; margin-top:16px; padding-top:6px }
  .assin span { flex:1; border-top:1px solid var(--tinta); padding-top:3px;
                font-size:9px; color:var(--fraco); text-transform:uppercase; letter-spacing:.05em }
  footer { margin-top:18px; color:var(--fraco); font-size:10px; text-align:center }
  @media print {
    body { padding:0 }
    @page { margin:14mm }
    article { border-color:#999 }
  }
  @media screen { body { max-width:900px; margin:0 auto } }
</style></head>
<body>
<header>
  <h1>${esc(titulo)}</h1>
  <p>${leads.length} lead(s) · gerado em ${fmtData(hojeISO())}${autor ? ` por ${esc(autor)}` : ''} · Lex Prospecta</p>
</header>
${blocos || '<p>Nenhum lead no filtro selecionado.</p>'}
<footer>
  Documento com dados pessoais (LGPD). Uso interno — não redistribuir.
  Base legal: legítimo interesse, art. 7º, IX. Pedidos de descadastro: privacidade@alexandriabr.com
</footer>
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 350));<\/script>
</body></html>`;
}

export function abrirRelatorio(leads, ctx, opcoes) {
  const html = htmlRelatorio(leads, ctx, opcoes);
  const win = window.open('', '_blank');
  if (!win) {
    // popup bloqueado → entrega como arquivo
    baixar(new Blob([html], { type: 'text/html;charset=utf-8' }),
      nomeArquivo('relatorio', opcoes?.autor, 'html'));
    return false;
  }
  win.opener = null; // defesa em profundidade — a janela do relatório não precisa de acesso de volta ao app
  win.document.write(html);
  win.document.close();
  return true;
}
