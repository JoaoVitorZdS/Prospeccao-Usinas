// db.js — camada de dados, falando com Postgres de verdade via Supabase.
//
// Antes desta versão, este módulo falava com IndexedDB local (cada navegador
// com sua própria base). Agora fala com o projeto Supabase configurado em
// `supabase-config.js` (gitignored — ver supabase-config.example.js) — os
// dados são reais e compartilhados entre todos os agentes e dispositivos.
//
// A troca ficou concentrada nas PRIMITIVAS (get/todos/put/putMuitos/remover/
// limparLoja/contar/percorrer) logo abaixo. Toda a lógica de negócio depois
// delas — criarLead, buscarLeads, registrarInteracao, upsertEmpresa,
// agregarEmpresas, dedup, supressão — não mudou uma linha: ela sempre foi
// escrita por cima dessas primitivas, nunca falando com IndexedDB direto.
// Esse desacoplamento é o que tornou a troca de backend uma operação
// localizada, não uma reescrita do app inteiro.
//
// Segurança: o app roda logado (Supabase Auth, e-mail e senha — ver js/auth.js) e o
// isolamento é feito pelo RLS do banco (supabase/migrations/0006_auth_rls.sql): agente
// só enxerga os próprios leads e conversas; gestor enxerga tudo. A publishable key
// continua pública por design — sozinha ela não lê nada, porque `anon` não tem acesso
// a nenhuma tabela. Por isso as telas NÃO precisam mais filtrar por dono para ser
// seguras: o filtro por dono que ainda existe aqui é só organização/UX.
//
// `createClient` vem de vendor/supabase-js-*.umd.js, carregado como <script>
// clássico em index.html ANTES deste módulo — por isso `window.supabase`
// já existe quando `abrir()` roda. Vendorado (não CDN) de propósito: mantém
// a CSP em `script-src 'self'`, sem abrir mão da política já testada.

import { uuid, digits, normCnpj, normFone, foneKey, normEmail, slug, hojeISO, dataLocal } from './util.js';
import { CONCESSIONARIAS, BACKLOG_INICIAL, STATUS_MAP } from './seed.js';
import { SUPABASE_URL, SUPABASE_KEY } from './supabase-config.js';

export const LOJAS = ['profiles', 'concessionaria', 'usina_aneel', 'empresa', 'lead',
  'interacao', 'supressao', 'import_lote', 'captura_config', 'backlog'];

const VERSAO_BACKUP = 2; // 1 = formato da era IndexedDB; 2 = inclui config local separado

/** Nome da coluna de chave primária por tabela — só usado pelas primitivas abaixo. */
const PK = {
  profiles: 'id', concessionaria: 'codigo', usina_aneel: 'cod_empreendimento',
  empresa: 'cnpj', lead: 'id', interacao: 'id', supressao: 'id',
  import_lote: 'id', captura_config: 'id', backlog: 'concessionaria_codigo',
};

let _sb = null;

export function abrir() {
  if (_sb) return Promise.resolve(_sb);
  if (typeof window === 'undefined' || !window.supabase?.createClient) {
    throw new Error(
      'supabase-js não carregou. Confira se vendor/supabase-js-*.umd.js está '
      + 'incluído em index.html ANTES de js/app.js, e se js/supabase-config.js existe '
      + '(copie de supabase-config.example.js e preencha com os dados do seu projeto).',
    );
  }
  _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    // PKCE: o retorno dos links do e-mail vem em `?code=` (e não em `#access_token=`),
    // que não colide com o roteador por hash (#/rota).
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });
  return Promise.resolve(_sb);
}

/* ═══════════════ Primitivas ═══════════════ */

function checar(resp) {
  if (resp.error) {
    const e = new Error(resp.error.message || 'Erro no Supabase');
    e.codigo = resp.error.code;
    e.detalhe = resp.error.details;
    throw e;
  }
  return resp.data;
}

