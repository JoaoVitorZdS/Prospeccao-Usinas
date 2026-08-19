// db.js — camada de dados.
//
// Espelha o schema Postgres da seção 5 do plano em IndexedDB, mantendo os mesmos
// nomes de tabela e coluna, para que o port futuro (`supabase/migrations/0001_init.sql`)
// seja tradução mecânica e não redesenho.
//
// Duas regras do Postgres que o IndexedDB não tem e que são reimplementadas aqui:
//   1. índice único parcial `lead_cnpj_ativo` → campo derivado `cnpj_ativo`, que só
//      existe enquanto `deleted_at is null` (índice único do IDB ignora `undefined`);
//   2. RLS por `owner_id` → não há servidor, então o filtro por dono é de UI. Está
//      documentado como lacuna no SETUP.md; no Supabase vira policy de verdade.

import { uuid, digits, normCnpj, normFone, foneKey, normEmail, slug, hojeISO, dataLocal } from './util.js';
import { CONCESSIONARIAS, STATUS_MAP } from './seed.js';

const NOME_DB = 'lex-prospecta';
const VERSAO = 1;

export const LOJAS = ['profiles', 'concessionaria', 'usina_aneel', 'empresa', 'lead',
  'interacao', 'supressao', 'import_lote', 'captura_config', 'config'];

let _db = null;

export function abrir() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(NOME_DB, VERSAO);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const antiga = ev.oldVersion;

      if (antiga < 1) {
        const profiles = db.createObjectStore('profiles', { keyPath: 'id' });
        profiles.createIndex('email', 'email', { unique: true });

        db.createObjectStore('concessionaria', { keyPath: 'codigo' });

        const usina = db.createObjectStore('usina_aneel', { keyPath: 'cod_empreendimento' });
        usina.createIndex('cnpj', 'cnpj');
        usina.createIndex('uf', 'uf');
        usina.createIndex('concessionaria_codigo', 'concessionaria_codigo');
        usina.createIndex('dt_conexao', 'dt_conexao');

        const empresa = db.createObjectStore('empresa', { keyPath: 'cnpj' });
        empresa.createIndex('enriquecido_em', 'enriquecido_em');
        empresa.createIndex('uf_principal', 'uf_principal');

        const lead = db.createObjectStore('lead', { keyPath: 'id' });
        lead.createIndex('cnpj_ativo', 'cnpj_ativo', { unique: true }); // dedup no "banco"
        lead.createIndex('cnpj', 'cnpj');
        lead.createIndex('owner_id', 'owner_id');
        lead.createIndex('status', 'status');
        lead.createIndex('proxima_acao_em', 'proxima_acao_em');
        lead.createIndex('tel_key', 'tel_key');
        lead.createIndex('email_key', 'email_key');
        lead.createIndex('updated_at', 'updated_at');
        lead.createIndex('concessionaria_codigo', 'concessionaria_codigo');

        const inter = db.createObjectStore('interacao', { keyPath: 'id' });
        inter.createIndex('lead_id', 'lead_id');
        inter.createIndex('agente_id', 'agente_id');
        inter.createIndex('ocorrido_em', 'ocorrido_em');

        const sup = db.createObjectStore('supressao', { keyPath: 'id' });
        sup.createIndex('cnpj', 'cnpj', { unique: true });
        sup.createIndex('telefone', 'telefone', { unique: true });
        sup.createIndex('email', 'email', { unique: true });

        const lote = db.createObjectStore('import_lote', { keyPath: 'id' });
        lote.createIndex('created_at', 'created_at');

        db.createObjectStore('captura_config', { keyPath: 'id' });
        db.createObjectStore('config', { keyPath: 'chave' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      res(_db);
    };
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error('Banco bloqueado por outra aba aberta. Feche as demais abas.'));
  });
}

/* ═══════════════ Primitivas ═══════════════ */

const pedido = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

export async function tx(lojas, modo, fn) {
  const db = await abrir();
  const t = db.transaction(lojas, modo);
  const out = await fn(t, ...[].concat(lojas).map((l) => t.objectStore(l)));
  await new Promise((res, rej) => {
    t.oncomplete = res;
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transação abortada'));
  });
  return out;
}

