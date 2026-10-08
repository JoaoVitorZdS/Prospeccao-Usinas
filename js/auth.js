// auth.js — login por e-mail e senha (Supabase Auth).
//
// Fluxo: cadastro → e-mail de confirmação → login → `perfilAtual()` (db.js) liga a conta ao
// perfil → se o perfil estiver pendente, a tela "Aguardando aprovação" segura o acesso até um
// gestor liberar. O isolamento dos dados NÃO depende destas telas: quem manda é o RLS do banco
// (0006_auth_rls.sql). Aqui é só a porta de entrada.
//
// PKCE: os links do e-mail voltam para a página com `?code=` (nunca `#access_token=`, que
// colidiria com o roteador por hash). O supabase-js troca o código por sessão sozinho
// (`detectSessionInUrl`). Abra o link no MESMO navegador onde pediu o cadastro/recuperação.

import { abrir } from './db.js';

export const SENHA_MINIMA = 8;

/** URL para onde os e-mails de confirmação/recuperação devolvem o usuário. */
const retorno = (extra = '') => `${location.origin}${location.pathname}${extra}`;

/** Mensagens do Supabase Auth em português, sem vazar detalhe técnico. */
export function traduzirErroAuth(e) {
  const cod = e?.code || '';
  const msg = String(e?.message || (typeof e === 'string' ? e : ''));
  const tabela = {
    invalid_credentials: 'E-mail ou senha incorretos.',
    email_not_confirmed: 'Seu e-mail ainda não foi confirmado. Abra o link que enviamos quando você criou a conta.',
    user_already_exists: 'Já existe uma conta com esse e-mail. Entre, ou use "Esqueci minha senha".',
    weak_password: `Senha fraca. Use pelo menos ${SENHA_MINIMA} caracteres, misturando letras e números.`,
    same_password: 'A nova senha precisa ser diferente da atual.',
    over_email_send_rate_limit: 'Muitos e-mails em pouco tempo. Aguarde alguns minutos e tente de novo.',
    over_request_rate_limit: 'Muitas tentativas. Aguarde um pouco e tente de novo.',
    email_address_invalid: 'Esse e-mail não parece válido.',
    signup_disabled: 'O cadastro está desativado neste projeto.',
    otp_expired: 'O link expirou ou já foi usado. Peça um novo.',
    flow_state_not_found: 'O link não é mais válido. Peça um novo.',
    session_not_found: 'Sua sessão expirou. Entre de novo.',
  };
  if (tabela[cod]) return tabela[cod];
  if (/invalid login credentials/i.test(msg)) return tabela.invalid_credentials;
  if (/email not confirmed/i.test(msg)) return tabela.email_not_confirmed;
  if (/already registered/i.test(msg)) return tabela.user_already_exists;
  if (/rate limit/i.test(msg)) return tabela.over_email_send_rate_limit;
  if (/code verifier|pkce/i.test(msg)) return 'Abra o link no mesmo navegador em que você pediu o e-mail, ou peça um novo.';
  if (/failed to fetch|network/i.test(msg)) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
  return msg || 'Não foi possível concluir. Tente de novo.';
}

export function validarSenha(senha) {
  if (String(senha || '').length < SENHA_MINIMA) return `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres.`;
  if (!/[A-Za-z]/.test(senha) || !/\d/.test(senha)) return 'Use letras e números na senha.';
  return null;
}

export async function sessaoAtual() {
  const sb = await abrir();
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function entrar(email, senha) {
  const sb = await abrir();
  const { data, error } = await sb.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password: senha });
  if (error) throw error;
  return data.session;
}

/** Cria a conta. Com "Confirm email" ligado no Supabase não volta sessão — o usuário confirma pelo e-mail. */
export async function cadastrar({ nome, email, senha }) {
  const sb = await abrir();
  const { data, error } = await sb.auth.signUp({
    email: String(email).trim().toLowerCase(),
    password: senha,
    options: { data: { nome: String(nome).trim() }, emailRedirectTo: retorno() },
  });
  if (error) throw error;
  return { sessao: data.session, precisaConfirmar: !data.session };
}

export async function sair() {
  const sb = await abrir();
  await sb.auth.signOut();
}

export async function recuperarSenha(email) {
  const sb = await abrir();
  const { error } = await sb.auth.resetPasswordForEmail(String(email).trim().toLowerCase(), {
    redirectTo: retorno('?recuperar=1'),
  });
  if (error) throw error;
}

/** Usada na recuperação (já há sessão do link) e em "Meu perfil". */
export async function definirNovaSenha(senha) {
  const sb = await abrir();
  const { error } = await sb.auth.updateUser({ password: senha });
  if (error) throw error;
}

/** Em "Meu perfil": confere a senha atual antes de trocar (reautentica). */
export async function trocarSenha(email, senhaAtual, senhaNova) {
  const sb = await abrir();
  const { error } = await sb.auth.signInWithPassword({ email, password: senhaAtual });
  if (error) throw Object.assign(new Error('A senha atual está incorreta.'), { code: 'senha_atual_incorreta' });
  await definirNovaSenha(senhaNova);
}

/** Erros que o Supabase devolve na URL quando o link do e-mail falha (expirado, já usado…). */
export function erroNaUrl() {
  const busca = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#\/?/, '').replace(/^[^=]*\?/, ''));
  const desc = busca.get('error_description') || hash.get('error_description');
  const cod = busca.get('error_code') || hash.get('error_code');
  return desc || cod ? traduzirErroAuth({ code: cod, message: desc?.replace(/\+/g, ' ') }) : null;
}

export const emRecuperacao = () => new URLSearchParams(location.search).get('recuperar') === '1';

/** Tira `?code=…`, `?recuperar=1` e erros da barra de endereço, preservando a rota (#/…). */
export function limparUrlAuth() {
  const q = new URLSearchParams(location.search);
  ['code', 'recuperar', 'error', 'error_code', 'error_description'].forEach((k) => q.delete(k));
  const resto = q.toString();
  const hash = /error_description|error_code/.test(location.hash) ? '' : location.hash;
  history.replaceState(null, '', `${location.pathname}${resto ? `?${resto}` : ''}${hash}`);
}

/** Avisa quando a sessão acaba em outra aba ou expira (para voltar ao login). */
export async function aoSair(callback) {
  const sb = await abrir();
  sb.auth.onAuthStateChange((evento) => { if (evento === 'SIGNED_OUT') callback(); });
}
