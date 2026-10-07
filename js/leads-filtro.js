// leads-filtro.js — as regras da lista de Leads, sem nada de DOM nem de banco.
//
// Três coisas moram aqui: (1) as VISÕES salvas (Hoje, Atrasados, Novos…), (2) os FILTROS
// combináveis (distribuidora, UF, status, dono, lista, faixas de potência/tentativas/datas…),
// e (3) a conversão entre esse estado e a URL (#/leads?conc=ENEL-SP&status=abordado,em_conversa),
// que é o que faz o Backlog e o Painel poderem linkar para a lista já filtrada.
// Fica em módulo próprio para ser testável com `node --test` sem navegador.

import { slug, digits } from './util.js';
import { STATUS_FILA } from './seed.js';

/** Valor especial de `conc`: lead cuja distribuidora não casou com nenhum código do cadastro. */
export const CONC_SEM_CODIGO = '__sem';

export const VIEWS = [
  { v: 'hoje', label: 'Hoje', dica: 'Próxima ação vence hoje ou antes' },
  { v: 'atrasados', label: 'Atrasados', dica: 'A próxima ação já venceu' },
  { v: 'novos', label: 'Novos', dica: 'Ainda não abordados' },
  { v: 'aguardando', label: 'Aguardando resposta', dica: 'Abordado, sem retorno' },
  { v: 'meus', label: 'Todos os meus', dica: 'Toda a sua carteira ativa' },
  { v: 'todos', label: 'Toda a equipe', dica: 'Só gestor', soGestor: true },
  { v: 'concluidos', label: 'Concluídos', dica: 'Ganho, perdido, sem contato ou descartado' },
  { v: 'devolvidos', label: 'Devolvidos à base', dica: 'Saíram da carteira; dá para restaurar' },
];
export const VIEW_PADRAO = 'hoje';

export const FILTROS_VAZIOS = Object.freeze({
  conc: '', uf: '', cidade: '', status: [], origem: '', tipo: '', dono: '', lista: '',
  tentMin: '', tentMax: '', potMin: '', potMax: '',
  comTel: false, comEmail: false, optOut: false,
  paDe: '', paAte: '', ucDe: '', ucAte: '', crDe: '', crAte: '',
});

export const novosFiltros = () => ({ ...FILTROS_VAZIOS, status: [] });

/* ── URL ⇄ estado ── */

// chave do estado → nome curto na URL
const CHAVES = {
  conc: 'conc', uf: 'uf', cidade: 'cidade', origem: 'origem', tipo: 'tipo', dono: 'dono', lista: 'lista',
  tentMin: 'tmin', tentMax: 'tmax', potMin: 'pmin', potMax: 'pmax',
  paDe: 'pa_de', paAte: 'pa_ate', ucDe: 'uc_de', ucAte: 'uc_ate', crDe: 'cr_de', crAte: 'cr_ate',
};
const BOOLS = { comTel: 'tel', comEmail: 'email', optOut: 'optout' };

/** `params` (objeto vindo do roteador) → { view, texto, filtros }. Aceita `f` antigo e `q` da busca global. */
export function lerParams(params = {}, { viewPadrao = VIEW_PADRAO } = {}) {
  const filtros = novosFiltros();
  for (const [k, nome] of Object.entries(CHAVES)) if (params[nome] != null) filtros[k] = String(params[nome]);
  for (const [k, nome] of Object.entries(BOOLS)) filtros[k] = params[nome] === '1' || params[nome] === 'true';
  if (params.status) filtros.status = String(params.status).split(',').map((x) => x.trim()).filter(Boolean);
  const viewValida = VIEWS.some((v) => v.v === params.f);
  return {
    view: viewValida ? params.f : (params.q || temFiltro(filtros) ? 'meus' : viewPadrao),
    texto: params.q || '',
    filtros,
  };
}

/** Estado → params para a URL; omite o que está vazio (URL curta e legível). */
export function paraParams({ view, texto, filtros }, { viewPadrao = VIEW_PADRAO } = {}) {
  const out = {};
  if (view && view !== viewPadrao) out.f = view;
  if (texto) out.q = texto;
  for (const [k, nome] of Object.entries(CHAVES)) if (filtros[k] !== '' && filtros[k] != null) out[nome] = filtros[k];
  for (const [k, nome] of Object.entries(BOOLS)) if (filtros[k]) out[nome] = '1';
  if (filtros.status?.length) out.status = filtros.status.join(',');
  return out;
}

export function temFiltro(filtros) {
  return Object.keys(FILTROS_VAZIOS).some((k) => {
    const v = filtros[k];
    return Array.isArray(v) ? v.length > 0 : (v !== '' && v != null && v !== false);
  });
}

/* ── regras ── */

