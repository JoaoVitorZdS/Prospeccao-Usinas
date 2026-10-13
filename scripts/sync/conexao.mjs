// conexao.mjs — abre a MESMA camada de dados do app (js/db.js) dentro do Node e faz o login.
//
// Não há chave especial: o sincronizador entra com e-mail e senha de uma conta de GESTOR, como qualquer pessoa na
// tela de login, e o RLS do banco vale igual (uma conta de agente não consegue gravar a base da ANEEL). Por isso
// também não existe `service_role` nesta pasta — e nem deve existir.

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrir, perfilAtual } from '../../js/db.js';
import { traduzirErroAuth } from '../../js/auth.js';

const RAIZ = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * O bundle do supabase-js vendorizado é um script de navegador (`var supabase = …`). Executa o mesmo arquivo que o
 * app usa e o deixa em `globalThis.supabase`, que é onde `abrir()` procura fora do navegador.
 */
export function carregarBibliotecaSupabase() {
  if (globalThis.supabase?.createClient) return globalThis.supabase;
  const nome = readdirSync(resolve(RAIZ, 'vendor')).find((n) => /^supabase-js-.+\.umd\.js$/.test(n));
  if (!nome) throw new Error('vendor/supabase-js-*.umd.js não encontrado — o repositório está incompleto.');
  const codigo = readFileSync(resolve(RAIZ, 'vendor', nome), 'utf8');
  globalThis.supabase = new Function(`${codigo}\nreturn supabase;`)();
  return globalThis.supabase;
}

/** Entra e devolve o perfil. Exige conta ATIVA e, por padrão, de gestor/admin. */
export async function entrar({ email, senha, exigirGestor = true }) {
  carregarBibliotecaSupabase();
  const sb = await abrir();
  const { error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) throw new Error(`Login recusado: ${traduzirErroAuth(error)}`);
  const perfil = await perfilAtual();
  if (!perfil?.ativo) throw new Error(`A conta ${email} ainda não foi aprovada por um gestor.`);
  if (exigirGestor && !['gestor', 'admin'].includes(perfil.papel)) {
    throw new Error(`A conta ${email} é de ${perfil.papel}. O sincronizador grava a base da ANEEL, que só gestor pode gravar — use uma conta de gestor.`);
  }
  return perfil;
}
