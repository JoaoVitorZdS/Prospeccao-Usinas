// views/login.js — porta de entrada: entrar, criar conta, recuperar senha, aguardar aprovação.
// Estas telas ocupam a página inteira (sem barra lateral) e, quando terminam, recarregam o app:
// o boot de app.js decide o que mostrar a seguir a partir da sessão.

import { h } from '../util.js';
import { abas } from '../ui.js';
import {
  entrar, cadastrar, recuperarSenha, definirNovaSenha, sair, validarSenha, traduzirErroAuth,
  limparUrlAuth, SENHA_MINIMA,
} from '../auth.js';

function moldura(...conteudo) {
  document.body.classList.add('sem-casca');
  document.body.replaceChildren(
    h('main', { class: 'auth' },
      h('div', { class: 'auth__caixa' },
        h('div', { class: 'auth__marca' },
          h('img', { src: 'icons/icon-192.png', alt: '', width: '56', height: '56' }),
          h('h1', {}, 'WattScout'),
          h('p', {}, 'CRM de prospecção do setor de energia')),
        ...conteudo)));
}

const campo = (rotulo, entrada, ajuda) =>
  h('label', { class: 'campo' }, h('span', {}, rotulo), entrada, ajuda ? h('small', {}, ajuda) : null);

/** Roda `acao` com o botão travado e mostra o erro (traduzido) no lugar certo. */
function enviar(form, botao, areaMsg, acao) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    areaMsg.replaceChildren();
    const rotulo = botao.textContent;
    botao.disabled = true;
    botao.textContent = 'Aguarde…';
    try {
      await acao();
    } catch (err) {
      areaMsg.replaceChildren(h('p', { class: 'auth__erro', role: 'alert' }, traduzirErroAuth(err)));
      botao.disabled = false;
      botao.textContent = rotulo;
    }
  });
}

/** Entrar / Criar conta / Esqueci minha senha. */
export function telaLogin({ erro, aviso, aba = 'entrar' } = {}) {
  const estado = { aba };
  const area = h('div', {});

  function desenhar() {
    const msg = h('div', { 'aria-live': 'polite' });
    let form;

    if (estado.aba === 'entrar') {
      const email = h('input', { type: 'email', required: true, autocomplete: 'username', autofocus: true, placeholder: 'voce@empresa.com.br' });
      const senha = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
      const botao = h('button', { class: 'btn btn--primario', type: 'submit' }, 'Entrar');
      form = h('form', { class: 'form' },
        campo('E-mail', email), campo('Senha', senha), botao, msg,
        h('div', { class: 'auth__links' },
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); estado.aba = 'esqueci'; desenhar(); } }, 'Esqueci minha senha')));
      enviar(form, botao, msg, async () => {
        await entrar(email.value, senha.value);
        location.reload();
      });
    } else if (estado.aba === 'criar') {
      const nome = h('input', { type: 'text', required: true, autocomplete: 'name', placeholder: 'Seu nome completo' });
      const email = h('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'voce@empresa.com.br' });
      const senha = h('input', { type: 'password', required: true, autocomplete: 'new-password', minlength: String(SENHA_MINIMA) });
      const senha2 = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
      const botao = h('button', { class: 'btn btn--primario', type: 'submit' }, 'Criar conta');
      form = h('form', { class: 'form' },
        campo('Nome', nome), campo('E-mail', email),
        campo('Senha', senha, `Mínimo ${SENHA_MINIMA} caracteres, com letras e números.`),
        campo('Repita a senha', senha2), botao, msg,
        h('p', { class: 'texto-fraco' },
          'Depois de confirmar o e-mail, um gestor precisa aprovar o seu acesso antes de você ver qualquer dado.'));
      enviar(form, botao, msg, async () => {
        if (!nome.value.trim()) throw new Error('Informe o seu nome.');
        const problema = validarSenha(senha.value);
        if (problema) throw new Error(problema);
        if (senha.value !== senha2.value) throw new Error('As senhas não conferem.');
        const { precisaConfirmar } = await cadastrar({ nome: nome.value, email: email.value, senha: senha.value });
        if (!precisaConfirmar) { location.reload(); return; }
        estado.aba = 'entrar';
        area.replaceChildren(
          h('p', { class: 'auth__ok', role: 'status' },
            `Enviamos um link de confirmação para ${email.value.trim()}. Abra-o neste navegador; depois volte aqui e entre. `
            + 'Se o e-mail não chegar em alguns minutos, olhe o spam.'),
          h('button', { class: 'btn', type: 'button', onclick: () => { desenhar(); } }, 'Ir para o login'));
      });
    } else {
      const email = h('input', { type: 'email', required: true, autocomplete: 'username', autofocus: true });
      const botao = h('button', { class: 'btn btn--primario', type: 'submit' }, 'Enviar link');
      form = h('form', { class: 'form' },
        h('p', { class: 'texto-fraco' }, 'Informe o e-mail da conta. Enviaremos um link para criar uma nova senha.'),
        campo('E-mail', email), botao, msg,
        h('div', { class: 'auth__links' },
          h('a', { href: '#', onclick: (e) => { e.preventDefault(); estado.aba = 'entrar'; desenhar(); } }, 'Voltar ao login')));
      enviar(form, botao, msg, async () => {
        await recuperarSenha(email.value);
        // mesma resposta exista a conta ou não: não revela quais e-mails estão cadastrados
        msg.replaceChildren(h('p', { class: 'auth__ok', role: 'status' },
          'Se existir uma conta com esse e-mail, o link já está a caminho. Abra-o neste navegador.'));
        botao.disabled = false;
        botao.textContent = 'Enviar link';
      });
    }

    const abasEl = estado.aba === 'esqueci'
      ? h('h2', { style: 'margin:16px 0 0;font-size:16px' }, 'Recuperar senha')
      : abas([{ v: 'entrar', label: 'Entrar' }, { v: 'criar', label: 'Criar conta' }], estado.aba,
        (v) => { estado.aba = v; desenhar(); });
    area.replaceChildren(abasEl, form);
  }

  desenhar();
  moldura(
    erro ? h('p', { class: 'auth__erro', role: 'alert' }, erro) : null,
    aviso ? h('p', { class: 'auth__ok', role: 'status' }, aviso) : null,
    h('div', { class: 'auth__cartao' }, area));
}

