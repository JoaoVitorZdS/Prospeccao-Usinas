// zip.mjs — leitor mínimo para os zips da Receita: UM arquivo por zip, método deflate (ou armazenado).
//
// Não precisa do diretório central: lê o cabeçalho local da primeira entrada, pula até os dados e
// descomprime em streaming. É o que permite processar um Estabelecimentos0.zip de 2 GB (≈ 8 GB
// descomprimido) sem nunca carregá-lo na memória, e sem dependência de unzip/7z no PATH.
// (O ZIP dos dados da ANEEL, lido no navegador, usa outro leitor: js/aneel.js.)

import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInflateRaw } from 'node:zlib';

const ASSINATURA_LOCAL = 0x04034b50;

/** Lê o cabeçalho local do primeiro arquivo do zip. */
export async function cabecalhoDaPrimeiraEntrada(caminho) {
  const fh = await open(caminho, 'r');
  try {
    const buf = Buffer.alloc(30);
    const { bytesRead } = await fh.read(buf, 0, 30, 0);
    if (bytesRead < 30 || buf.readUInt32LE(0) !== ASSINATURA_LOCAL) {
      throw new Error(`${caminho}: não parece um .zip (assinatura inválida) — download incompleto?`);
    }
    const metodo = buf.readUInt16LE(8);
    const nomeLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    if (metodo !== 0 && metodo !== 8) throw new Error(`${caminho}: método de compressão ${metodo} não suportado.`);
    const nome = Buffer.alloc(nomeLen);
    await fh.read(nome, 0, nomeLen, 30);
    return { nome: nome.toString('latin1'), metodo, inicioDados: 30 + nomeLen + extraLen };
  } finally {
    await fh.close();
  }
}

/** Stream dos bytes descomprimidos da primeira entrada do zip. */
export async function abrirEntrada(caminho) {
  const { nome, metodo, inicioDados } = await cabecalhoDaPrimeiraEntrada(caminho);
  const bruto = createReadStream(caminho, { start: inicioDados, highWaterMark: 1 << 20 });
  return { nome, stream: metodo === 8 ? bruto.pipe(createInflateRaw()) : bruto };
}

/**
 * Linhas (latin1) da primeira entrada do zip, uma a uma. Funciona com `\n` ou `\r\n`; a última
 * linha sem quebra final também é devolvida. Aceita um zip TRUNCADO (download em andamento) apenas
 * quando `tolerarTruncado` — nesse caso o erro de fim inesperado é ignorado e a linha incompleta
 * final é descartada.
 */
export async function* linhasDoZip(caminho, { tolerarTruncado = false } = {}) {
  const { stream } = await abrirEntrada(caminho);
  let resto = '';
  try {
    for await (const pedaco of stream) {
      const texto = resto + pedaco.toString('latin1');
      let ini = 0;
      for (let i = texto.indexOf('\n'); i >= 0; i = texto.indexOf('\n', ini)) {
        const linha = texto.slice(ini, i);
        ini = i + 1;
        if (linha) yield linha.endsWith('\r') ? linha.slice(0, -1) : linha;
      }
      resto = texto.slice(ini);
    }
  } catch (e) {
    if (!(tolerarTruncado && /unexpected end|incomplete|premature/i.test(e.message))) throw e;
    return; // descarta `resto` (linha cortada no meio)
  }
  if (resto) yield resto.endsWith('\r') ? resto.slice(0, -1) : resto;
}