/** PostgREST rejeita alguns valores `undefined` de forma inconsistente — sempre limpar antes de enviar. */
function semUndefined(obj) {
  const out = { ...obj };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

const TAMANHO_PAGINA = 1000; // teto do PostgREST por requisição

export async function get(loja, chave) {
  if (chave == null) return undefined;
  const sb = await abrir();
  const data = await checar(await sb.from(loja).select('*').eq(PK[loja], chave).maybeSingle());
  return data || undefined;
}

// Trava de segurança genérica: sem isto, `todos('empresa')` numa base de
// 360 mil linhas (import sem recorte da ANEEL) dispara ~360 requisições
// SEQUENCIAIS ao Supabase toda vez que uma tela carrega — lento pro usuário
// e o jeito mais fácil de estourar o limite de uso do projeto. Isso já
// aconteceu de verdade em produção (Descobrir ficando "lenta, tentando
// carregar tudo ao mesmo tempo"). `todos()` sem `limite` explícito agora
// para de paginar depois de `TETO_PAGINAS_SEGURANCA` páginas e AVISA no
// console — é um teto de emergência, não a solução: quem precisa de uma
// tabela grande inteira (agregação, backup) deve pedir explicitamente com
// `limite` ou usar `buscarTop`/consulta filtrada no servidor, não confiar
// no `todos()` genérico crescendo sem fim.
const TETO_PAGINAS_SEGURANCA = 30; // 30 × 1000 = 30 mil linhas no máximo por chamada sem `limite`

/**
 * `indice`/`faixa`: quando os dois vêm preenchidos, filtra por igualdade
 * nessa coluna (equivalente ao que antes era `IDBKeyRange.only(faixa)`).
 * Pagina automaticamente além do limite de 1000 linhas por requisição do
 * PostgREST — necessário pra `usina_aneel` depois de um import grande, mas
 * travado em `TETO_PAGINAS_SEGURANCA` (ver acima).
 */
export async function todos(loja, indice, faixa, limite) {
  const sb = await abrir();
  let base = sb.from(loja).select('*');
  if (indice && faixa != null) base = base.eq(indice, faixa);
  if (limite) return checar(await base.limit(limite));

  let acc = [], desde = 0;
  for (let pagina_n = 0; pagina_n < TETO_PAGINAS_SEGURANCA; pagina_n++) {
    const pagina = await checar(await base.range(desde, desde + TAMANHO_PAGINA - 1));
    acc = acc.concat(pagina);
    if (pagina.length < TAMANHO_PAGINA) return acc;
    desde += TAMANHO_PAGINA;
  }
  console.warn(`todos('${loja}') parou em ${acc.length} linhas (teto de segurança) — `
    + 'use `limite` explícito ou `buscarTop`/`contar` com filtro pra tabelas grandes.');
  return acc;
}

/**
 * Busca ordenada e limitada EM UMA SÓ REQUISIÇÃO — para telas sobre tabelas
 * grandes (Descobrir sobre `empresa`) onde `todos()` paginando tudo seria o
 * próprio gargalo. `filtro` é um escape hatch pro query builder do
 * supabase-js (`.eq()`, `.contains()` em coluna array, etc.), pra não travar
 * este helper a um único tipo de filtro.
 */
export async function buscarTop(loja, { colunas = '*', ordenarPor, ascendente = false, limite = 3000, filtro } = {}) {
  const sb = await abrir();
  let q = sb.from(loja).select(colunas);
  if (filtro) q = filtro(q);
  if (ordenarPor) q = q.order(ordenarPor, { ascending: ascendente, nullsFirst: false });
  return checar(await q.limit(limite));
}

/**
 * Busca só as `empresa` cujos CNPJs estão na lista — pro caso comum de "tenho
 * uma leva de leads, preciso do contato/potência de cada um". Painel, Fila e
 * Exportar faziam `todos('empresa')` (a tabela inteira) só pra montar esse
 * lookup; numa base grande da ANEEL isso reproduz o mesmo gargalo do
 * Descobrir, e sem necessidade — o número de leads de uma equipe é sempre
 * muito menor que o total de empresas na base.
 */
export async function empresasPorCnpj(cnpjs) {
  const unicos = [...new Set(cnpjs.filter(Boolean))];
  if (!unicos.length) return [];
  const sb = await abrir();
  const LOTE = 300; // `.in()` com milhares de valores estoura o tamanho da URL
  let acc = [];
  for (let i = 0; i < unicos.length; i += LOTE) {
    const pagina = await checar(await sb.from('empresa').select('*').in('cnpj', unicos.slice(i, i + LOTE)));
    acc = acc.concat(pagina);
  }
  return acc;
}

/** `aplicarFiltro`, quando passado, recebe o query builder — `(q) => q.not('x', 'is', null)` etc. */
export async function contar(loja, aplicarFiltro) {
  const sb = await abrir();
  let q = sb.from(loja).select('*', { count: 'exact', head: true });
  if (aplicarFiltro) q = aplicarFiltro(q);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

export async function put(loja, valor) {
  const sb = await abrir();
  const data = await checar(await sb.from(loja).upsert(semUndefined(valor)).select().maybeSingle());
  return data || valor;
}

/**
 * Upsert em lotes. LOTE=2000 (não 500): pra 360 mil linhas isso é a diferença
 * entre ~180 requisições e ~720 — o import da ANEEL sem recorte também estava
 * martelando o Supabase por causa disso, não só a tela de Descobrir.
 */
export async function putMuitos(loja, valores) {
  if (!valores.length) return 0;
  const sb = await abrir();
  const LOTE = 2000;
  const limpos = valores.map(semUndefined);
  for (let i = 0; i < limpos.length; i += LOTE) {
    await checar(await sb.from(loja).upsert(limpos.slice(i, i + LOTE)));
  }
  return valores.length;
}

export async function remover(loja, chave) {
  const sb = await abrir();
  await checar(await sb.from(loja).delete().eq(PK[loja], chave));
}

export async function limparLoja(loja) {
  const sb = await abrir();
  await checar(await sb.from(loja).delete().not(PK[loja], 'is', null));
}

/** Sem cursor de servidor via PostgREST — pagina e chama `fn` por linha. `fn` → false interrompe. */
export async function percorrer(loja, _indice, _faixa, fn) {
  const sb = await abrir();
  let desde = 0;
  for (;;) {
    const pagina = await checar(await sb.from(loja).select('*').range(desde, desde + TAMANHO_PAGINA - 1));
    for (const linha of pagina) {
      if (fn(linha) === false) return;
    }
    if (pagina.length < TAMANHO_PAGINA) break;
    desde += TAMANHO_PAGINA;
  }
}

/* ═══════════════ config (chave/valor) — fica no navegador, de propósito ═══════════════ */
// `perfil_atual` e `aviso_ios_visto` são estado de DISPOSITIVO ("quem está usando
// ESTE navegador"), não dado de negócio — não faz sentido sincronizar entre
// aparelhos. `script_template`/`links_externos` idealmente seriam compartilhados
// entre a equipe; por ora ficam por dispositivo também (mesma limitação que a
// versão 100% local já tinha) — mover pra uma tabela `config` no Supabase é
// trabalho isolado e pequeno quando isso virar dor de verdade.

const PREFIXO_CONFIG = 'wattscout:';
const PREFIXO_CONFIG_LEGADO = 'lex-prospecta:'; // nome antigo do app — migrado uma vez, abaixo

/** Copia as preferências guardadas sob o nome antigo (script, links, aviso do iOS) para
 *  o prefixo novo, sem apagar nada. Roda uma vez por navegador; nunca derruba o app. */
function migrarConfigLegada() {
  try {
    if (localStorage.getItem(PREFIXO_CONFIG + '__migrado')) return;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIXO_CONFIG_LEGADO)) continue;
      const novo = PREFIXO_CONFIG + k.slice(PREFIXO_CONFIG_LEGADO.length);
      if (localStorage.getItem(novo) == null) localStorage.setItem(novo, localStorage.getItem(k));
    }
    localStorage.setItem(PREFIXO_CONFIG + '__migrado', '1');
  } catch { /* storage bloqueado: segue com os padrões */ }
}
migrarConfigLegada();

