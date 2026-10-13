/* tema-inicial.js — roda no <head>, ANTES do CSS ser pintado, para a tela não piscar no tema errado.
   Script clássico (não módulo) e sem dependências, de propósito: precisa executar de forma síncrona.
   Faz o mesmo que resolverTema() de js/tema.js; o teste test/tema.test.mjs garante que os dois concordam. */
(function () {
  var tema = 'claro';
  try {
    var pref = localStorage.getItem('wattscout:tema');
    if (pref === 'claro' || pref === 'escuro') tema = pref;
    else if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) tema = 'escuro';
  } catch (e) {
    if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) tema = 'escuro';
  }
  var raiz = document.documentElement;
  raiz.setAttribute('data-tema', tema);
  raiz.style.colorScheme = tema;
})();
