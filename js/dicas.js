// dicas.js — "hover tags": a etiqueta que aparece ao passar o mouse (ou focar com o teclado) num item do menu,
// para saber qual seção é qual. Qualquer elemento com `data-dica="texto"` ganha uma; `data-dica-lado` escolhe o lado
// (direita | esquerda | baixo | cima; padrão: baixo).
//
// É JavaScript, e não o ::after que havia antes, porque a barra lateral rola (overflow) e cortaria uma etiqueta
// posicionada dentro dela. Aqui a etiqueta mora no <body>, com position: fixed, e escapa de qualquer corte.

const FOLGA = 8;   // distância mínima da borda da janela
const ESPACO = 10; // distância entre o elemento e a etiqueta
const ATRASO_MS = 140;

/**
 * Onde pôr a etiqueta (coordenadas de janela). `alvo` e `dica` são { left, top, width, height }; `janela` é
 * { largura, altura }. Se não couber no lado pedido, vira para o oposto; depois recorta para ficar dentro da janela.
 * Pura — testada.
 */
export function posicionarDica(alvo, dica, janela, lado = 'baixo') {
  const centroX = alvo.left + alvo.width / 2 - dica.width / 2;
  const centroY = alvo.top + alvo.height / 2 - dica.height / 2;
  const posicoes = {
    direita: { left: alvo.left + alvo.width + ESPACO, top: centroY },
    esquerda: { left: alvo.left - dica.width - ESPACO, top: centroY },
    baixo: { left: centroX, top: alvo.top + alvo.height + ESPACO },
    cima: { left: centroX, top: alvo.top - dica.height - ESPACO },
  };
  const oposto = { direita: 'esquerda', esquerda: 'direita', baixo: 'cima', cima: 'baixo' };
  const cabe = (p) => p.left >= FOLGA && p.top >= FOLGA
    && p.left + dica.width <= janela.largura - FOLGA && p.top + dica.height <= janela.altura - FOLGA;
  let final = lado;
  if (!cabe(posicoes[lado]) && cabe(posicoes[oposto[lado]])) final = oposto[lado];
  const p = posicoes[final];
  return {
    lado: final,
    left: Math.round(Math.min(Math.max(p.left, FOLGA), Math.max(FOLGA, janela.largura - dica.width - FOLGA))),
    top: Math.round(Math.min(Math.max(p.top, FOLGA), Math.max(FOLGA, janela.altura - dica.height - FOLGA))),
  };
}

let caixa = null;
let temporizador = null;
let alvoAtual = null;

function garantirCaixa() {
  if (caixa) return caixa;
  caixa = document.createElement('div');
  caixa.className = 'dica';
  caixa.setAttribute('role', 'tooltip');
  caixa.setAttribute('aria-hidden', 'true');
  document.body.append(caixa);
  return caixa;
}

function mostrar(el) {
  const texto = el.getAttribute('data-dica');
  if (!texto) return;
  const c = garantirCaixa();
  c.textContent = texto;
  c.dataset.lado = '';
  c.classList.remove('is-visivel');
  c.style.left = '0px';
  c.style.top = '0px';
  const r = el.getBoundingClientRect();
  const t = c.getBoundingClientRect(); // já com o texto: mede o tamanho real
  const pos = posicionarDica(
    { left: r.left, top: r.top, width: r.width, height: r.height },
    { width: t.width, height: t.height },
    { largura: innerWidth, altura: innerHeight },
    el.getAttribute('data-dica-lado') || 'baixo',
  );
  c.style.left = `${pos.left}px`;
  c.style.top = `${pos.top}px`;
  c.dataset.lado = pos.lado;
  c.classList.add('is-visivel');
  alvoAtual = el;
}

function esconder() {
  clearTimeout(temporizador);
  temporizador = null;
  alvoAtual = null;
  caixa?.classList.remove('is-visivel');
}

/** Liga as etiquetas para a página inteira (delegação de eventos: vale também para o que for criado depois). */
export function instalarDicas() {
  if (instalarDicas.feito) return;
  instalarDicas.feito = true;
  const alvoDe = (e) => e.target?.closest?.('[data-dica]');
  const agendar = (el) => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => { if (el.isConnected) mostrar(el); }, ATRASO_MS);
  };
  // em tela de toque o "mouseover" é simulado pelo toque e a etiqueta ficaria presa na tela; lá o menu já mostra o nome
  const temMouse = () => globalThis.matchMedia?.('(hover: hover)').matches !== false;
  document.addEventListener('mouseover', (e) => {
    if (!temMouse()) return;
    const el = alvoDe(e);
    if (el && el !== alvoAtual) agendar(el);
    else if (!el) esconder();
  });
  document.addEventListener('mouseout', (e) => { if (alvoDe(e) && !alvoDe({ target: e.relatedTarget })) esconder(); });
  // teclado: só quando o foco veio do teclado (clicar num botão não deve deixar a etiqueta presa na tela)
  document.addEventListener('focusin', (e) => { const el = alvoDe(e); if (el && el.matches(':focus-visible')) agendar(el); });
  document.addEventListener('focusout', esconder);
  document.addEventListener('mousedown', esconder, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') esconder(); }, true);
  window.addEventListener('scroll', esconder, true);
  window.addEventListener('resize', esconder);
  window.addEventListener('hashchange', esconder);
}