export async function getConfig(chave, padrao = null) {
  try {
    const bruto = localStorage.getItem(PREFIXO_CONFIG + chave);
    return bruto == null ? padrao : JSON.parse(bruto);
  } catch {
    return padrao;
  }
}

export async function setConfig(chave, valor) {
  localStorage.setItem(PREFIXO_CONFIG + chave, JSON.stringify(valor));
}

/* ═══════════════ Concessionárias ═══════════════ */

let _aliasIndex = null;

export async function semearConcessionarias(forcar = false) {
  const atuais = await todos('concessionaria');
  const existentes = new Set(atuais.map((c) => c.codigo));
  const faltando = CONCESSIONARIAS.filter((c) => !existentes.has(c.codigo));
  // já cheia e sem código novo → não escreve nada (evita martelar o Supabase a cada boot)
  if (atuais.length && !faltando.length && !forcar) return atuais.length;
  // primeira vez → tudo; já cheia mas com código novo (ex.: as permissionárias do
  // backlog) → só os que faltam, sem reescrever as 40+ existentes
  const alvo = forcar || !atuais.length ? CONCESSIONARIAS : faltando;
  await putMuitos('concessionaria', alvo.map((c) => ({ ...c })));
  _aliasIndex = null;
  return alvo.length;
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

/* ═══════════════ Backlog comercial por distribuidora ═══════════════ */
// kWh/mês de consumo que já está contratado/em pipeline numa área de concessão e
// ainda não tem usina geradora casada na MESMA distribuidora. É o que a tela
// Backlog mostra e o que dá prioridade de prospecção em Descobrir. Fonte da
// verdade: tabela `backlog` no Supabase; `BACKLOG_INICIAL` (seed.js) é só a
// carga da primeira vez.

export const backlogTodos = () => todos('backlog');

/** Semeia `backlog` a partir de BACKLOG_INICIAL se a tabela estiver vazia. Idempotente. */
export async function semearBacklog(forcar = false) {
  const n = await contar('backlog');
  if (n > 0 && !forcar) return n;
  // só semeia códigos que existem em `concessionaria` (a FK barraria o lote inteiro)
  const validos = new Set((await todos('concessionaria')).map((c) => c.codigo));
  const registros = Object.entries(BACKLOG_INICIAL)
    .filter(([codigo]) => validos.has(codigo))
    .map(([concessionaria_codigo, backlog_kwh_mes]) => ({ concessionaria_codigo, backlog_kwh_mes }));
  if (!registros.length) return 0;
  await putMuitos('backlog', registros);
  return registros.length;
}

/** Grava o backlog de uma distribuidora. `valor` em kWh/mês, negativo vira 0. */
export async function salvarBacklog(codigo, valor, { perfilId, nota } = {}) {
  if (!codigo) throw new Error('Distribuidora é obrigatória.');
  const reg = {
    concessionaria_codigo: codigo,
    backlog_kwh_mes: Math.max(0, Number(valor) || 0),
    nota: nota || null,
    atualizado_por: perfilId || null,
    atualizado_em: new Date().toISOString(),
  };
  await put('backlog', reg);
  return reg;
}

/* ═══════════════ Perfis ═══════════════ */

// RLS: agente recebe só a própria linha; gestor recebe todas.
export const perfis = () => todos('profiles');

/** Perfil do usuário logado. Liga a conta ao perfil pelo e-mail confirmado ou cria um
 *  perfil pendente (RPC `reivindicar_perfil`, ver 0006). Pode devolver `ativo: false`. */
export async function perfilAtual() {
  const sb = await abrir();
  return checar(await sb.rpc('reivindicar_perfil'));
}

/** Gestão de contas — só gestor (o banco recusa os demais). */
export async function alterarPapel(perfilId, papel) {
  const sb = await abrir();
  return checar(await sb.rpc('alterar_papel', { p_perfil: perfilId, p_papel: papel }));
}

export async function definirAtivo(perfilId, ativo) {
  const sb = await abrir();
  return checar(await sb.rpc('definir_ativo', { p_perfil: perfilId, p_ativo: !!ativo }));
}

/** Gestor reserva um e-mail com papel definido: a pessoa assume o perfil ao criar a conta. */
export async function precadastrarPerfil({ nome, email, papel = 'agente' }) {
  const sb = await abrir();
  const reg = {
    nome: String(nome || '').trim(),
    email: String(email || '').trim().toLowerCase(),
    papel,
    ativo: true,
  };
  if (!reg.nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reg.email)) throw new Error('Informe nome e um e-mail válido.');
  return checar(await sb.from('profiles').insert(reg).select().maybeSingle());
}