/** Conta criada e e-mail confirmado, mas ainda sem aprovação de um gestor. */
export function telaPendente(perfil) {
  moldura(h('div', { class: 'auth__cartao', style: 'padding-top:24px' },
    h('h2', { style: 'margin:0;font-size:18px' }, 'Aguardando aprovação'),
    h('p', { class: 'texto' },
      `Sua conta (${perfil.email}) foi criada, mas um gestor ainda precisa liberar o acesso. `
      + 'Avise quem administra o WattScout na sua equipe — assim que for aprovada, é só entrar de novo.'),
    h('div', { class: 'linha-botoes' },
      h('button', { class: 'btn btn--primario', type: 'button', onclick: () => location.reload() }, 'Verificar de novo'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { await sair(); location.reload(); } }, 'Sair'))));
}

/** Depois de abrir o link de "esqueci minha senha": define a nova senha. */
export function telaNovaSenha() {
  const senha = h('input', { type: 'password', required: true, autocomplete: 'new-password', autofocus: true, minlength: String(SENHA_MINIMA) });
  const senha2 = h('input', { type: 'password', required: true, autocomplete: 'new-password' });
  const botao = h('button', { class: 'btn btn--primario', type: 'submit' }, 'Salvar nova senha');
  const msg = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'form' },
    campo('Nova senha', senha, `Mínimo ${SENHA_MINIMA} caracteres, com letras e números.`),
    campo('Repita a nova senha', senha2), botao, msg);
  enviar(form, botao, msg, async () => {
    const problema = validarSenha(senha.value);
    if (problema) throw new Error(problema);
    if (senha.value !== senha2.value) throw new Error('As senhas não conferem.');
    await definirNovaSenha(senha.value);
    limparUrlAuth();
    location.reload();
  });
  moldura(h('div', { class: 'auth__cartao', style: 'padding-top:24px' },
    h('h2', { style: 'margin:0;font-size:18px' }, 'Criar nova senha'), form));
}
