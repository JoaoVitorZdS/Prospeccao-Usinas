// util.js — normalização, formatação, CSV e helpers de DOM.
// Sem dependências. Tudo que o resto do app usa para não repetir regra de negócio.

/* ═══════════════ Identificadores e normalização ═══════════════ */

export const digits = (v) => String(v ?? '').replace(/\D+/g, '');

/** CNPJ com 14 dígitos, ou null. Não valida DV — a ANEEL tem lixo e queremos fail-open. */
export function normCnpj(v) {
  const d = digits(v);
  if (d.length === 14) return d;
  // Só completa o caso específico e conhecido: Excel converteu o CNPJ em número e
  // comeu exatamente o zero à esquerda (13 dígitos restantes). Qualquer contagem
  // menor é lixo de outra natureza (ex.: fragmento de CPF mascarado da ANEEL, tipo
  // "***.754.418-**" → 6 dígitos) — completar com zeros geraria um CNPJ FALSO que
  // parece válido e pode colidir/deduplicar errado. Fail-open é para dado incompleto
  // reconhecível, não para inventar identidade a partir de qualquer número curto.
  if (d.length === 13) return `0${d}`;
  return null;
}

/** Valida o dígito verificador. Usado só para avisar, nunca para bloquear. */
export function cnpjValido(cnpj) {
  const d = digits(cnpj);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len) => {
    let soma = 0, pos = len - 7;
    for (let i = 0; i < len; i++) {
      soma += Number(d[i]) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export const maskCnpj = (v) => {
  const d = digits(v);
  if (d.length !== 14) return v || '';
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
};

export const maskCep = (v) => {
  const d = digits(v);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : (v || '');
};

/** Telefone só com dígitos nacionais (sem DDI 55). */
export function normFone(v) {
  let d = digits(v);
  if (!d) return null;
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length < 8) return null;
  return d.slice(0, 11);
}

/** Chave de dedup: últimos 8 dígitos — absorve DDI, 9º dígito e máscara. */
export function foneKey(v) {
  const d = digits(v);
  return d.length >= 8 ? d.slice(-8) : null;
}

export function maskFone(v) {
  const d = normFone(v);
  if (!d) return v || '';
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  if (d.length === 9) return `${d.slice(0, 5)}-${d.slice(5)}`;
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4)}`;
  return d;
}

/** Link wa.me exige DDI. Assume 55 quando o número parece nacional. */
export function waLink(v) {
  const d = normFone(v);
  if (!d) return null;
  return `https://wa.me/55${d}`;
}

export function normEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Remove acento, baixa caixa, tira não-alfanumérico. Para casar cabeçalho e alias. */
export function slug(v) {
  return String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export const uuid = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));

/* ═══════════════ Datas ═══════════════ */

export const hojeISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Data LOCAL (YYYY-MM-DD) de um timestamp ISO com hora — não confundir com
 * `iso.slice(0, 10)`, que dá a data em UTC. Em fuso negativo (Brasil, UTC-3),
 * um toque registrado às 21h–23h59 locais já é "amanhã" em UTC — fatiar direto
 * fazia `ultimo_contato_em`, os filtros de período do Painel/Exportar e o
 * contador "aguardando há Xd" de Conversas todos acharem que o toque de hoje
 * à noite tinha acontecido amanhã. Use isto sempre que for comparar o dia de
 * um timestamp contra `hojeISO()`/`addDias()` (que são locais por definição).
 */
export function dataLocal(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDias(iso, n) {
  const [y, m, d] = (iso || hojeISO()).split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function diasEntre(isoA, isoB) {
  if (!isoA || !isoB) return null;
  const a = new Date(isoA + 'T00:00:00'), b = new Date(isoB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/** Aceita dd/mm/aaaa, aaaa-mm-dd, serial do Excel e Date. Devolve ISO ou null. */
export function parseData(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) > 60 ? '19' : '20') + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // serial do Excel (epoch 1899-12-30)
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return dt.toISOString().slice(0, 10);
  }
  return null;
}

export const fmtData = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

export const fmtDataHora = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/* ═══════════════ Números ═══════════════ */

/** Aceita "1.234,56" e "1234.56". */
export function parseNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  const virg = s.lastIndexOf(','), pto = s.lastIndexOf('.');
  if (virg > pto) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return isFinite(n) ? n : null;
}

export const fmtNum = (n, dec = 0) =>
  (n == null || !isFinite(n) ? '' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec }));