export async function get(loja, chave) {
  const db = await abrir();
  return pedido(db.transaction(loja).objectStore(loja).get(chave));
}

export async function todos(loja, indice, faixa, limite) {
  const db = await abrir();
  const src = indice
    ? db.transaction(loja).objectStore(loja).index(indice)
    : db.transaction(loja).objectStore(loja);
  if (limite == null) return pedido(src.getAll(faixa));
  return pedido(src.getAll(faixa, limite));
}

export async function contar(loja, indice, faixa) {
  const db = await abrir();
  const st = db.transaction(loja).objectStore(loja);
  return pedido(indice ? st.index(indice).count(faixa) : st.count(faixa));
}

export async function put(loja, valor) {
  const db = await abrir();
  const t = db.transaction(loja, 'readwrite');
  const r = pedido(t.objectStore(loja).put(valor));
  await r;
  return valor;
}

export async function putMuitos(loja, valores) {
  if (!valores.length) return 0;
  await tx(loja, 'readwrite', (_t, st) => { for (const v of valores) st.put(v); });
  return valores.length;
}

export async function remover(loja, chave) {
  const db = await abrir();
  const t = db.transaction(loja, 'readwrite');
  await pedido(t.objectStore(loja).delete(chave));
}

export async function limparLoja(loja) {
  const db = await abrir();
  const t = db.transaction(loja, 'readwrite');
  await pedido(t.objectStore(loja).clear());
}

/** Percorre um índice sem carregar tudo na memória. `fn` pode devolver false para parar. */
export async function percorrer(loja, indice, faixa, fn) {
  const db = await abrir();
  return new Promise((res, rej) => {
    const st = db.transaction(loja).objectStore(loja);
    const src = indice ? st.index(indice) : st;
    const req = src.openCursor(faixa);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return res();
      if (fn(cur.value) === false) return res();
      cur.continue();
    };
    req.onerror = () => rej(req.error);
  });
}

/* ═══════════════ config (chave/valor) ═══════════════ */

export const getConfig = async (chave, padrao = null) =>
  (await get('config', chave))?.valor ?? padrao;

export const setConfig = (chave, valor) => put('config', { chave, valor });

/* ═══════════════ Concessionárias ═══════════════ */

let _aliasIndex = null;

export async function semearConcessionarias(forcar = false) {
  const n = await contar('concessionaria');
  if (n > 0 && !forcar) return n;
  await putMuitos('concessionaria', CONCESSIONARIAS.map((c) => ({ ...c })));
  _aliasIndex = null;
  return CONCESSIONARIAS.length;
}

async function aliasIndex() {
  if (_aliasIndex) return _aliasIndex;
  const lista = await todos('concessionaria');
  const m = new Map();
  for (const c of lista) {
    m.set(slug(c.codigo), c.codigo);
    m.set(slug(c.nome), c.codigo);
    for (const a of c.aliases || []) m.set(slug(a), c.codigo);
  }
  _aliasIndex = m;
  return m;
}

export const invalidarAliases = () => { _aliasIndex = null; };

/**
 * Casa o `NomAgente` da ANEEL (ou o texto da planilha) com o código canônico.
 * Fail-open: sem match devolve null e o chamador guarda em `concessionaria_raw`.
 */
export async function casarConcessionaria(texto) {
  if (!texto) return null;
  const idx = await aliasIndex();
  const s = slug(texto);
  if (!s) return null;
  if (idx.has(s)) return idx.get(s);
  // prefixo: "CEMIG DISTRIBUICAO SA" casa com "CEMIG"
  let melhor = null, tam = 0;
  for (const [k, v] of idx) {
    if (k.length >= 4 && k.length > tam && (s.startsWith(k) || s.includes(k))) {
      melhor = v; tam = k.length;
    }
  }
  return melhor;
}

/* ═══════════════ Perfis ═══════════════ */

export async function criarPerfil({ nome, email, papel = 'agente' }) {
  const p = {
    id: uuid(),
    nome: String(nome || '').trim(),
    email: normEmail(email) || String(email || '').trim().toLowerCase(),
    papel,
    ativo: true,
    created_at: new Date().toISOString(),
  };
  await put('profiles', p);
  return p;
}

