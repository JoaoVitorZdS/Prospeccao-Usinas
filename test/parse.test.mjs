// test/parse.test.mjs — mapeamento de colunas contra os cabeçalhos REAIS da
// ANEEL (GD e SIGA), mais os casos que já pegaram bug de verdade nesta sessão:
// a inversão do laço de nível (autoMapear) e o alias genérico "nome" roubando
// a coluna errada do SIGA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { autoMapear, CAMPOS_ANEEL, CAMPOS_LEAD, pareceCabecalho, parseTexto } from '../js/parse.js';
import { parseCSV } from '../js/util.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..');

const CABECALHO_GD_REAL = ['DatGeracaoConjuntoDados', 'AnmPeriodoReferencia', 'NumCNPJDistribuidora',
  'SigAgente', 'NomAgente', 'CodClasseConsumo', 'DscClasseConsumo', 'CodSubGrupoTarifario',
  'DscSubGrupoTarifario', 'CodUFibge', 'SigUF', 'CodRegiao', 'NomRegiao', 'CodMunicipioIbge',
  'NomMunicipio', 'CodCEP', 'SigTipoConsumidor', 'NumCPFCNPJ', 'CodEmpreendimento',
  'DthAtualizaCadastralEmpreend', 'SigModalidadeEmpreendimento', 'DscModalidadeHabilitado',
  'QtdUCRecebeCredito', 'SigTipoGeracao', 'DscFonteGeracao', 'DscPorte', 'MdaPotenciaInstaladaKW',
  'NomSubEstacao', 'NumCoordESub', 'NumCoordNSub', 'NomTitularEmpreendimento'];

test('autoMapear — cabeçalho real da ANEEL GD: cada coluna crítica cai no campo certo', () => {
  const mapa = autoMapear(CABECALHO_GD_REAL, CAMPOS_ANEEL);
  const em = (campo) => CABECALHO_GD_REAL[mapa[campo]];
  assert.equal(em('cnpj'), 'NumCPFCNPJ');
  assert.equal(em('titular'), 'NomTitularEmpreendimento');
  assert.equal(em('tipo_consumidor'), 'SigTipoConsumidor');
  assert.equal(em('distribuidora_nome'), 'NomAgente');
  assert.equal(em('uf'), 'SigUF');
  assert.equal(em('municipio'), 'NomMunicipio');
  assert.equal(em('cep'), 'CodCEP');
  assert.equal(em('potencia_kw'), 'MdaPotenciaInstaladaKW');
  assert.equal(em('tipo_geracao'), 'SigTipoGeracao');
  assert.equal(em('porte'), 'DscPorte');
  assert.equal(em('classe_consumo'), 'DscClasseConsumo');
  assert.equal(em('cod_empreendimento'), 'CodEmpreendimento');
  assert.equal(em('dt_conexao'), 'DthAtualizaCadastralEmpreend');
  // SIGA-only: não deve existir no arquivo GD
  assert.equal(mapa.fase_usina, undefined);
  assert.equal(mapa.proprietario_regime, undefined);
});

test('autoMapear — cabeçalho real do SIGA: NomEmpreendimento (código curto, não é nome) NÃO vira titular', () => {
  const texto = readFileSync(path.join(RAIZ, 'etl/amostras/aneel-siga-amostra.csv'), 'utf-8');
  const cabecalhoReal = parseCSV(texto, ',')[0];
  assert.ok(cabecalhoReal.includes('NomEmpreendimento'));

  const mapa = autoMapear(cabecalhoReal, CAMPOS_ANEEL);
  // a armadilha real: "nome" como alias genérico casava por substring com
  // "NomEmpreendimento" (que traz só um código curto, tipo "E"/"F"), roubando
  // a coluna antes que nada de melhor aparecesse — titular deve ficar SEM mapa
  assert.equal(mapa.titular, undefined,
    'titular não deve casar com NomEmpreendimento — esse campo do SIGA não é o nome do dono');

  const em = (campo) => cabecalhoReal[mapa[campo]];
  assert.equal(em('proprietario_regime'), 'DscPropriRegimePariticipacao');
  assert.equal(em('fase_usina'), 'DscFaseUsina');
  assert.equal(em('municipio'), 'DscMuninicpios'); // typo real da ANEEL, coberto por alias explícito
  assert.equal(em('dt_conexao'), 'DatEntradaOperacao');
  assert.equal(em('uf'), 'SigUFPrincipal');
  // a potência AUDITADA (Fiscalizada) deve vencer a concedida (Outorgada),
  // mesmo a Outorgada aparecendo antes no cabeçalho
  assert.equal(em('potencia_kw'), 'MdaPotenciaFiscalizadaKw');
  assert.equal(mapa.cnpj, undefined, 'SIGA não tem coluna de CNPJ direta — vem só via proprietario_regime');
});

test('autoMapear — planilha legada (CAMPOS_LEAD): as 10 colunas da planilha atual, na ordem do plano', () => {
  const cabecalho = ['Origem da prospecção', 'Nome', 'Telefone', 'E-mail', 'Desenvolveu',
    'Data do contato', 'Autor do contato', 'Concessionária', 'CEP', 'Descrição do contato'];
  const mapa = autoMapear(cabecalho, CAMPOS_LEAD);
  const em = (campo) => cabecalho[mapa[campo]];
  assert.equal(em('origem'), 'Origem da prospecção');
  assert.equal(em('razao_social'), 'Nome');
  assert.equal(em('telefone'), 'Telefone');
  assert.equal(em('email'), 'E-mail');
  assert.equal(em('desenvolveu'), 'Desenvolveu');
  assert.equal(em('data_contato'), 'Data do contato');
  assert.equal(em('autor'), 'Autor do contato');
  assert.equal(em('concessionaria'), 'Concessionária');
  assert.equal(em('cep'), 'CEP');
  assert.equal(em('descricao'), 'Descrição do contato');
  // regressão do bug original: "contato_nome" não pode roubar "Data do contato"
  assert.equal(mapa.contato_nome, undefined);
});

test('pareceCabecalho — reconhece o cabeçalho real da GD e da planilha legada', () => {
  assert.equal(pareceCabecalho(CABECALHO_GD_REAL, CAMPOS_ANEEL), true);
  assert.equal(pareceCabecalho(['12005360000165', 'ELITE ENGENHARIA', '412,50'], CAMPOS_ANEEL), false);
});

test('parseTexto (colagem sem HTML) — TSV solto vira matriz', () => {
  const linhas = parseTexto('Nome\tTelefone\nELITE ENGENHARIA LTDA\t19998765432');
  assert.deepEqual(linhas, [['Nome', 'Telefone'], ['ELITE ENGENHARIA LTDA', '19998765432']]);
});
