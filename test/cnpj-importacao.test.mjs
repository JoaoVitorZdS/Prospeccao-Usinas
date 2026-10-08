// cnpj-importacao.test.mjs — o contrato do CSV da Base CNPJ entre o MCP e o app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMapear, aplicarMapa, CAMPOS_LEAD } from '../js/parse.js';
import {
  CAMPOS_CNPJ, parseTelefones, parseEmails, parseCnaes, parseSocios, parseMatriz, normSituacao,
  parseCapital, linhaParaEmpresa,
} from '../js/cnpj-importacao.js';

// os mesmos cabeçalhos que `cnpj_exportar` (mcp/src/formato.mjs) escreve
export const CABECALHO_MCP = [
  'CNPJ', 'Razão Social', 'Nome Fantasia', 'Situação Cadastral', 'Data Abertura', 'CNAE Principal',
  'CNAE Principal Descrição', 'CNAEs Secundários', 'Porte', 'Capital Social', 'Natureza Jurídica',
  'Matriz/Filial', 'Logradouro', 'Número', 'Complemento', 'Bairro', 'CEP', 'Município', 'UF',
  'Telefone 1', 'Telefone 2', 'E-mail', 'Sócios',
];

test('autoMapear — o cabeçalho do MCP mapeia cada coluna para o seu campo, sem colisão', () => {
  const mapa = autoMapear(CABECALHO_MCP, CAMPOS_CNPJ);
  const esperado = {
    cnpj: 0, razao_social: 1, nome_fantasia: 2, situacao_cadastral: 3, data_abertura: 4, cnae_principal: 5,
    cnae_descricao: 6, cnaes_secundarios: 7, porte: 8, capital_social: 9, natureza_juridica: 10, matriz: 11,
    logradouro: 12, numero: 13, complemento: 14, bairro: 15, cep: 16, municipio: 17, uf: 18,
    telefone1: 19, telefone2: 20, email: 21, socios: 22,
  };
  assert.deepEqual(mapa, esperado);
  assert.equal(Object.keys(mapa).length, CAMPOS_CNPJ.length, 'todos os campos mapeados');
});

test('autoMapear — exportações de outros sites (cabeçalhos livres) também entram', () => {
  const cab = ['CNPJ', 'Razão Social', 'Nome Fantasia', 'Situação', 'Data de Abertura', 'Atividade Principal', 'Capital', 'Telefone', 'Email', 'Cidade', 'Estado'];
  const mapa = autoMapear(cab, CAMPOS_CNPJ);
  assert.equal(mapa.cnpj, 0);
  assert.equal(mapa.situacao_cadastral, 3);
  assert.equal(mapa.data_abertura, 4);
  assert.equal(mapa.cnae_principal, 5);
  assert.equal(mapa.capital_social, 6);
  assert.equal(mapa.telefone1, 7);
  assert.equal(mapa.email, 8);
  assert.equal(mapa.municipio, 9);
  assert.equal(mapa.uf, 10);
});

test('por que existe um mapeamento próprio — o de LEAD erra nesses cabeçalhos', () => {
  const mapaLead = autoMapear(CABECALHO_MCP, CAMPOS_LEAD);
  // "Data Abertura" viraria "data do contato" e criaria uma interação histórica falsa
  assert.equal(mapaLead.data_contato, 4);
});

test('parseTelefones — vários números na mesma célula, sem duplicar nem concatenar', () => {
  assert.deepEqual(parseTelefones('(11) 3333-4444 / 11 98888-7777'), ['1133334444', '11988887777']);
  assert.deepEqual(parseTelefones('1133334444; 1133334444'), ['1133334444']);
  assert.deepEqual(parseTelefones('+55 11 98888-7777'), ['11988887777']);
  assert.deepEqual(parseTelefones('123'), []);
  assert.deepEqual(parseTelefones(''), []);
});

test('parseEmails — vários endereços, só os válidos, minúsculos', () => {
  assert.deepEqual(parseEmails('Contato@Empresa.com.br; fin@empresa.com.br'), ['contato@empresa.com.br', 'fin@empresa.com.br']);
  assert.deepEqual(parseEmails('sem-arroba, ok@x.com'), ['ok@x.com']);
  assert.deepEqual(parseEmails(''), []);
});