export const perfis = () => todos('profiles');

export async function perfilAtual() {
  const id = await getConfig('perfil_atual');
  if (!id) return null;
  const p = await get('profiles', id);
  return p?.ativo ? p : null;
}

export const definirPerfilAtual = (id) => setConfig('perfil_atual', id);

/* ═══════════════ Supressão (opt-out persistente) ═══════════════ */

/**
 * Consultada em TODA ingestão e TODO import (seção 9). Quem pediu descadastro
 * continua bloqueado depois de reimportar a ANEEL no mês seguinte.
 */
export async function carregarSupressao() {
  const lista = await todos('supressao');
  return {
    cnpj: new Set(lista.map((s) => s.cnpj).filter(Boolean)),
    telefone: new Set(lista.map((s) => s.telefone).filter(Boolean)),
    email: new Set(lista.map((s) => s.email).filter(Boolean)),
    vazia: lista.length === 0,
    testar(alvo) {
      if (alvo.cnpj && this.cnpj.has(normCnpj(alvo.cnpj))) return 'cnpj';
      const fk = foneKey(alvo.telefone);
      if (fk && this.telefone.has(fk)) return 'telefone';
      const em = normEmail(alvo.email);
      if (em && this.email.has(em)) return 'email';
      return null;
    },
  };
}

export async function suprimir({ cnpj, telefone, email, motivo, registrado_por }) {
  const reg = {
    id: uuid(),
    cnpj: normCnpj(cnpj) || undefined,
    telefone: foneKey(telefone) || undefined,
    email: normEmail(email) || undefined,
    motivo: motivo || null,
    registrado_por: registrado_por || null,
    created_at: new Date().toISOString(),
  };
  if (!reg.cnpj && !reg.telefone && !reg.email) {
    throw new Error('Supressão exige ao menos CNPJ, telefone ou e-mail.');
  }
  // índice único: se já existe, não duplica
  const jaTem = await carregarSupressao();
  if (jaTem.testar({ cnpj: reg.cnpj, telefone: reg.telefone, email: reg.email })) return null;
  await put('supressao', reg);

  // marca os leads correspondentes como opt-out
  const alvos = await buscarLeads({ incluirRemovidos: false });
  const bater = alvos.filter((l) =>
    (reg.cnpj && l.cnpj === reg.cnpj)
    || (reg.telefone && l.tel_key === reg.telefone)
    || (reg.email && l.email_key === reg.email));
  for (const l of bater) {
    await salvarLead({ ...l, opt_out: true, status: 'descartado', status_motivo: 'Opt-out (LGPD)' });
  }
  return reg;
}

/* ═══════════════ Empresa ═══════════════ */

export async function upsertEmpresa(parcial) {
  const cnpj = normCnpj(parcial.cnpj);
  if (!cnpj) throw new Error('CNPJ inválido');
  const atual = (await get('empresa', cnpj)) || {
    cnpj, qtd_usinas: 0, distribuidoras: [], ufs: [],
    created_at: new Date().toISOString(),
  };
  const novo = { ...atual, ...parcial, cnpj, updated_at: new Date().toISOString() };
  await put('empresa', novo);
  return novo;
}

/**
 * Recalcula os agregados de `empresa` a partir de `usina_aneel`.
 * Equivale ao passo de materialização do ETL (seção 5.1).
 */
