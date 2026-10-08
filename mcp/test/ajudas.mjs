// ajudas.mjs — monta, nos testes, zips e dados NO FORMATO REAL da Receita (conferido com arquivos de 2026-09).
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Zip de UMA entrada (cabeçalho local + deflate): é tudo que o leitor da Receita precisa. */
export function criarZip(caminho, nomeInterno, texto) {
  const dados = Buffer.from(texto, 'latin1');
  const comp = deflateRawSync(dados);
  const nome = Buffer.from(nomeInterno, 'latin1');
  const cab = Buffer.alloc(30);
  cab.writeUInt32LE(0x04034b50, 0);
  cab.writeUInt16LE(20, 4);              // versão
  cab.writeUInt16LE(0, 6);               // flags
  cab.writeUInt16LE(8, 8);               // deflate
  cab.writeUInt32LE(crc32(dados), 14);
  cab.writeUInt32LE(comp.length, 18);
  cab.writeUInt32LE(dados.length, 22);
  cab.writeUInt16LE(nome.length, 26);
  cab.writeUInt16LE(0, 28);
  writeFileSync(caminho, Buffer.concat([cab, nome, comp]));
}

/** Linha no formato da Receita: todos os campos entre aspas, separados por ";". */
export const linhaRfb = (cols) => `"${cols.map((c) => String(c ?? '').replaceAll('"', '""')).join('";"')}"`;

/** Estabelecimento (30 colunas) a partir de um objeto com os campos que interessam. */
export function estab({
  basico, ordem = '0001', dv = '00', matriz = '1', fantasia = '', situacao = '02', dataSituacao = '20100101',
  abertura = '20100101', cnae, secundarios = '', tipoLogr = 'RUA', logradouro = 'DAS FLORES', numero = '100',
  complemento = '', bairro = 'CENTRO', cep = '13000000', uf = 'SP', municipio = '6001', ddd1 = '19', tel1 = '33334444',
  ddd2 = '', tel2 = '', email = '',
}) {
  return linhaRfb([basico, ordem, dv, matriz, fantasia, situacao, dataSituacao, '01', '', '', abertura, cnae, secundarios,
    tipoLogr, logradouro, numero, complemento, bairro, cep, uf, municipio, ddd1, tel1, ddd2, tel2, '', '', email, '', '']);
}

export const empresaRfb = ({ basico, razao, natureza = '2062', porte = '05', capital = '1000,00' }) =>
  linhaRfb([basico, razao, natureza, '49', capital, porte, '']);

export const socioRfb = ({ basico, tipo = '2', nome, qualificacao = '49', entrada = '20100101', faixa = '4' }) =>
  linhaRfb([basico, tipo, nome, '***123456**', qualificacao, entrada, '', '***000000**', '', '00', faixa]);

/** Cria uma pasta de competência com um conjunto pequeno e conhecido de dados. Devolve o caminho. */
export function criarPastaRfb() {
  const pasta = mkdtempSync(join(tmpdir(), 'rfb-teste-'));
  mkdirSync(pasta, { recursive: true });
  criarZip(join(pasta, 'Cnaes.zip'), 'F.K03200$Z.D60912.CNAECSV', [
    ['3511501', 'Geração de energia elétrica'], ['4321500', 'Instalação e manutenção elétrica'],
    ['4742300', 'Comércio varejista de material elétrico'], ['0111301', 'Cultivo de arroz'],
  ].map(linhaRfb).join('\n') + '\n');
  criarZip(join(pasta, 'Municipios.zip'), 'F.K03200$Z.D60912.MUNICCSV', [
    ['6001', 'CAMPINAS'], ['7107', 'SAO PAULO'], ['4123', 'BELO HORIZONTE'], ['6002', 'RIO DE JANEIRO'],
  ].map(linhaRfb).join('\n') + '\n');
  criarZip(join(pasta, 'Naturezas.zip'), 'F.K03200$Z.D60912.NATJUCSV', [
    ['2062', 'Sociedade Empresária Limitada'], ['2135', 'Empresário (Individual)'],
  ].map(linhaRfb).join('\n') + '\n');
  criarZip(join(pasta, 'Qualificacoes.zip'), 'F.K03200$Z.D60912.QUALSCSV', [
    ['49', 'Sócio-Administrador'], ['05', 'Administrador'],
  ].map(linhaRfb).join('\n') + '\n');

  // Estabelecimentos — duas partes, como na base real (CRLF para exercitar os dois fins de linha)
  criarZip(join(pasta, 'Estabelecimentos0.zip'), 'K.ESTABELE', [
    estab({ basico: '11111111', cnae: '3511501', secundarios: '4321500,4742300', fantasia: 'SOLAR VALE', email: 'Contato@SolarVale.com.br', ddd2: '19', tel2: '33334444' }),
    estab({ basico: '11111111', ordem: '0002', dv: '62', matriz: '2', cnae: '3511501', uf: 'SP', municipio: '7107', tel1: '', ddd1: '' }),
    estab({ basico: '22222222', dv: '17', cnae: '4742300', uf: 'MG', municipio: '4123', email: 'loja@material.com.br' }),
    estab({ basico: '33333333', dv: '44', cnae: '3511501', situacao: '08' }),             // baixada
  ].join('\r\n') + '\r\n');
  criarZip(join(pasta, 'Estabelecimentos1.zip'), 'K.ESTABELE', [
    estab({ basico: '44444444', dv: '90', cnae: '0111301' }),                              // agro
    estab({ basico: '55555555', dv: '25', cnae: '3511501' }),                              // empresário individual
    estab({ basico: '66666666', dv: '40', cnae: '4321500', uf: 'RJ', municipio: '6002', abertura: '20230615', tel1: '', ddd1: '' }),
    estab({ basico: '77777777', dv: '11', cnae: '4321500', situacao: '02', uf: 'SP' }),   // sem linha em Empresas
  ].join('\n') + '\n');

  criarZip(join(pasta, 'Empresas0.zip'), 'K.EMPRECSV', [
    empresaRfb({ basico: '11111111', razao: 'SOLAR VALE ENERGIA LTDA', capital: '1250000,50' }),
    empresaRfb({ basico: '22222222', razao: 'LOJA DE MATERIAL ELETRICO LTDA', porte: '03', capital: '50000,00' }),
    empresaRfb({ basico: '99999999', razao: 'NAO ESTA NA BASE ESTABELECIMENTOS' }),
  ].join('\n') + '\n');
  criarZip(join(pasta, 'Empresas1.zip'), 'K.EMPRECSV', [
    empresaRfb({ basico: '33333333', razao: 'EMPRESA BAIXADA LTDA' }),
    empresaRfb({ basico: '44444444', razao: 'FAZENDA ARROZ LTDA' }),
    empresaRfb({ basico: '55555555', razao: 'JOAO DA SILVA 12345678900', natureza: '2135', porte: '01', capital: '0,00' }),
    empresaRfb({ basico: '66666666', razao: 'INSTALADORA ELETRICA RIO LTDA', porte: '02', capital: '30000,00' }),
  ].join('\n') + '\n');

  criarZip(join(pasta, 'Socios0.zip'), 'K.SOCIOCSV', [
    socioRfb({ basico: '11111111', nome: 'MARIA SOUZA', faixa: '5' }),
    socioRfb({ basico: '11111111', tipo: '1', nome: 'HOLDING SOLAR SA', qualificacao: '05', faixa: '0' }),
    socioRfb({ basico: '55555555', nome: 'JOAO DA SILVA' }),
    socioRfb({ basico: '88888888', nome: 'ALHEIO' }),
  ].join('\n') + '\n');
  return pasta;
}