test('parseCnaes — aceita código puro ou formatado e descarta o que não tem 7 dígitos', () => {
  assert.deepEqual(parseCnaes('3511501; 4321500, 4742-3/00'), ['3511501', '4321500', '4742300']);
  assert.deepEqual(parseCnaes('3511501,3511501'), ['3511501']);
  assert.deepEqual(parseCnaes('123'), []);
});

test('parseSocios — nome e qualificação, no máximo 12', () => {
  assert.deepEqual(parseSocios('Maria Souza (Administrador); João Lima — Sócio'), [
    { nome: 'Maria Souza', qualificacao: 'Administrador' }, { nome: 'João Lima', qualificacao: 'Sócio' },
  ]);
  assert.deepEqual(parseSocios('Só Nome'), [{ nome: 'Só Nome', qualificacao: undefined }]);
  assert.equal(parseSocios(Array.from({ length: 20 }, (_, i) => `S${i}`).join(';')).length, 12);
});

test('parseMatriz, normSituacao e parseCapital', () => {
  assert.equal(parseMatriz('Matriz'), true);
  assert.equal(parseMatriz('1'), true);
  assert.equal(parseMatriz('Filial'), false);
  assert.equal(parseMatriz(''), undefined);
  assert.equal(normSituacao('02'), 'Ativa');
  assert.equal(normSituacao('ATIVA'), 'Ativa');
  assert.equal(normSituacao('08'), 'Baixada');
  assert.equal(normSituacao(''), undefined);
  assert.equal(parseCapital('1.250.000,50'), 1250000.5);
  assert.equal(parseCapital('R$ 10.000'), 10000);
  assert.equal(parseCapital('120000000000,00'), 120000000000);
});

test('linhaParaEmpresa — linha completa vira o objeto de empresa, com listas e datas normalizadas', () => {
  const [linha] = aplicarMapa([[
    '11.222.333/0001-81', 'SOLAR VALE LTDA', 'Solar Vale', 'Ativa', '2015-03-02', '3511501', 'Geração de energia elétrica',
    '4321500, 4742300', 'Demais', '1.250.000,50', 'Sociedade Empresária Limitada', 'Matriz', 'Rua das Flores', '120',
    'Sala 4', 'Centro', '13000-000', 'Campinas', 'sp', '(19) 3333-4444; 19 98888-7777', '', 'contato@solar.com.br',
    'Maria Souza (Administrador)',
  ]], autoMapear(CABECALHO_MCP, CAMPOS_CNPJ));
  const { empresa, erro } = linhaParaEmpresa(linha, { competencia: '2026-09' });
  assert.equal(erro, undefined);
  assert.deepEqual(empresa, {
    cnpj: '11222333000181', fonte_cadastro: 'receita_federal', razao_social: 'SOLAR VALE LTDA', nome_fantasia: 'Solar Vale',
    situacao_cadastral: 'Ativa', data_abertura: '2015-03-02', cnae_principal: '3511501', cnae_descricao: 'Geração de energia elétrica',
    cnaes_secundarios: ['4321500', '4742300'], porte: 'Demais', capital_social: 1250000.5,
    natureza_juridica: 'Sociedade Empresária Limitada', matriz: true, logradouro: 'Rua das Flores, 120, Sala 4, Centro',
    cep: '13000000', municipio_sede: 'Campinas', uf_sede: 'SP', telefone1: '1933334444', telefone2: '19988887777',
    email: 'contato@solar.com.br', socios: [{ nome: 'Maria Souza', qualificacao: 'Administrador' }],
    competencia_cadastro: '2026-09',
  });
});

test('linhaParaEmpresa — só inclui o que veio preenchido (importar um CSV pobre não apaga dado enriquecido)', () => {
  const { empresa } = linhaParaEmpresa({ cnpj: '11222333000181', razao_social: 'X LTDA', telefone1: '', email: '', socios: '' });
  assert.deepEqual(Object.keys(empresa).sort(), ['cnpj', 'fonte_cadastro', 'razao_social']);
});

test('linhaParaEmpresa — CNPJ ausente ou inválido vira erro, não vira empresa', () => {
  assert.equal(linhaParaEmpresa({ razao_social: 'X' }).erro, 'sem CNPJ');
  assert.equal(linhaParaEmpresa({ cnpj: '123' }).erro, 'CNPJ inválido');
  assert.equal(linhaParaEmpresa({ cnpj: '123' }).empresa, undefined);
});
