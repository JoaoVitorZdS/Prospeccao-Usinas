// enriquecer.js — telefone e e-mail a partir do CNPJ.
//
// O plano marca o OpenCNPJ como risco alto: mantido pela comunidade, sem SLA,
// ponto único de falha (seção 2.3). Por isso isto aqui é um ADAPTADOR com cadeia
// de fallback e `fonte_enriquecimento` gravada por registro — não uma chamada
// solta ao OpenCNPJ. Trocar de provedor é acrescentar um objeto em `PROVEDORES`.
//
// Roda no browser porque as duas fontes gratuitas mandam CORS permissivo. Se um dia
// entrar CNPJá ou Casa dos Dados (que exigem chave), a chamada muda de lugar — vai
// para um proxy server-side, e só o `buscar` do provedor precisa mudar.
//
// Ressalva de qualidade que vale repetir: o e-mail da base da Receita é
// majoritariamente contábil/fiscal, não do decisor. É canal secundário.

import { normCnpj, normFone, normEmail, parseNum, parseData, dorme } from './util.js';
import { get, put, todos, upsertEmpresa, carregarSupressao, percorrer, contar, buscarTop } from './db.js';

/* ═══════════════ Provedores ═══════════════ */

const primeiroFone = (lista) => {
  for (const t of lista || []) {
    if (typeof t === 'string') { const f = normFone(t); if (f) return f; }
    else if (t && typeof t === 'object') {
      if (t.is_fax || t.tipo === 'fax') continue;
      const f = normFone(`${t.ddd || ''}${t.numero || t.telefone || ''}`);
      if (f) return f;
    }
  }
  return null;
};

const socios = (qsa) => (qsa || []).slice(0, 12).map((s) => ({
  nome: s.nome_socio || s.nome || s.nome_representante_legal || null,
  qualificacao: s.qualificacao_socio || s.qual || s.qualificacao || null,
  desde: s.data_entrada_sociedade || s.data_entrada || null,
})).filter((s) => s.nome);

