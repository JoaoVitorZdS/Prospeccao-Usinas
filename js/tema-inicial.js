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

  // iPhone/iPad: o CSS tem ajustes próprios (alvos de toque de 44px, campos a 16px para o Safari não dar zoom,
  // recorte da barra de status). iPadOS se anuncia como Mac — o que denuncia é a tela de toque.
  try {
    var n = window.navigator;
    if (/iphone|ipad|ipod/i.test(n.userAgent) || (n.platform === 'MacIntel' && n.maxTouchPoints > 1)) {
      raiz.setAttribute('data-ios', '');
      if (n.standalone === true || matchMedia('(display-mode: standalone)').matches) raiz.setAttribute('data-standalone', '');
    }
  } catch (e) { /* sem navigator (testes): segue sem os ajustes */ }
})();
