// consulta.mjs — traduz os filtros do MCP em SQL PARAMETRIZADO sobre a base local.
//
// Nenhum valor de filtro é concatenado no SQL: tudo vai em parâmetros (`?`). Os nomes de coluna e a
// ordenação vêm de listas fixas. A mesma função monta a contagem, a página de resultados e a
// exportação, então o que `cnpj_contar` anuncia é exatamente o que `cnpj_exportar` grava.

import { resolverCnaes } from './cnaes.mjs';
import { normalizarBusca } from './banco.mjs';

export const SITUACOES = { '01': 'Nula', '02': 'Ativa', '03': 'Suspensa', '04': 'Inapta', '08': 'Baixada' };
const SITUACAO_POR_NOME = { nula: '01', ativa: '02', suspensa: '03', inapta: '04', baixada: '08' };
const PORTES = {
  micro: 'Microempresa', microempresa: 'Microempresa', '02': 'Microempresa',
  epp: 'Empresa de pequeno porte', 'pequeno porte': 'Empresa de pequeno porte', '03': 'Empresa de pequeno porte',
  demais: 'Demais', '05': 'Demais', 'nao informado': 'Não informado', '01': 'Não informado', '00': 'Não informado',
};
const ORDENACAO = {
  capital: 'm.capital_social', abertura: 'e.abertura', razao: 'm.razao_social', cnpj: 'e.cnpj', municipio: 'mu.nome',
};