/** kW → texto legível; acima de 1000 mostra MW. */
export function fmtPotencia(kw) {
  if (kw == null || !isFinite(kw)) return '';
  if (kw >= 1000) return `${fmtNum(kw / 1000, 2)} MW`;
  return `${fmtNum(kw, 2)} kW`;
}

/* ═══════════════ CSV ═══════════════ */

/** Detecta separador olhando a 1ª linha fora de aspas. */
export function detectarSep(texto) {
  const linha = texto.split(/\r?\n/, 1)[0] || '';
  const cand = [';', ',', '\t', '|'];
  let melhor = ';', max = -1;
  for (const c of cand) {
    let n = 0, aspas = false;
    for (let i = 0; i < linha.length; i++) {
      if (linha[i] === '"') aspas = !aspas;
      else if (linha[i] === c && !aspas) n++;
    }
    if (n > max) { max = n; melhor = c; }
  }
  return max > 0 ? melhor : ';';
}

/** Parser CSV/TSV conforme RFC 4180 (aspas duplas escapadas por duplicação). */
export function parseCSV(texto, sep) {
  const t = texto.replace(/^\uFEFF/, '');
  const s = sep || detectarSep(t);
  const linhas = [];
  let campo = '', linha = [], aspas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (aspas) {
      if (c === '"') {
        if (t[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { aspas = true; continue; }
    if (c === s) { linha.push(campo); campo = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue; }
    campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas.filter((l) => l.some((c) => String(c).trim() !== ''));
}

const csvCampo = (v) => {
  const s = v == null ? '' : String(v);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV no dialeto do Excel-pt: BOM UTF-8, separador ';', CRLF. */
export function paraCSV(cabecalho, linhas) {
  const corpo = [cabecalho, ...linhas].map((l) => l.map(csvCampo).join(';')).join('\r\n');
  return '\uFEFF' + corpo + '\r\n';
}

export function baixar(conteudo, nome, tipo = 'text/csv;charset=utf-8') {
  const blob = conteudo instanceof Blob ? conteudo : new Blob([conteudo], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Nome de arquivo rastreável: exports são dado pessoal (LGPD, seção 9). */
export const nomeArquivo = (base, agente, ext) =>
  `${base}_${hojeISO()}_${slug(agente || 'sistema').slice(0, 20)}.${ext}`;

/* ═══════════════ DOM ═══════════════ */

export const $ = (sel, raiz = document) => raiz.querySelector(sel);
export const $$ = (sel, raiz = document) => Array.from(raiz.querySelectorAll(sel));

export const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Só deixa passar http(s) (e opcionalmente mailto/tel). Os links de pesquisa
 * do cockpit (Config → Links) são editáveis por qualquer gestor — sem essa
 * checagem, colar `javascript:...` ali por engano (ou de propósito) vira um
 * link clicável que executa código no clique. `href` inseguro cai para `#`
 * em vez de quebrar a renderização.
 */
export function urlSegura(url, { permitir = ['http:', 'https:'] } = {}) {
  try {
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const u = new URL(String(url), base);
    return permitir.includes(u.protocol) ? u.href : '#';
  } catch {
    return '#';
  }
}

// Sem opção `html:` para innerHTML de propósito: todo o app monta DOM via
// `document.createTextNode` (abaixo) ou `setAttribute`, nunca via string HTML —
// isso é o que garante que dado importado (CSV/XLSX/colagem, todo não confiável)
// nunca vira markup executável. Se algum dia precisar de HTML bruto, isso tem
// que ser uma decisão explícita e escapada no call site, não uma opção genérica
// aqui que qualquer código futuro poderia usar sem pensar.
export function h(tag, attrs = {}, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat(9)) {
    if (f == null || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}

/**
 * Filtra `null`/`false`/`undefined` de uma lista de filhos, achatando arrays aninhados.
 * `h()` já faz isso internamente para seus próprios filhos — este helper existe para
 * os poucos lugares que chamam `.append()`/`.replaceChildren()` nativos do DOM
 * diretamente (fora de `h()`), onde um `condicao ? elemento : null` top-level vira,
 * silenciosamente, um nó de texto "null" na página (comportamento nativo do DOM:
 * argumentos não-Node são convertidos com `String()`). Uso: `el.append(...limpar(a, b ? c : null))`.
 */
export const limpar = (...filhos) => filhos.flat(9).filter((f) => f != null && f !== false);

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch {
    // fallback para contexto sem permissão (http, iframe)
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  }
}

export const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

/** Agrupa por chave. */
export function agrupar(itens, chave) {
  const m = new Map();
  for (const it of itens) {
    const k = typeof chave === 'function' ? chave(it) : it[chave];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}