const soDia = (v) => (v ? String(v).slice(0, 10) : '');
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** Potência do lead; cai para a soma das usinas da empresa quando o lead não tem a própria. */
export const potenciaDe = (l, empresas) => l.potencia_kwp ?? empresas?.get(l.cnpj)?.potencia_total_kw ?? null;

/** A visão (aba lateral) é um recorte pelo estado do lead e pelo dono. */
export function passaNaView(view, l, { perfilId, hoje }) {
  const removido = !!l.deleted_at;
  if (view === 'devolvidos') return removido;
  if (removido) return false;
  const doUsuario = l.owner_id === perfilId;
  const ativo = STATUS_FILA.includes(l.status);
  switch (view) {
    case 'hoje': return doUsuario && ativo && !!l.proxima_acao_em && l.proxima_acao_em <= hoje;
    case 'atrasados': return doUsuario && ativo && !!l.proxima_acao_em && l.proxima_acao_em < hoje;
    case 'novos': return doUsuario && l.status === 'a_abordar';
    case 'aguardando': return doUsuario && (l.status === 'abordado' || l.status === 'em_conversa');
    case 'concluidos': return !ativo;
    case 'todos': return true;
    case 'meus':
    default: return doUsuario;
  }
}

export function passaNosFiltros(l, f, { empresas, hoje } = {}) {
  if (f.conc === CONC_SEM_CODIGO) { if (l.concessionaria_codigo) return false; } else if (f.conc && l.concessionaria_codigo !== f.conc) return false;
  if (f.uf && l.uf !== f.uf) return false;
  if (f.cidade && !slug(l.cidade).includes(slug(f.cidade))) return false;
  if (f.status.length && !f.status.includes(l.status)) return false;
  if (f.origem && l.origem !== f.origem) return false;
  if (f.tipo && l.tipo !== f.tipo) return false;
  if (f.dono && l.owner_id !== f.dono) return false;
  if (f.lista === '__sem') { if (l.import_lote_id) return false; } else if (f.lista && l.import_lote_id !== f.lista) return false;

  const tent = l.tentativas || 0;
  const [tMin, tMax] = [num(f.tentMin), num(f.tentMax)];
  if (tMin != null && tent < tMin) return false;
  if (tMax != null && tent > tMax) return false;

  const [pMin, pMax] = [num(f.potMin), num(f.potMax)];
  if (pMin != null || pMax != null) {
    const p = potenciaDe(l, empresas);
    if (p == null) return false;
    if (pMin != null && p < pMin) return false;
    if (pMax != null && p > pMax) return false;
  }

  if (f.comTel && !(l.telefone || l.telefone2 || empresas?.get(l.cnpj)?.telefone1)) return false;
  if (f.comEmail && !(l.email || empresas?.get(l.cnpj)?.email)) return false;
  if (f.optOut && !l.opt_out) return false;

  const faixa = (valor, de, ate) => {
    if (!de && !ate) return true;
    if (!valor) return false;
    return (!de || valor >= de) && (!ate || valor <= ate);
  };
  if (!faixa(l.proxima_acao_em, f.paDe, f.paAte)) return false;
  if (!faixa(l.ultimo_contato_em, f.ucDe, f.ucAte)) return false;
  if (!faixa(soDia(l.created_at), f.crDe, f.crAte)) return false;
  void hoje;
  return true;
}

export function passaNoTexto(l, texto) {
  if (!texto) return true;
  const q = slug(texto);
  const qd = digits(texto);
  return slug(l.razao_social).includes(q)
    || slug(l.contato_nome).includes(q)
    || slug(l.cidade).includes(q)
    || slug(l.email).includes(q)
    || (qd.length >= 3 && ((l.cnpj || '').includes(qd) || (l.telefone || '').includes(qd)));
}

/** Aplica visão + filtros + texto. `ctx`: { perfilId, hoje, empresas? }. */
export function filtrarLeads(leads, { view, texto, filtros }, ctx) {
  return leads.filter((l) => passaNaView(view, l, ctx)
    && passaNosFiltros(l, filtros, ctx)
    && passaNoTexto(l, texto));
}

/** Contagem por visão em uma passada (os números das abas laterais). Respeita só a visão, não os filtros. */
export function contarViews(leads, ctx) {
  const out = Object.fromEntries(VIEWS.map((v) => [v.v, 0]));
  for (const l of leads) for (const v of VIEWS) if (passaNaView(v.v, l, ctx)) out[v.v]++;
  return out;
}

/** O filtro `potMin/potMax` só funciona direito com os dados da empresa — a tela carrega sob demanda. */
export const precisaDeEmpresas = (f) => f.potMin !== '' || f.potMax !== '' || f.comTel || f.comEmail;
