// ambiente.mjs — de onde vêm o e-mail e a senha do sincronizador: variável de ambiente, `.env.local` / `.env` (fora do
// git) e, na falta, pergunta no terminal. A senha nunca é gravada em lugar nenhum por este código.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'node:readline';

/** Lê o texto de um `.env`: `CHAVE=valor`, aspas opcionais, `#` comentário, `export CHAVE=valor`. */
export function lerEnv(texto) {
  const saida = {};
  for (const bruta of String(texto).replace(/^﻿/, '').split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha || linha.startsWith('#')) continue;
    const m = linha.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let valor = m[2].trim();
    if ((valor.startsWith('"') && valor.endsWith('"') && valor.length > 1) || (valor.startsWith("'") && valor.endsWith("'") && valor.length > 1)) {
      valor = valor.slice(1, -1);
    } else {
      valor = valor.replace(/\s+#.*$/, ''); // comentário no fim da linha (só fora de aspas)
    }
    saida[m[1]] = valor;
  }
  return saida;
}

/**
 * Aplica o arquivo em `ambiente` SEM sobrescrever o que já veio do ambiente real. `prefixo`: só importa chaves que
 * começam por ele (um `.env` costuma ter variáveis de outras coisas — não as puxamos para este processo).
 * Devolve se o arquivo existia.
 */
export function carregarEnvLocal(caminho, ambiente = process.env, prefixo = '') {
  if (!existsSync(caminho)) return false;
  for (const [chave, valor] of Object.entries(lerEnv(readFileSync(caminho, 'utf8')))) {
    if (chave.startsWith(prefixo) && ambiente[chave] === undefined) ambiente[chave] = valor;
  }
  return true;
}

/**
 * Carrega `.env.local` e depois `.env` (o que vier primeiro vence; o ambiente real vence os dois). Os dois ficam fora
 * do git e do deploy. Devolve os nomes dos arquivos que existiam — para o aviso "credenciais lidas de …".
 */
export function carregarCredenciais(raiz, ambiente = process.env) {
  return ['.env.local', '.env'].filter((nome) => carregarEnvLocal(resolve(raiz, nome), ambiente, 'WATTSCOUT_'));
}

/** Pergunta no terminal (stderr, para não sujar a saída). Para senha use `lerSenha`. */
export function perguntar(texto) {
  return new Promise((resolver) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY === true });
    rl.question(texto, (resposta) => { rl.close(); resolver(resposta.trim()); });
  });
}

/**
 * Lê uma senha mostrando um `*` por tecla (sem isso parece que o campo não aceita nada). Trata colar texto, Backspace,
 * Enter e Ctrl+C. `entrada`/`saida` são injetáveis para o teste; exige terminal (raw mode) — sem ele devolve erro claro.
 */
export function lerSenha(texto, { entrada = process.stdin, saida = process.stderr } = {}) {
  return new Promise((resolver, rejeitar) => {
    if (!entrada.isTTY || typeof entrada.setRawMode !== 'function') {
      rejeitar(new Error('Este terminal não permite digitar a senha (Git Bash/mintty, por exemplo). Use o PowerShell, o CMD ou o terminal do VS Code — ou coloque WATTSCOUT_EMAIL e WATTSCOUT_SENHA no arquivo .env.local.'));
      return;
    }
    let senha = '';
    const terminar = (fn) => {
      entrada.removeListener('data', aoReceber);
      entrada.setRawMode(false);
      entrada.pause();
      saida.write('\n');
      fn();
    };
    function aoReceber(pedaco) {
      const letras = [...String(pedaco)];
      for (let i = 0; i < letras.length; i++) {
        const c = letras[i];
        if (c === '\r' || c === '\n') return terminar(() => resolver(senha)); // o que vier depois do Enter é descartado
        if (c === '\u0003') return terminar(() => rejeitar(new Error('Cancelado.'))); // Ctrl+C
        if (c === '\u007f' || c === '\b') { if (senha) { senha = [...senha].slice(0, -1).join(''); saida.write('\b \b'); } continue; }
        if (c === '\u001b') { // seta/Home/End…: pula a sequência de escape inteira
          if (letras[i + 1] === '[') { i += 2; while (i < letras.length && !/[@-~]/.test(letras[i])) i++; }
          continue;
        }
        if (c < ' ') continue; // outros caracteres de controle
        senha += c;
        saida.write('*');
      }
    }
    saida.write(texto);
    entrada.setEncoding('utf8');
    entrada.setRawMode(true);
    entrada.resume();
    entrada.on('data', aoReceber);
  });
}

/** "s"/"sim"/"y"/"yes" → true; qualquer outra coisa (inclusive vazio) → false. */
export const ehSim = (resposta) => /^(s|sim|y|yes)$/i.test(String(resposta ?? '').trim());