export async function agregarEmpresas(cnpjs) {
  const alvo = cnpjs ? new Set(cnpjs.map(normCnpj).filter(Boolean)) : null;
  const acc = new Map();
  await percorrer('usina_aneel', 'cnpj', null, (u) => {
    if (!u.cnpj) return;
    if (alvo && !alvo.has(u.cnpj)) return;
    let a = acc.get(u.cnpj);
    if (!a) {
      a = {
        cnpj: u.cnpj, razao_social: u.titular, qtd_usinas: 0, potencia_total_kw: 0,
        distribuidoras: new Set(), ufs: new Set(), municipios: new Set(),
        primeira_conexao: null, ultima_conexao: null, cep: null,
        tipos_geracao: new Set(), portes: new Set(), modalidades: new Set(),
        fases: new Set(),
      };
      acc.set(u.cnpj, a);
    }
    a.qtd_usinas++;
    a.potencia_total_kw += Number(u.potencia_kw || 0);
    if (u.concessionaria_codigo) a.distribuidoras.add(u.concessionaria_codigo);
    else if (u.distribuidora_nome) a.distribuidoras.add(u.distribuidora_nome);
    if (u.uf) a.ufs.add(u.uf);
    if (u.municipio) a.municipios.add(u.municipio);
    if (u.tipo_geracao) a.tipos_geracao.add(u.tipo_geracao);
    if (u.porte) a.portes.add(u.porte);
    if (u.modalidade) a.modalidades.add(u.modalidade);
    if (u.fase_usina) a.fases.add(u.fase_usina);
    if (u.cep && !a.cep) a.cep = u.cep;
    if (u.dt_conexao) {
      if (!a.primeira_conexao || u.dt_conexao < a.primeira_conexao) a.primeira_conexao = u.dt_conexao;
      if (!a.ultima_conexao || u.dt_conexao > a.ultima_conexao) a.ultima_conexao = u.dt_conexao;
    }
    if (!a.razao_social && u.titular) a.razao_social = u.titular;
  });

  const existentes = new Map((await todos('empresa')).map((e) => [e.cnpj, e]));
  const registros = [];
  for (const [cnpj, a] of acc) {
    const ant = existentes.get(cnpj) || { created_at: new Date().toISOString() };
    registros.push({
      ...ant,
      cnpj,
      razao_social: ant.razao_social || a.razao_social,
      qtd_usinas: a.qtd_usinas,
      potencia_total_kw: Math.round(a.potencia_total_kw * 1000) / 1000,
      distribuidoras: [...a.distribuidoras],
      ufs: [...a.ufs],
      uf_principal: [...a.ufs][0] || ant.uf_principal || null,
      municipio_principal: [...a.municipios][0] || ant.municipio_principal || null,
      tipos_geracao: [...a.tipos_geracao],
      portes: [...a.portes],
      modalidades: [...a.modalidades],
      fases: [...a.fases],
      cep: ant.cep || a.cep,
      primeira_conexao: a.primeira_conexao,
      ultima_conexao: a.ultima_conexao,
      updated_at: new Date().toISOString(),
    });
  }
  await putMuitos('empresa', registros);
  return registros.length;
}

/* ═══════════════ Dedup ═══════════════ */

/**
 * Ordem de confiança da seção 7.D: CNPJ exato → telefone (últimos 8) → e-mail.
 * Sem dedup fuzzy por razão social — gera falso positivo com matriz/filial.
 */
export async function acharDuplicado({ cnpj, telefone, email }, cache) {
  const c = normCnpj(cnpj);
  const fk = foneKey(telefone);
  const em = normEmail(email);

  if (cache) {
    if (c && cache.porCnpj.has(c)) return { lead: cache.porCnpj.get(c), por: 'cnpj' };
    if (fk && cache.porFone.has(fk)) return { lead: cache.porFone.get(fk), por: 'telefone' };
    if (em && cache.porEmail.has(em)) return { lead: cache.porEmail.get(em), por: 'email' };
    return null;
  }

  const db = await abrir();
  const st = db.transaction('lead').objectStore('lead');
  if (c) {
    const l = await pedido(st.index('cnpj_ativo').get(c));
    if (l) return { lead: l, por: 'cnpj' };
  }
  if (fk) {
    const achados = (await pedido(st.index('tel_key').getAll(fk))).filter((l) => !l.deleted_at);
    if (achados.length) return { lead: achados[0], por: 'telefone' };
  }
  if (em) {
    const achados = (await pedido(st.index('email_key').getAll(em))).filter((l) => !l.deleted_at);
    if (achados.length) return { lead: achados[0], por: 'email' };
  }
  return null;
}

