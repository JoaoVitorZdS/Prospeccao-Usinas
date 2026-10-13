// ajudas-supabase.mjs — um Supabase FALSO em memória, para testar o sincronizador (e qualquer coisa que use js/db.js)
// sem rede. Imita só o que o app usa do supabase-js, e imita o PostgREST no ponto que importa para a Base CNPJ:
//
//   UPSERT EM LOTE: o PostgREST monta a lista de colunas pela UNIÃO das chaves de todas as linhas do lote e, nas
//   linhas que não trazem uma delas, grava NULL — inclusive por cima do valor existente (ON CONFLICT DO UPDATE SET
//   coluna = EXCLUDED.coluna). Por isso o código nunca mistura, no mesmo lote, linhas novas (parciais) com linhas
//   que já existem (completas): ver `gruposParaGravar` em js/cnpj-importacao.js.

const PK = {
  usina_aneel: 'cod_empreendimento', empresa: 'cnpj', concessionaria: 'codigo', import_lote: 'id',
  supressao: 'id', backlog: 'concessionaria_codigo', lead: 'id', profiles: 'id',
};
// colunas NOT NULL DEFAULT do banco real: entram no INSERT quando o lote não as traz
const PADROES = { empresa: () => ({ qtd_usinas: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }) };

/**
 * @param usuarios  { 'email': { senha, perfil } }
 * @returns { instalar(), db, chamadas, limpar() }
 */
export function criarSupabaseFalso({ usuarios = {} } = {}) {
  const db = {
    usina_aneel: [], empresa: [], concessionaria: [], import_lote: [], supressao: [], backlog: [], lead: [], profiles: [],
  };
  const chamadas = []; // { tabela, op, linhas } — para conferir como as gravações foram feitas
  let usuario = null;

  // índice chave → linha, para o upsert não varrer a tabela inteira a cada linha (390 mil usinas ficariam quadráticas).
  // Se a tabela mudou por fora (limpar(), teste mexendo em db.x direto), o tamanho diverge e o índice é refeito.
  const indices = new Map();
  function indicePorChave(tabela, linhas, pk) {
    let i = indices.get(tabela);
    if (!i || i.size !== linhas.length) {
      i = new Map(linhas.map((r) => [r[pk], r]));
      indices.set(tabela, i);
    }
    return i;
  }

  function consulta(tabela) {
    if (!db[tabela]) return { then: (ok) => Promise.resolve({ data: null, error: { message: `tabela desconhecida: ${tabela}` } }).then(ok) };
    const q = { filtros: [], ordem: null, de: 0, ate: Infinity, colunas: '*', op: 'select', carga: null, contar: false, cabeca: false, unico: false, retornar: false };
    const api = {
      select(colunas = '*', opcoes = {}) { q.colunas = colunas; q.contar = !!opcoes.count; q.cabeca = !!opcoes.head; q.retornar = true; return api; },
      eq(c, v) { q.filtros.push((r) => r[c] === v); return api; },
      in(c, vs) { q.filtros.push((r) => vs.includes(r[c])); return api; },
      gt(c, v) { q.filtros.push((r) => Number(r[c]) > v); return api; },
      not(c, op, v) { if (op === 'is' && v === null) q.filtros.push((r) => r[c] != null); return api; },
      order(c) { q.ordem = c; return api; },
      range(a, b) { q.de = a; q.ate = b; return api; },
      limit(n) { q.ate = q.de + n - 1; return api; },
      maybeSingle() { q.unico = true; return api; },
      upsert(linhas) { q.op = 'upsert'; q.carga = [].concat(linhas); q.retornar = false; return api; },
      then(ok, ko) { return Promise.resolve(executar()).then(ok, ko); },
    };

    function executar() {
      const linhas = db[tabela];
      if (q.op === 'upsert') {
        chamadas.push({ tabela, op: 'upsert', linhas: q.carga });
        const pk = PK[tabela];
        const colunas = [...new Set(q.carga.flatMap((l) => Object.keys(l)))]; // a UNIÃO do lote
        const chaves = q.carga.map((l) => l[pk]);
        if (new Set(chaves).size !== chaves.length) {
          return { data: null, error: { message: 'ON CONFLICT DO UPDATE command cannot affect row a second time', code: '21000' } };
        }
        const gravadas = [];
        const porChave = indicePorChave(tabela, linhas, pk);
        for (const l of q.carga) {
          const atual = porChave.get(l[pk]);
          if (atual) {
            for (const c of colunas) atual[c] = l[c] ?? null; // ← ausente vira NULL por cima do que existia
            gravadas.push(atual);
          } else {
            const nova = { ...(PADROES[tabela]?.() || {}) };
            for (const c of colunas) nova[c] = l[c] ?? null;
            linhas.push(nova);
            porChave.set(l[pk], nova);
            gravadas.push(nova);
          }
        }
        return { data: q.unico ? (gravadas[0] ?? null) : gravadas, error: null };
      }
      let r = linhas.filter((x) => q.filtros.every((f) => f(x)));
      if (q.ordem) r = [...r].sort((a, b) => (a[q.ordem] < b[q.ordem] ? -1 : a[q.ordem] > b[q.ordem] ? 1 : 0));
      const total = r.length;
      r = r.slice(q.de, q.ate === Infinity ? undefined : q.ate + 1);
      if (q.colunas !== '*') {
        const cols = q.colunas.split(',').map((c) => c.trim());
        r = r.map((x) => Object.fromEntries(cols.map((c) => [c, x[c]])));
      }
      if (q.cabeca) return { data: null, count: total, error: null };
      return { data: q.unico ? (r[0] ?? null) : r.map((x) => ({ ...x })), error: null };
    }
    return api;
  }

  const rpcs = {
    reivindicar_perfil: () => usuario?.perfil ?? null,
    distribuidoras_sem_codigo: () => {
      const cont = new Map();
      for (const u of db.usina_aneel) if (!u.concessionaria_codigo && u.distribuidora_nome) cont.set(u.distribuidora_nome, (cont.get(u.distribuidora_nome) || 0) + 1);
      return [...cont].map(([nome, qtd]) => ({ nome, qtd }));
    },
    recasar_usinas: ({ p_nome, p_codigo, p_limite }) => {
      let n = 0;
      for (const u of db.usina_aneel) {
        if (n >= p_limite) break;
        if (!u.concessionaria_codigo && u.distribuidora_nome === p_nome) { u.concessionaria_codigo = p_codigo; n++; }
      }
      return n;
    },
  };

  const cliente = {
    from: consulta,
    rpc: async (nome, args = {}) => (rpcs[nome] ? { data: rpcs[nome](args), error: null } : { data: null, error: { message: `rpc desconhecida: ${nome}` } }),
    auth: {
      signInWithPassword: async ({ email, password }) => {
        const u = usuarios[email];
        if (!u || u.senha !== password) return { data: null, error: { message: 'Invalid login credentials', code: 'invalid_credentials', status: 400 } };
        usuario = u;
        return { data: { user: { email } }, error: null };
      },
    },
  };

  return {
    db, chamadas, cliente,
    /** Faz `abrir()` de js/db.js (fora do navegador) devolver este cliente. */
    instalar() { globalThis.supabase = { createClient: () => cliente }; },
    limpar() { for (const k of Object.keys(db)) db[k].length = 0; chamadas.length = 0; usuario = null; },
  };
}