const lista = (v) => [].concat(v ?? []).map((x) => String(x).trim()).filter(Boolean);
const iso = (v, nome) => {
  if (v == null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error(`${nome} deve estar no formato AAAA-MM-DD (recebi "${v}").`);
  return String(v);
};
const num = (v, nome) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${nome} deve ser um número (recebi "${v}").`);
  return n;
};
const marcadores = (n) => Array.from({ length: n }, () => '?').join(', ');
/** Escapa % e _ para uso em LIKE ... ESCAPE '\'. */
const paraLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Valida e normaliza os filtros de entrada (aceita o que o MCP/zod entrega, ou objetos escritos à mão). */
export function normalizarFiltros(f = {}) {
  const situacao = lista(f.situacao).map((s) => SITUACAO_POR_NOME[s.toLowerCase()] ?? s.padStart(2, '0'));
  for (const s of situacao) if (!SITUACOES[s]) throw new Error(`Situação inválida: "${s}". Use ${Object.values(SITUACOES).join(', ')} (ou os códigos 01, 02, 03, 04, 08).`);
  const porte = lista(f.porte).map((p) => {
    const nome = PORTES[p.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')];
    if (!nome) throw new Error(`Porte inválido: "${p}". Use micro, epp, demais ou "nao informado".`);
    return nome;
  });
  const cnae = lista(f.cnae);
  return {
    cnae, cnaeModo: f.cnae_modo === 'principal' ? 'principal' : 'qualquer',
    uf: lista(f.uf).map((u) => u.toUpperCase()),
    municipio: f.municipio ? normalizarBusca(f.municipio) : null,
    porte,
    natureza: lista(f.natureza),
    capitalMin: num(f.capital_min, 'capital_min'), capitalMax: num(f.capital_max, 'capital_max'),
    aberturaDe: iso(f.abertura_de, 'abertura_de'), aberturaAte: iso(f.abertura_ate, 'abertura_ate'),
    matriz: f.matriz == null ? null : !!f.matriz,
    comTelefone: !!f.com_telefone, comEmail: !!f.com_email,
    texto: f.texto ? normalizarBusca(f.texto) : null,
    situacao: situacao.length ? [...new Set(situacao)] : ['02'],
    incluirEI: !!f.incluir_empresario_individual,
    cnpjs: f.cnpjs ? lista(f.cnpjs).map((c) => c.replace(/\D/g, '')).filter((c) => c.length === 14 || c.length === 8) : null,
    listaTemporaria: !!f.listaTemporaria,
    ordenarPor: ORDENACAO[f.ordenar_por] ? f.ordenar_por : 'capital',
    ordem: f.ordem === 'asc' ? 'asc' : 'desc',
  };
}

const FROM = `from estabelecimento e
  join empresa m on m.cnpj_basico = e.cnpj_basico
  left join cnae c on c.codigo = e.cnae_principal
  left join municipio mu on mu.codigo = e.municipio_codigo
  left join natureza n on n.codigo = m.natureza_codigo`;

/** WHERE + parâmetros (sem o FROM). `f` já normalizado. */
export function montarFiltro(f) {
  const where = [];
  const p = [];

  where.push(`e.situacao in (${marcadores(f.situacao.length)})`);
  p.push(...f.situacao);

  if (f.cnae.length) {
    const { exatos, prefixos } = resolverCnaes(f.cnae);
    const partes = [];
    const col = f.cnaeModo === 'principal' ? 'e.cnae_principal' : 'x.cnae';
    const cond = [];
    const pc = [];
    if (exatos.size) { cond.push(`${col} in (${marcadores(exatos.size)})`); pc.push(...exatos); }
    for (const pre of prefixos) { cond.push(`${col} like ?`); pc.push(`${pre}%`); }
    partes.push(cond.join(' or '));
    if (f.cnaeModo === 'principal') where.push(`(${partes[0]})`);
    else where.push(`exists (select 1 from estab_cnae x where x.cnpj = e.cnpj and (${partes[0]}))`);
    p.push(...pc);
  }
  if (f.uf.length) { where.push(`e.uf in (${marcadores(f.uf.length)})`); p.push(...f.uf); }
  if (f.municipio) { where.push('mu.busca like ? escape \'\\\''); p.push(`%${paraLike(f.municipio)}%`); }
  if (f.porte.length) { where.push(`m.porte in (${marcadores(f.porte.length)})`); p.push(...f.porte); }
  if (f.natureza.length) { where.push(`m.natureza_codigo in (${marcadores(f.natureza.length)})`); p.push(...f.natureza); }
  if (f.capitalMin != null) { where.push('m.capital_social >= ?'); p.push(f.capitalMin); }
  if (f.capitalMax != null) { where.push('m.capital_social <= ?'); p.push(f.capitalMax); }
  if (f.aberturaDe) { where.push('e.abertura >= ?'); p.push(f.aberturaDe); }
  if (f.aberturaAte) { where.push('e.abertura <= ?'); p.push(f.aberturaAte); }
  if (f.matriz != null) { where.push('e.matriz = ?'); p.push(f.matriz ? 1 : 0); }
  if (f.comTelefone) where.push('(e.telefone1 is not null or e.telefone2 is not null)');
  if (f.comEmail) where.push('e.email is not null');
  if (f.texto) {
    where.push('(m.razao_social like ? escape \'\\\' or upper(coalesce(e.nome_fantasia, \'\')) like ? escape \'\\\')');
    const t = `%${paraLike(f.texto)}%`;
    p.push(t, t);
  }
  if (!f.incluirEI) where.push("m.natureza_codigo <> '2135'");
  if (f.listaTemporaria) {
    where.push('(e.cnpj in (select cnpj from lista_cnpj) or e.cnpj_basico in (select cnpj from lista_cnpj))');
  } else if (f.cnpjs?.length) {
    where.push(`(e.cnpj in (${marcadores(f.cnpjs.length)}) or e.cnpj_basico in (${marcadores(f.cnpjs.length)}))`);
    p.push(...f.cnpjs, ...f.cnpjs);
  }
  return { where: where.join('\n  and '), params: p };
}

const COLUNAS = `e.cnpj, e.cnpj_basico, e.matriz, e.nome_fantasia, e.situacao, e.data_situacao, e.abertura,
  e.cnae_principal, c.descricao as cnae_descricao, e.cnaes_secundarios,
  e.logradouro, e.numero, e.complemento, e.bairro, e.cep, e.uf, e.municipio_codigo, mu.nome as municipio,
  e.telefone1, e.telefone2, e.email,
  m.razao_social, m.natureza_codigo, n.descricao as natureza, m.porte, m.capital_social`;

export function montarContagem(filtros) {
  const f = normalizarFiltros(filtros);
  const { where, params } = montarFiltro(f);
  return { sql: `select count(*) as n ${FROM}\nwhere ${where}`, params };
}

export function montarSelecao(filtros, { limite = 50, deslocamento = 0 } = {}) {
  const f = normalizarFiltros(filtros);
  const { where, params } = montarFiltro(f);
  const lim = Math.max(1, Math.min(Number(limite) || 50, 1000000));
  const off = Math.max(0, Number(deslocamento) || 0);
  const ord = `${ORDENACAO[f.ordenarPor]} ${f.ordem} nulls last, e.cnpj`;
  return {
    sql: `select ${COLUNAS}\n${FROM}\nwhere ${where}\norder by ${ord}\nlimit ${lim} offset ${off}`,
    params,
  };
}

export function contar(db, filtros) {
  const { sql, params } = montarContagem(filtros);
  return db.prepare(sql).get(...params).n;
}

export function buscar(db, filtros, opcoes) {
  const { sql, params } = montarSelecao(filtros, opcoes);
  return db.prepare(sql).all(...params);
}

/** Itera TODOS os resultados em páginas (para exportar sem montar tudo na memória). */
export function* percorrer(db, filtros, { limiteTotal = Infinity, tamanhoPagina = 5000 } = {}) {
  let emitidos = 0;
  for (let off = 0; emitidos < limiteTotal; off += tamanhoPagina) {
    const pagina = buscar(db, filtros, { limite: Math.min(tamanhoPagina, limiteTotal - emitidos), deslocamento: off });
    for (const linha of pagina) { yield linha; emitidos++; }
    if (pagina.length < tamanhoPagina) return;
  }
}

export function detalhe(db, cnpj, { incluirSocios = true } = {}) {
  const c = String(cnpj).replace(/\D/g, '');
  if (c.length !== 14) throw new Error('Informe o CNPJ completo (14 dígitos).');
  const linha = db.prepare(`select ${COLUNAS}\n${FROM}\nwhere e.cnpj = ?`).get(c);
  if (!linha) return null;
  const secundarios = db.prepare(`select x.cnae, k.descricao from estab_cnae x left join cnae k on k.codigo = x.cnae
    where x.cnpj = ? and x.principal = 0 order by x.cnae`).all(c);
  const socios = incluirSocios
    ? db.prepare(`select s.tipo, s.nome, q.descricao as qualificacao, s.entrada, s.faixa_etaria from socio s
        left join qualificacao q on q.codigo = s.qualificacao_codigo where s.cnpj_basico = ? order by s.entrada, s.nome`).all(linha.cnpj_basico)
    : undefined;
  return { ...linha, cnaes_secundarios_detalhe: secundarios, socios };
}

export function buscarCnae(db, texto, limite = 20) {
  const t = `%${paraLike(normalizarBusca(texto))}%`;
  const dig = String(texto).replace(/\D/g, '');
  // `busca` é a descrição já normalizada (sem acento, maiúscula) na carga — busca por texto sem depender de collation
  return db.prepare(`select codigo, descricao from cnae
    where codigo like ? or busca like ? escape '\\'
    order by codigo limit ?`).all(`${dig || '__nada__'}%`, t, Math.min(Number(limite) || 20, 100));
}

export function buscarMunicipio(db, texto, uf, limite = 20) {
  const t = `%${paraLike(normalizarBusca(texto))}%`;
  const base = 'select mu.codigo, mu.nome from municipio mu where mu.busca like ? escape \'\\\'';
  const linhas = db.prepare(`${base} order by mu.nome limit ?`).all(t, Math.min(Number(limite) || 20, 100));
  if (!uf) return linhas;
  // restringe aos municípios que têm estabelecimento naquela UF na base carregada
  const doUf = new Set(db.prepare('select distinct municipio_codigo from estabelecimento where uf = ?').all(String(uf).toUpperCase()).map((r) => r.municipio_codigo));
  return linhas.filter((m) => doUf.has(m.codigo));
}