/** O próprio usuário só pode mudar o nome (papel/situação/e-mail são barrados pelo banco). */
export async function atualizarMeuNome(perfilId, nome) {
  const sb = await abrir();
  const limpo = String(nome || '').trim();
  if (!limpo) throw new Error('O nome não pode ficar vazio.');
  return checar(await sb.from('profiles').update({ nome: limpo }).eq('id', perfilId).select().maybeSingle());
}

export async function auditoriaPerfis(limite = 40) {
  return buscarTop('perfil_auditoria', { ordenarPor: 'created_at', limite });
}

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
  // O gatilho `supressao_aplicar` (0006) marca como opt-out os leads correspondentes de TODOS os
  // agentes — aqui o usuário só enxerga os próprios, então isso não pode ser feito no cliente.
  await put('supressao', reg);
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

  // `percorrer` (não `todos`) de propósito: precisa ver TODA `empresa`, sem o
  // teto de segurança de `todos()` — truncar aqui perderia telefone/e-mail já
  // enriquecido de quem ficasse de fora do corte numa base grande.
  const existentes = new Map();
  await percorrer('empresa', null, null, (e) => { existentes.set(e.cnpj, e); });
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

  const sb = await abrir();
  if (c) {
    const l = await checar(await sb.from('lead').select('*').eq('cnpj', c).is('deleted_at', null).maybeSingle());
    if (l) return { lead: l, por: 'cnpj' };
  }
  if (fk) {
    const achados = await checar(await sb.from('lead').select('*').eq('tel_key', fk).is('deleted_at', null).limit(1));
    if (achados.length) return { lead: achados[0], por: 'telefone' };
  }
  if (em) {
    const achados = await checar(await sb.from('lead').select('*').eq('email_key', em).is('deleted_at', null).limit(1));
    if (achados.length) return { lead: achados[0], por: 'email' };
  }
  // Nada na carteira do usuário (o RLS só deixa ver a própria): pergunta ao banco se algum
  // colega já tem esse CNPJ/telefone/e-mail — sem revelar quem nem o conteúdo do lead.
  const alheios = await consultarAlheios({ cnpjs: c ? [c] : [], fones: fk ? [fk] : [], emails: em ? [em] : [] });
  if (c && alheios.cnpj.has(c)) return { lead: leadAlheio({ cnpj: c }), por: 'cnpj', alheio: true };
  if (fk && alheios.telefone.has(fk)) return { lead: leadAlheio({ tel_key: fk }), por: 'telefone', alheio: true };
  if (em && alheios.email.has(em)) return { lead: leadAlheio({ email_key: em }), por: 'email', alheio: true };
  return null;
}

