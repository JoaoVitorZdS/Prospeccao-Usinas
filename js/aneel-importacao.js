// aneel-importacao.js — da linha bruta da ANEEL (GD ou SIGA) ao registro de `usina_aneel`.
//
// Mora aqui, e não dentro da tela de Importar, porque duas coisas precisam do MESMO critério: a tela (arquivo
// arrastado no navegador) e o comando `pnpm sincronizar` (arquivo baixado no Node). Sem dependência de DOM nem
// de banco: `casarConcessionaria` entra por parâmetro, então o módulo roda em qualquer lugar e é testável.

import { normCnpj, slug, parseData, parseNum } from './util.js';
import { extrairProprietariosSiga, splitMunicipioUF } from './aneel.js';

const digitsLen = (v) => String(v).replace(/\D/g, '').length;

/**
 * O SIGA não tem coluna de CNPJ — o(s) dono(s) vêm em texto livre na coluna
 * `proprietario_regime` (`extrairProprietariosSiga`, validado contra as
 * 25.264 linhas reais do dump). Uma usina em coparticipação gera MAIS DE UM
 * item aqui — um por dono — porque o modelo de dados é "um lead por CNPJ",
 * não "um lead por usina" (seção 5.1 do plano).
 */
export function proprietariosDaLinha(b) {
  const docBruto = String(b.cnpj || '');
  if (docBruto && !/\*/.test(docBruto)) {
    const cnpj = normCnpj(docBruto);
    if (cnpj) return [{ cnpj, titular: (b.titular || '').trim() || null, regime: null }];
  }
  if (b.proprietario_regime) {
    return extrairProprietariosSiga(b.proprietario_regime)
      .map((p) => ({ cnpj: p.cnpj, titular: p.nome, regime: p.regime }));
  }
  return [];
}

export async function analisarAneel(brutos, { casarConcessionaria }) {
  const itens = [];
  const vistos = new Set();
  for (const b of brutos) {
    const tipoCons = (b.tipo_consumidor || '').trim().toUpperCase();
    const docBruto = String(b.cnpj || '');
    const mascarado = /\*/.test(docBruto);

    // Recorte PJ, sempre. PF vem mascarado pela ANEEL e não se reidentifica (seção 9).
    // Só se aplica quando existe coluna de tipo_consumidor (GD) — o SIGA não tem PF.
    if (mascarado || tipoCons === 'PF' || (docBruto && digitsLen(docBruto) === 11)) {
      itens.push({ _linha: b._linha, bruto: b, erros: [], veredito: 'pf', detalhe: 'titular PF — fora do recorte, por desenho' });
      continue;
    }

    const donos = proprietariosDaLinha(b);
    if (!donos.length) {
      itens.push({
        _linha: b._linha, bruto: b, erros: ['CNPJ ausente ou ilegível'], veredito: 'sem_id',
      });
      continue;
    }

    // O SIGA traz `DscMuninicpios` como "Cidade - UF" MESMO quando também existe
    // uma coluna de UF separada (`SigUFPrincipal`) — sem isso o texto duplica
    // ("Nova Lima - MG/MG" na tela). Por isso o split roda sempre que o texto
    // parece combinado, não só quando falta a coluna de UF.
    const municipioTexto = (b.municipio || '').trim();
    const combinado = /-\s*[A-Za-z]{2}$/.test(municipioTexto) ? splitMunicipioUF(municipioTexto) : null;

    for (let i = 0; i < donos.length; i++) {
      const dono = donos[i];
      const item = { _linha: b._linha, bruto: b, erros: [] };
      const cod = (b.cod_empreendimento || '').trim()
        ? `${b.cod_empreendimento.trim()}${donos.length > 1 ? `-${i + 1}` : ''}`
        : `${dono.cnpj}-${slug(b.municipio)}-${slug(b.dt_conexao)}-${b._linha}-${i}`;
      if (vistos.has(cod)) {
        itens.push({ ...item, veredito: 'duplicado_lote', detalhe: 'código repetido no arquivo' });
        continue;
      }
      vistos.add(cod);

      item.usina = {
        cod_empreendimento: cod,
        cnpj: dono.cnpj,
        titular: dono.titular,
        tipo_consumidor: 'PJ',
        distribuidora_nome: (b.distribuidora_nome || '').trim() || null,
        distribuidora_cnpj: normCnpj(b.distribuidora_cnpj) || null,
        concessionaria_codigo: b.distribuidora_nome ? await casarConcessionaria(b.distribuidora_nome) : null,
        uf: (b.uf || '').trim().toUpperCase().slice(0, 2) || combinado?.uf || null,
        municipio: (combinado?.municipio || b.municipio || '').trim() || null,
        cep: (b.cep || '').replace(/\D/g, '').slice(0, 8) || null,
        potencia_kw: parseNum(b.potencia_kw),
        tipo_geracao: (b.tipo_geracao || '').trim().toUpperCase() || null,
        porte: (b.porte || '').trim() || null,
        modalidade: (b.modalidade || '').trim() || null,
        classe_consumo: (b.classe_consumo || '').trim() || null,
        dt_conexao: parseData(b.dt_conexao),
        fase_usina: (b.fase_usina || '').trim() || null,
        fonte: b.fase_usina || b.proprietario_regime ? 'aneel_siga' : 'aneel_gd',
        ingerido_em: new Date().toISOString(),
      };
      if (dono.regime) item.usina.modalidade = item.usina.modalidade || dono.regime;
      if (!item.usina.concessionaria_codigo && item.usina.distribuidora_nome) {
        item.avisoConc = item.usina.distribuidora_nome;
      }
      item.veredito = 'novo';
      itens.push(item);
    }
  }
  return { tipo: 'aneel', itens };
}