export const PROVEDORES = [
  {
    id: 'opencnpj',
    nome: 'OpenCNPJ',
    temEmail: true,
    intervalo: 700,          // ~85/min; o teto medido foi ~100/min
    url: (c) => `https://api.opencnpj.org/${c}`,
    mapear(d) {
      const tels = d.telefones || d.telefone || [];
      const fones = Array.isArray(tels) ? tels : [tels];
      const norm = fones.map((t) => (typeof t === 'object'
        ? normFone(`${t.ddd || ''}${t.numero || ''}`) : normFone(t))).filter(Boolean);
      return {
        razao_social: d.razao_social || d.nome || null,
        nome_fantasia: d.nome_fantasia || null,
        situacao_cadastral: d.situacao_cadastral || d.descricao_situacao_cadastral || null,
        cnae_principal: d.cnae_principal || d.cnae_fiscal || null,
        cnae_descricao: d.cnae_principal_descricao || d.cnae_fiscal_descricao || null,
        natureza_juridica: d.natureza_juridica || null,
        capital_social: parseNum(d.capital_social),
        porte: d.porte_empresa || d.porte || null,
        data_abertura: parseData(d.data_inicio_atividade || d.data_abertura),
        telefone1: norm[0] || primeiroFone(fones) || null,
        telefone2: norm[1] || null,
        email: normEmail(d.email),
        cep: d.cep || null,
        municipio: d.municipio || null,
        uf: d.uf || null,
        logradouro: [d.logradouro, d.numero, d.bairro].filter(Boolean).join(', ') || null,
        socios: socios(d.QSA || d.qsa || d.socios),
      };
    },
  },
  {
    id: 'brasilapi',
    nome: 'BrasilAPI',
    temEmail: false,         // vem null; serve de fallback de dado cadastral
    intervalo: 1500,
    url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`,
    mapear(d) {
      return {
        razao_social: d.razao_social || null,
        nome_fantasia: d.nome_fantasia || null,
        situacao_cadastral: d.descricao_situacao_cadastral || null,
        cnae_principal: d.cnae_fiscal ? String(d.cnae_fiscal) : null,
        cnae_descricao: d.cnae_fiscal_descricao || null,
        natureza_juridica: d.natureza_juridica || null,
        capital_social: parseNum(d.capital_social),
        porte: d.porte || d.descricao_porte || null,
        data_abertura: parseData(d.data_inicio_atividade),
        telefone1: normFone(d.ddd_telefone_1),
        telefone2: normFone(d.ddd_telefone_2),
        email: normEmail(d.email),
        cep: d.cep ? String(d.cep) : null,
        municipio: d.municipio || null,
        uf: d.uf || null,
        logradouro: [d.logradouro, d.numero, d.bairro].filter(Boolean).join(', ') || null,
        socios: socios(d.qsa),
      };
    },
  },
];

/* ═══════════════ Chamada com backoff ═══════════════ */

const ultimaChamada = new Map();

async function chamarProvedor(prov, cnpj, sinal) {
  const espera = (ultimaChamada.get(prov.id) || 0) + prov.intervalo - Date.now();
  if (espera > 0) await dorme(espera);
  ultimaChamada.set(prov.id, Date.now());

  let tentativa = 0;
  for (;;) {
    let resp;
    try {
      resp = await fetch(prov.url(cnpj), { headers: { accept: 'application/json' }, signal: sinal });
    } catch (e) {
      if (sinal?.aborted) throw e;
      if (++tentativa > 2) throw new Error('rede indisponível');
      await dorme(1200 * tentativa);
      continue;
    }
    if (resp.status === 404) return { ausente: true };
    if (resp.status === 429 || resp.status >= 500) {
      if (++tentativa > 3) throw new Error(`HTTP ${resp.status}`);
      const retry = Number(resp.headers.get('retry-after')) || 0;
      await dorme(Math.max(retry * 1000, 1500 * tentativa));
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return { dados: prov.mapear(await resp.json()) };
  }
}

/**
 * Enriquece um CNPJ percorrendo a cadeia de provedores até obter telefone.
 * Devolve sempre `fonte_enriquecimento` — é a procedência exigida pela LGPD (seção 9).
 */
export async function enriquecerCnpj(cnpjBruto, { provedores = PROVEDORES, sinal } = {}) {
  const cnpj = normCnpj(cnpjBruto);
  if (!cnpj) return { cnpj: cnpjBruto, erro: 'CNPJ inválido' };

  let melhor = null;
  const erros = [];
  for (const prov of provedores) {
    try {
      const r = await chamarProvedor(prov, cnpj, sinal);
      if (r.ausente) { erros.push(`${prov.nome}: não encontrado`); continue; }
      const d = r.dados;
      if (!melhor) melhor = { ...d, fonte_enriquecimento: prov.id };
      else {
        // completa buracos sem sobrescrever o que já veio de fonte melhor
        for (const [k, v] of Object.entries(d)) {
          if ((melhor[k] == null || melhor[k] === '' || (Array.isArray(melhor[k]) && !melhor[k].length)) && v != null) {
            melhor[k] = v;
          }
        }
        melhor.fonte_enriquecimento += `+${prov.id}`;
      }
      if (melhor.telefone1 && (melhor.email || !prov.temEmail)) break;
    } catch (e) {
      if (sinal?.aborted) throw e;
      erros.push(`${prov.nome}: ${e.message}`);
    }
  }

  if (!melhor) return { cnpj, erro: erros.join(' · ') || 'sem resposta' };
  return { cnpj, ...melhor, erro: erros.length ? erros.join(' · ') : null };
}

/* ═══════════════ Fila de enriquecimento ═══════════════ */

/** CNPJs de `empresa` ainda sem enriquecimento, ou com erro anterior. */
export async function filaEnriquecimento({ limite = 200, reprocessarErro = false } = {}) {
  const pendentes = [];
  await percorrer('empresa', null, null, (e) => {
    if (pendentes.length >= limite) return false;
    if (!e.enriquecido_em) pendentes.push(e.cnpj);
    else if (reprocessarErro && e.enriquecimento_erro && !e.telefone1) pendentes.push(e.cnpj);
  });
  return pendentes;
}

/**
 * Processa a fila em série, respeitando o rate limit e a lista de supressão.
 * `onProgresso({feito, total, cnpj, ok})` alimenta a barra de progresso.
 */
export async function processarFila(cnpjs, { onProgresso, sinal } = {}) {
  const supressao = await carregarSupressao();
  const resumo = { total: cnpjs.length, ok: 0, comTelefone: 0, comEmail: 0, erros: 0, suprimidos: 0 };

  for (let i = 0; i < cnpjs.length; i++) {
    if (sinal?.aborted) break;
    const cnpj = cnpjs[i];

    if (supressao.testar({ cnpj })) {
      resumo.suprimidos++;
      onProgresso?.({ feito: i + 1, total: cnpjs.length, cnpj, ok: false, suprimido: true });
      continue;
    }

    let r;
    try {
      r = await enriquecerCnpj(cnpj, { sinal });
    } catch (e) {
      if (sinal?.aborted) break;
      r = { cnpj, erro: e.message };
    }

    const atual = (await get('empresa', cnpj)) || { cnpj };
    const patch = {
      ...atual,
      enriquecido_em: new Date().toISOString(),
      enriquecimento_erro: r.erro || null,
      fonte_enriquecimento: r.fonte_enriquecimento || atual.fonte_enriquecimento || null,
    };
    for (const k of ['razao_social', 'nome_fantasia', 'situacao_cadastral', 'cnae_principal',
      'cnae_descricao', 'natureza_juridica', 'capital_social', 'porte', 'data_abertura',
      'telefone1', 'telefone2', 'email', 'socios', 'logradouro']) {
      if (r[k] != null && r[k] !== '') patch[k] = r[k];
    }
    // CEP/cidade/UF da ANEEL têm prioridade: são do local da usina, não da matriz
    if (!patch.cep && r.cep) patch.cep = r.cep;
    if (!patch.municipio_principal && r.municipio) patch.municipio_principal = r.municipio;
    if (!patch.uf_principal && r.uf) patch.uf_principal = r.uf;

    // e-mail suprimido não entra na base
    if (patch.email && supressao.testar({ email: patch.email })) patch.email = null;
    if (patch.telefone1 && supressao.testar({ telefone: patch.telefone1 })) patch.telefone1 = null;

    await upsertEmpresa(patch);

    if (r.erro && !patch.telefone1) resumo.erros++; else resumo.ok++;
    if (patch.telefone1) resumo.comTelefone++;
    if (patch.email) resumo.comEmail++;
    onProgresso?.({ feito: i + 1, total: cnpjs.length, cnpj, ok: !!patch.telefone1, resumo });
  }
  return resumo;
}

/**
 * Taxa de preenchimento — é o número que decide se vale contratar fonte paga
 * (critério de verificação da fase 2 no plano).
 *
 * Antes buscava `todos('empresa')` — a tabela inteira — só pra contar. Numa
 * base de centenas de milhares de linhas isso sozinho já eram centenas de
 * requisições. `contar()` com filtro faz o Postgres contar, sem trazer as
 * linhas pro navegador; só o "por fonte" (que precisa dos valores, não só a
 * contagem) usa uma amostra limitada em vez da tabela inteira — é uma
 * estimativa diagnóstica ("qual fonte tá sendo mais usada"), não precisa ser
 * exaustiva.
 */
export async function taxaPreenchimento() {
  const [totalEmpresas, enriquecidasN, comTel, comMail] = await Promise.all([
    contar('empresa'),
    contar('empresa', (q) => q.not('enriquecido_em', 'is', null)),
    contar('empresa', (q) => q.not('enriquecido_em', 'is', null).not('telefone1', 'is', null)),
    contar('empresa', (q) => q.not('enriquecido_em', 'is', null).not('email', 'is', null)),
  ]);

  const amostra = await buscarTop('empresa', {
    colunas: 'fonte_enriquecimento',
    ordenarPor: 'enriquecido_em',
    limite: 3000,
    filtro: (q) => q.not('enriquecido_em', 'is', null),
  });
  const porFonte = {};
  for (const e of amostra) {
    const f = e.fonte_enriquecimento || 'desconhecida';
    porFonte[f] = (porFonte[f] || 0) + 1;
  }

  return {
    empresas: totalEmpresas,
    enriquecidas: enriquecidasN,
    pendentes: totalEmpresas - enriquecidasN,
    comTelefone: comTel,
    comEmail: comMail,
    pctTelefone: enriquecidasN ? comTel / enriquecidasN : 0,
    pctEmail: enriquecidasN ? comMail / enriquecidasN : 0,
    porFonte,
    porFonteAmostra: amostra.length < enriquecidasN,
  };
}