/** Marcador de "existe um lead assim na carteira de OUTRO agente" — sem id, dono nem dados. */
const leadAlheio = (chaves) => ({ id: null, alheio: true, owner_id: null, status: null, ...chaves });

/**
 * Pergunta ao banco quais chaves já existem em leads ATIVOS de qualquer agente (RPC
 * `checar_duplicados`, 0006). Devolve Maps chave → "é meu?". Lotes de 500 por chamada.
 */
export async function consultarAlheios({ cnpjs = [], fones = [], emails = [] } = {}) {
  const out = { cnpj: new Map(), telefone: new Map(), email: new Map() };
  const un = (a) => [...new Set(a.filter(Boolean))];
  const [C, F, E] = [un(cnpjs), un(fones), un(emails)];
  const total = Math.max(C.length, F.length, E.length);
  if (!total) return out;
  const sb = await abrir();
  const LOTE = 500;
  for (let i = 0; i < total; i += LOTE) {
    const linhas = await checar(await sb.rpc('checar_duplicados', {
      p_cnpjs: C.slice(i, i + LOTE), p_tel_keys: F.slice(i, i + LOTE), p_email_keys: E.slice(i, i + LOTE),
    }));
    for (const r of linhas || []) out[r.tipo].set(r.chave, !!r.meu);
  }
  return out;
}

/**
 * Índice em memória para deduplicar um lote inteiro sem N consultas. Contém os leads do
 * próprio usuário (o RLS não mostra os dos colegas); passando `candidatos`
 * ({ cnpjs, fones, emails } do arquivo que vai ser importado) ele também consulta o banco
 * por quem já tem essas chaves em outra carteira e registra um marcador `alheio: true`.
 */