/** Índice em memória para deduplicar um lote inteiro sem N consultas. */
export async function cacheDedup() {
  const leads = (await todos('lead')).filter((l) => !l.deleted_at);
  const cache = { porCnpj: new Map(), porFone: new Map(), porEmail: new Map(), leads };
  for (const l of leads) {
    if (l.cnpj) cache.porCnpj.set(l.cnpj, l);
    if (l.tel_key) cache.porFone.set(l.tel_key, l);
    if (l.email_key) cache.porEmail.set(l.email_key, l);
  }
  cache.registrar = (l) => {
    if (l.cnpj) cache.porCnpj.set(l.cnpj, l);
    if (l.tel_key) cache.porFone.set(l.tel_key, l);
    if (l.email_key) cache.porEmail.set(l.email_key, l);
  };
  return cache;
}

/* ═══════════════ Lead ═══════════════ */

/** Deriva os campos calculados. Espelha o que no Postgres seriam trigger/generated column. */
export function normalizarLead(l) {
  const cnpj = normCnpj(l.cnpj);
  const tel = normFone(l.telefone);
  const out = {
    ...l,
    cnpj: cnpj || undefined,
    telefone: tel || (l.telefone ? String(l.telefone).trim() : undefined),
    telefone2: normFone(l.telefone2) || undefined,
    email: normEmail(l.email) || undefined,
    tel_key: foneKey(l.telefone) || undefined,
    email_key: normEmail(l.email) || undefined,
    updated_at: new Date().toISOString(),
  };
  // índice único parcial: só indexa enquanto o lead está ativo
  if (cnpj && !out.deleted_at) out.cnpj_ativo = cnpj;
  else delete out.cnpj_ativo;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

export async function criarLead(dados) {
  const agora = new Date().toISOString();
  const l = normalizarLead({
    id: uuid(),
    tipo: 'usina_geradora',
    status: 'a_abordar',
    tentativas: 0,
    opt_out: false,
    proxima_acao_em: hojeISO(),
    created_at: agora,
    ...dados,
  });
  if (!l.owner_id) throw new Error('Lead precisa de dono (owner_id).');
  if (!l.origem) l.origem = 'outro';
  await put('lead', l);
  return l;
}

export async function salvarLead(l) {
  const norm = normalizarLead(l);
  await put('lead', norm);
  return norm;
}

/** Soft delete — libera o CNPJ do índice único, preservando o histórico. */
export async function removerLead(id) {
  const l = await get('lead', id);
  if (!l) return null;
  return salvarLead({ ...l, deleted_at: new Date().toISOString() });
}

export async function buscarLeads(filtro = {}) {
  const { owner_id, status, incluirRemovidos = false, texto, uf, concessionaria_codigo,
    origem, tipo, ate, apenasAtrasados, apenasHoje } = filtro;
  let lista = await todos('lead');
  if (!incluirRemovidos) lista = lista.filter((l) => !l.deleted_at);
  if (owner_id) lista = lista.filter((l) => l.owner_id === owner_id);
  if (status?.length) {
    const s = new Set([].concat(status));
    lista = lista.filter((l) => s.has(l.status));
  }
  if (uf) lista = lista.filter((l) => l.uf === uf);
  if (concessionaria_codigo) lista = lista.filter((l) => l.concessionaria_codigo === concessionaria_codigo);
  if (origem) lista = lista.filter((l) => l.origem === origem);
  if (tipo) lista = lista.filter((l) => l.tipo === tipo);
  const hoje = hojeISO();
  if (apenasAtrasados) lista = lista.filter((l) => l.proxima_acao_em && l.proxima_acao_em < hoje);
  if (apenasHoje) lista = lista.filter((l) => l.proxima_acao_em && l.proxima_acao_em <= hoje);
  if (ate) lista = lista.filter((l) => !l.proxima_acao_em || l.proxima_acao_em <= ate);
  if (texto) {
    const q = slug(texto);
    const qd = digits(texto);
    lista = lista.filter((l) =>
      slug(l.razao_social).includes(q)
      || slug(l.contato_nome).includes(q)
      || slug(l.cidade).includes(q)
      || (qd && (l.cnpj || '').includes(qd))
      || (qd && (l.telefone || '').includes(qd))
      || slug(l.email).includes(q));
  }
  return lista;
}

/** Ordem da fila: quem venceu primeiro, depois quem tem menos tentativas. */
export function ordenarFila(leads) {
  const inf = '9999-12-31';
  return leads.slice().sort((a, b) => {
    const pa = a.proxima_acao_em || inf, pb = b.proxima_acao_em || inf;
    if (pa !== pb) return pa < pb ? -1 : 1;
    if ((a.tentativas || 0) !== (b.tentativas || 0)) return (a.tentativas || 0) - (b.tentativas || 0);
    const oa = STATUS_MAP[a.status]?.ordem ?? 99, ob = STATUS_MAP[b.status]?.ordem ?? 99;
    if (oa !== ob) return oa - ob;
    return String(a.razao_social || '').localeCompare(String(b.razao_social || ''), 'pt-BR');
  });
}

/* ═══════════════ Interação ═══════════════ */

/**
 * Grava o toque e materializa no lead o que a fila precisa para priorizar
 * (`tentativas`, `ultimo_contato_em`, `descricao`, `status`). É o achatamento
 * descrito na seção 5.4 — o superior continua vendo uma linha por lead.
 */
export async function registrarInteracao({ lead, agente_id, canal, sentido = 'saida',
  resultado, status_apos, descricao, proxima_acao_em, status_motivo, ocorrido_em }) {
  const agora = new Date().toISOString();
  const inter = {
    id: uuid(),
    lead_id: lead.id,
    agente_id,
    canal,
    sentido,
    ocorrido_em: ocorrido_em || agora,
    resultado: resultado || null,
    status_apos: status_apos || lead.status,
    descricao: descricao || null,
    created_at: agora,
  };
  await put('interacao', inter);

  const dia = dataLocal(inter.ocorrido_em || agora);
  const atualizado = {
    ...lead,
    tentativas: (lead.tentativas || 0) + (sentido === 'saida' ? 1 : 0),
    ultimo_contato_em: dia,
    primeiro_contato_em: lead.primeiro_contato_em || dia,
    status: status_apos || lead.status,
    status_motivo: status_motivo ?? lead.status_motivo,
    descricao: descricao || lead.descricao,
    proxima_acao_em: proxima_acao_em === undefined ? lead.proxima_acao_em : proxima_acao_em,
  };
  const salvo = await salvarLead(atualizado);
  return { interacao: inter, lead: salvo };
}

export async function interacoesDoLead(lead_id) {
  const lista = await todos('interacao', 'lead_id', IDBKeyRange.only(lead_id));
  return lista.sort((a, b) => (a.ocorrido_em < b.ocorrido_em ? 1 : -1));
}

/* ═══════════════ Lote de importação ═══════════════ */

export async function registrarLote(dados) {
  const lote = {
    id: uuid(),
    created_at: new Date().toISOString(),
    total: 0, criados: 0, duplicados: 0, erros: 0,
    ...dados,
  };
  await put('import_lote', lote);
  return lote;
}

/* ═══════════════ Backup ═══════════════ */
// Projeto autocontido não tem backup diário de Supabase Pro. O export JSON é o
// substituto — e o único jeito de mover a base entre navegadores/máquinas.

export async function exportarBackup() {
  const dump = { app: 'lex-prospecta', versao: VERSAO, exportado_em: new Date().toISOString(), dados: {} };
  for (const loja of LOJAS) dump.dados[loja] = await todos(loja);
  return dump;
}

export async function importarBackup(dump, { substituir = false } = {}) {
  if (dump?.app !== 'lex-prospecta') throw new Error('Arquivo não é um backup do Lex Prospecta.');
  const resumo = {};
  for (const loja of LOJAS) {
    const registros = dump.dados?.[loja] || [];
    if (substituir) await limparLoja(loja);
    // normaliza leads antigos para reconstruir os campos derivados
    const prep = loja === 'lead' ? registros.map(normalizarLead) : registros;
    resumo[loja] = await putMuitos(loja, prep);
  }
  _aliasIndex = null;
  return resumo;
}

export async function apagarTudo() {
  for (const loja of LOJAS) await limparLoja(loja);
  _aliasIndex = null;
}

/** Uso de armazenamento — o navegador pode despejar dados sob pressão de disco. */
export async function usoArmazenamento() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  const persistido = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  return { usage, quota, persistido };
}
