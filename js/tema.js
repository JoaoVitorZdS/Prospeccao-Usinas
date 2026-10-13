// tema.js — tema claro / escuro / automático (segue o sistema).
//
// A preferência fica no localStorage do navegador; o tema JÁ RESOLVIDO ("claro" ou "escuro") vai em
// <html data-tema>, que é o que o CSS lê. Quem pinta antes do primeiro quadro (para a tela não piscar) é o
// js/tema-inicial.js, um script clássico minúsculo no <head>; este módulo cuida do resto: trocar, lembrar e
// acompanhar o sistema quando a preferência é "automático".

export const CHAVE_TEMA = 'wattscout:tema';
export const PREFERENCIAS = ['auto', 'claro', 'escuro'];
export const ROTULO_PREFERENCIA = { auto: 'Automático (segue o sistema)', claro: 'Claro', escuro: 'Escuro' };
// cor da barra do navegador no celular (meta theme-color) — a mesma da barra lateral de cada tema
export const COR_BARRA = { claro: '#0f3d3c', escuro: '#0d1c33' };

/** "auto" + o que o sistema prefere → "claro" | "escuro". Qualquer valor inesperado vira "auto". Pura. */
export function resolverTema(preferencia, sistemaEscuro) {
  if (preferencia === 'claro' || preferencia === 'escuro') return preferencia;
  return sistemaEscuro ? 'escuro' : 'claro';
}

/** auto → claro → escuro → auto. Pura. */
export function proximaPreferencia(atual) {
  const i = PREFERENCIAS.indexOf(atual);
  return PREFERENCIAS[(i + 1) % PREFERENCIAS.length]; // desconhecido (-1) cai em "auto"
}

/** Lê a preferência salva; sem armazenamento (modo privado, bloqueado) ou valor estranho: "auto". */
export function lerPreferencia(armazenamento = globalThis.localStorage) {
  try {
    const v = armazenamento?.getItem(CHAVE_TEMA);
    return PREFERENCIAS.includes(v) ? v : 'auto';
  } catch { return 'auto'; }
}

function salvar(preferencia, armazenamento) {
  try {
    if (preferencia === 'auto') armazenamento?.removeItem(CHAVE_TEMA);
    else armazenamento?.setItem(CHAVE_TEMA, preferencia);
  } catch { /* sem armazenamento: o tema vale só nesta aba, e tudo bem */ }
}

/**
 * Aplica a preferência no documento e devolve o tema resolvido. Os parâmetros existem para o teste rodar sem navegador.
 */
export function aplicarTema(preferencia, {
  documento = globalThis.document, armazenamento = globalThis.localStorage,
  sistemaEscuro = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false, persistir = true,
} = {}) {
  const tema = resolverTema(preferencia, sistemaEscuro);
  const raiz = documento?.documentElement;
  if (raiz) {
    raiz.dataset.tema = tema;
    raiz.dataset.temaPref = preferencia;
    raiz.style.colorScheme = tema;
  }
  const meta = documento?.querySelector?.('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', COR_BARRA[tema]);
  if (persistir) salvar(preferencia, armazenamento);
  return tema;
}

let ouvintes = [];

/** Avisa quando o tema muda (troca manual ou o sistema mudou com a preferência em "automático"). */
export const aoMudarTema = (fn) => { ouvintes.push(fn); return () => { ouvintes = ouvintes.filter((x) => x !== fn); }; };

/** Define a preferência (e avisa quem escuta). */
export function definirPreferencia(preferencia) {
  const tema = aplicarTema(preferencia);
  for (const fn of ouvintes) fn({ preferencia, tema });
  return tema;
}

export const preferenciaAtual = () => lerPreferencia();

/** Alterna auto → claro → escuro. Devolve a nova preferência. */
export function alternarTema() {
  const proxima = proximaPreferencia(preferenciaAtual());
  definirPreferencia(proxima);
  return proxima;
}

/** Liga o acompanhamento do sistema: com a preferência em "automático", trocar o tema do sistema troca o do app. */
export function iniciarTema() {
  const preferencia = lerPreferencia();
  aplicarTema(preferencia, { persistir: false });
  const mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', () => {
    if (lerPreferencia() === 'auto') {
      const tema = aplicarTema('auto', { persistir: false });
      for (const fn of ouvintes) fn({ preferencia: 'auto', tema });
    }
  });
}