export async function cacheDedup(candidatos) {
  const leads = (await todos('lead')).filter((l) => !l.deleted_at);
  const cache = { porCnpj: new Map(), porFone: new Map(), porEmail: new Map(), leads };
  for (const l of leads) {
    if (l.cnpj) cache.porCnpj.set(l.cnpj, l);
    if (l.tel_key) cache.porFone.set(l.tel_key, l);
    if (l.email_key) cache.porEmail.set(l.email_key, l);
  }
  if (candidatos) {
    const alheios = await consultarAlheios(candidatos);
    for (const [k, meu] of alheios.cnpj) if (!meu && !cache.porCnpj.has(k)) cache.porCnpj.set(k, leadAlheio({ cnpj: k }));
    for (const [k, meu] of alheios.telefone) if (!meu && !cache.porFone.has(k)) cache.porFone.set(k, leadAlheio({ tel_key: k }));
    for (const [k, meu] of alheios.email) if (!meu && !cache.porEmail.has(k)) cache.porEmail.set(k, leadAlheio({ email_key: k }));
  }
  cache.registrar = (l) => {
    if (l.cnpj) cache.porCnpj.set(l.cnpj, l);
    if (l.tel_key) cache.porFone.set(l.tel_key, l);
    if (l.email_key) cache.porEmail.set(l.email_key, l);
  };
  return cache;
}

/* ═══════════════ Lead ═══════════════ */

/** Deriva os campos calculados. No Postgres, quem cuida do índice único parcial
 * por CNPJ ativo é a própria migration (`lead_cnpj_ativo`) — não precisa mais
 * de um campo sintético pra imitar isso (era só necessário pro IndexedDB). */
export function normalizarLead(l) {
  const cnpj = normCnpj(l.cnpj);
  const out = {
    ...l,
    cnpj: cnpj || undefined,
    telefone: normFone(l.telefone) || (l.telefone ? String(l.telefone).trim() : undefined),
    telefone2: normFone(l.telefone2) || undefined,
    email: normEmail(l.email) || undefined,
    tel_key: foneKey(l.telefone) || undefined,
    email_key: normEmail(l.email) || undefined,
    updated_at: new Date().toISOString(),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** CNPJs que já têm lead ativo em qualquer carteira (RPC `cnpjs_com_lead`) — só o CNPJ, sem dados do lead. */
export async function cnpjsComLead() {
  const sb = await abrir();
  const linhas = await checar(await sb.rpc('cnpjs_com_lead'));
  return new Set((linhas || []).map((r) => (typeof r === 'string' ? r : Object.values(r)[0])).filter(Boolean));
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

/** Soft delete — o índice único parcial da migration libera o CNPJ automaticamente. */
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
  const lista = await todos('interacao', 'lead_id', lead_id);
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
// Mesmo com dado permanente no Supabase, o export JSON continua útil: mover
// entre projetos Supabase, backup fora de banda, ou auditoria pontual.

// Contas (`profiles`) e auditoria ficam FORA de apagar/restaurar: são a identidade de quem está
// logado e estão amarradas ao Supabase Auth — apagar isso trancaria todo mundo para fora.
const LOJAS_DADOS = LOJAS.filter((l) => l !== 'profiles');

export async function exportarBackup() {
  const dump = { app: 'wattscout', versao: VERSAO_BACKUP, exportado_em: new Date().toISOString(), dados: {} };
  for (const loja of LOJAS) dump.dados[loja] = await todos(loja);
  return dump;
}

export async function importarBackup(dump, { substituir = false } = {}) {
  // aceita o marcador antigo: backups feitos antes do renome continuam restauráveis
  if (dump?.app !== 'wattscout' && dump?.app !== 'lex-prospecta') throw new Error('Arquivo não é um backup do WattScout.');
  const resumo = {};
  for (const loja of LOJAS_DADOS) {
    const registros = dump.dados?.[loja] || [];
    if (substituir) await limparLoja(loja);
    // normaliza leads antigos (inclusive de backups da era IndexedDB) para reconstruir os campos derivados
    const prep = loja === 'lead'
      ? registros.map((r) => { const { cnpj_ativo, ...resto } = r; return normalizarLead(resto); })
      : registros;
    resumo[loja] = await putMuitos(loja, prep);
  }
  _aliasIndex = null;
  return resumo;
}

export async function apagarTudo() {
  // ordem inversa das dependências: interação → lead → empresa… (FKs); contas ficam
  for (const loja of [...LOJAS_DADOS].reverse()) await limparLoja(loja);
  _aliasIndex = null;
}

/** Sobra do modo local — agora só reflete o que está em localStorage (pouco). Mantido pra não quebrar Config. */
export async function usoArmazenamento() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  const persistido = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  return { usage, quota, persistido };
}
