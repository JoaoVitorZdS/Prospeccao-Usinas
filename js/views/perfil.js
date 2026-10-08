// views/perfil.js — "Meu perfil": nome, e-mail, papel e troca de senha do próprio usuário.
// Papel e situação são somente leitura aqui: só um gestor muda isso (Gestão de contas).

import { h } from '../util.js';
import { atualizarMeuNome } from '../db.js';
import { trocarSenha, sair, validarSenha, traduzirErroAuth, SENHA_MINIMA } from '../auth.js';
import { cabecalhoPagina, card, avatar, badge, toast } from '../ui.js';

const ROTULO_PAPEL = { agente: 'Agente', gestor: 'Gestor', admin: 'Administrador' };

export async function viewPerfil(params, ctxApp) {
  const { perfil, recarregarApp } = ctxApp;
  const raiz = h('div', { class: 'pagina' });

  /* ── dados ── */
  const nome = h('input', { type: 'text', value: perfil.nome, autocomplete: 'name', maxlength: '120' });
  const salvarNome = h('button', { class: 'btn btn--primario', type: 'submit' }, 'Salvar nome');
  const formNome = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    salvarNome.disabled = true;
    try {
      await atualizarMeuNome(perfil.id, nome.value);
      toast('Nome atualizado.', 'ok');
      await recarregarApp();
    } catch (err) {
      toast(err.message, 'erro');
      salvarNome.disabled = false;
    }
  } },
  h('label', { class: 'campo' }, h('span', {}, 'Nome'), nome),
  h('label', { class: 'campo' }, h('span', {}, 'E-mail'),
    h('input', { type: 'email', value: perfil.email || '', disabled: true }),
    h('small', {}, 'O e-mail é a identidade da conta e só muda pela gestão de contas.')),
  h('div', { class: 'linha-botoes' }, salvarNome));

  /* ── senha ── */
  const atual = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const nova = h('input', { type: 'password', required: true, autocomplete: 'new-password', minlength: String(SENHA_MINIMA) });
  const nova2 = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const botaoSenha = h('button', { class: 'btn btn--primario', type: 'submit' }, 'Trocar senha');
  const formSenha = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault();
    const problema = validarSenha(nova.value) || (nova.value !== nova2.value ? 'As senhas não conferem.' : null);
    if (problema) return toast(problema, 'erro');
    botaoSenha.disabled = true;
    try {
      await trocarSenha(perfil.email, atual.value, nova.value);
      toast('Senha alterada.', 'ok');
      formSenha.reset();
    } catch (err) {
      toast(err.code === 'senha_atual_incorreta' ? err.message : traduzirErroAuth(err), 'erro');
    }
    botaoSenha.disabled = false;
  } },
  h('label', { class: 'campo' }, h('span', {}, 'Senha atual'), atual),
  h('label', { class: 'campo' }, h('span', {}, 'Nova senha'), nova,
    h('small', {}, `Mínimo ${SENHA_MINIMA} caracteres, com letras e números.`)),
  h('label', { class: 'campo' }, h('span', {}, 'Repita a nova senha'), nova2),
  h('div', { class: 'linha-botoes' }, botaoSenha));

  raiz.append(
    cabecalhoPagina('Meu perfil', 'Seus dados de acesso ao WattScout'),
    h('div', { class: 'grade-2' },
      card(h('div', { class: 'card__cabeca' },
        h('div', { style: 'display:flex;align-items:center;gap:12px' },
          avatar(perfil.nome, { tamanho: 'grande' }),
          h('div', {}, h('h2', {}, perfil.nome), h('span', { class: 'texto-fraco' }, perfil.email || ''))),
        badge(ROTULO_PAPEL[perfil.papel] || perfil.papel, perfil.papel === 'agente' ? 'cinza' : 'roxo')),
      formNome,
      h('p', { class: 'texto-fraco' },
        perfil.papel === 'agente'
          ? 'Como agente, você vê apenas os seus leads e as suas conversas.'
          : 'Como gestor, você vê todos os leads e conversas da equipe e administra as contas.')),
      card('Alterar senha', formSenha)),
    card('Sessão',
      h('p', { class: 'texto-fraco' }, 'Sair encerra a sessão neste navegador.'),
      h('div', { class: 'linha-botoes' },
        h('button', { class: 'btn', type: 'button', onclick: async () => { await sair(); location.reload(); } }, 'Sair da conta'))));
  return raiz;
}
