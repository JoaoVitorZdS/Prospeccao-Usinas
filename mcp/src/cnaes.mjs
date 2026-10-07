// cnaes.mjs — presets de CNAE para prospecção no setor de energia.
//
// Códigos conferidos na tabela OFICIAL Cnaes.zip da Receita (competência 2026-09). Atenção:
// NÃO existe CNAE específico de energia solar. Usinas solares se registram em "Geração de energia
// elétrica" (3511-5/01) — mas o dono de uma usina de GD costuma ser uma empresa de qualquer outro
// ramo (agro, comércio, indústria), que só aparece pela base da ANEEL. Por isso o filtro por CNAE
// serve para achar geradoras, comercializadoras e integradores; os donos de usina vêm do app
// (Prospecção) e podem ser enriquecidos aqui com `cnpjs_arquivo`.

export const PRESETS = {
  geracao: {
    descricao: 'Geração de energia elétrica (onde se registram as usinas solares/PCHs/eólicas empresariais)',
    cnaes: ['3511500', '3511501'],
  },
  comercializacao: {
    descricao: 'Comércio atacadista de energia elétrica (comercializadoras)',
    cnaes: ['3513100'],
  },
  instalacao: {
    descricao: 'Instalação e manutenção elétrica, redes de distribuição (integradores e EPCs)',
    cnaes: ['4321500', '4221902', '4221903'],
  },
  material: {
    descricao: 'Comércio de material elétrico (atacado e varejo)',
    cnaes: ['4673700', '4742300'],
  },
  rede: {
    descricao: 'Transmissão e distribuição de energia elétrica (concessionárias)',
    cnaes: ['3512300', '3514000'],
  },
};

/**
 * Expande uma lista mista (presets, códigos de 7 dígitos, códigos formatados "3511-5/01" e prefixos
 * de 2 a 6 dígitos) em { exatos: Set, prefixos: Set }. Nome desconhecido vira erro claro.
 */
export function resolverCnaes(entradas) {
  const exatos = new Set();
  const prefixos = new Set();
  for (const bruto of [].concat(entradas ?? [])) {
    const texto = String(bruto).trim();
    if (!texto) continue;
    const preset = PRESETS[texto.toLowerCase()];
    if (preset) { preset.cnaes.forEach((c) => exatos.add(c)); continue; }
    const digitos = texto.replace(/\D/g, '');
    const soNumero = /^[\d\-./\s]+$/.test(texto); // "3511501", "3511-5/01", "3511"
    if (soNumero && digitos.length === 7) exatos.add(digitos);
    else if (soNumero && digitos.length >= 2 && digitos.length <= 6) prefixos.add(digitos);
    else throw new Error(`CNAE inválido: "${texto}". Use código de 7 dígitos, prefixo (ex.: 3511) ou um preset: ${Object.keys(PRESETS).join(', ')}.`);
  }
  return { exatos, prefixos };
}

export const descricaoDosPresets = () => Object.entries(PRESETS)
  .map(([nome, p]) => ({ nome, descricao: p.descricao, cnaes: p.cnaes }));

/** "3511501" → "3511-5/01" (formato legível usado no CSV exportado). */
export const formatarCnae = (c) => (/^\d{7}$/.test(String(c ?? '')) ? `${c.slice(0, 4)}-${c.slice(4, 5)}/${c.slice(5)}` : (c ?? ''));
