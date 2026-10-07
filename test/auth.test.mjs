// auth.test.mjs — regras puras da porta de entrada: validação de senha e mensagens de erro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarSenha, traduzirErroAuth, SENHA_MINIMA } from '../js/auth.js';

test('validarSenha — exige tamanho mínimo, letras e números', () => {
  assert.equal(SENHA_MINIMA, 8);
  assert.match(validarSenha('abc123'), /pelo menos 8/);
  assert.match(validarSenha(''), /pelo menos 8/);
  assert.match(validarSenha(undefined), /pelo menos 8/);
  assert.match(validarSenha('somenteletras'), /letras e números/);
  assert.match(validarSenha('1234567890'), /letras e números/);
  assert.equal(validarSenha('energia2026'), null);
});

test('traduzirErroAuth — códigos do Supabase Auth viram português claro', () => {
  assert.equal(traduzirErroAuth({ code: 'invalid_credentials' }), 'E-mail ou senha incorretos.');
  assert.match(traduzirErroAuth({ code: 'email_not_confirmed' }), /confirmado/);
  assert.match(traduzirErroAuth({ code: 'user_already_exists' }), /Já existe uma conta/);
  assert.match(traduzirErroAuth({ code: 'weak_password' }), /Senha fraca/);
  assert.match(traduzirErroAuth({ code: 'over_email_send_rate_limit' }), /Muitos e-mails/);
  assert.match(traduzirErroAuth({ code: 'otp_expired' }), /expirou/);
});

test('traduzirErroAuth — sem código, reconhece a mensagem em inglês', () => {
  assert.equal(traduzirErroAuth({ message: 'Invalid login credentials' }), 'E-mail ou senha incorretos.');
  assert.match(traduzirErroAuth({ message: 'Email not confirmed' }), /confirmado/);
  assert.match(traduzirErroAuth({ message: 'User already registered' }), /Já existe uma conta/);
  assert.match(traduzirErroAuth({ message: 'email rate limit exceeded' }), /Muitos e-mails/);
  assert.match(traduzirErroAuth({ message: 'PKCE code verifier not found in storage' }), /mesmo navegador/);
  assert.match(traduzirErroAuth(new TypeError('Failed to fetch')), /Sem conexão/);
});

test('traduzirErroAuth — mensagem desconhecida passa como está; vazio vira texto genérico', () => {
  assert.equal(traduzirErroAuth({ message: 'Algo muito específico' }), 'Algo muito específico');
  assert.match(traduzirErroAuth({}), /Tente de novo/);
  assert.match(traduzirErroAuth(null), /Tente de novo/);
});
