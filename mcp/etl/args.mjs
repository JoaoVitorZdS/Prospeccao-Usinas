// args.mjs — parser mínimo de argumentos de linha de comando: `--chave valor`, `--flag`, `--chave=valor`.

/** Opções declaradas: { chave: 'valor' | 'flag' }. Devolve { opcoes, extras } e recusa chave desconhecida. */
export function lerArgumentos(argv, declaradas) {
  const opcoes = {};
  const extras = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { extras.push(a); continue; }
    const [chave, inline] = a.slice(2).split(/=(.*)/s);
    const tipo = declaradas[chave];
    if (!tipo) throw new Error(`Opção desconhecida: --${chave}. Opções válidas: ${Object.keys(declaradas).map((c) => `--${c}`).join(' ')}`);
    if (tipo === 'flag') { opcoes[chave] = true; continue; }
    const valor = inline ?? argv[++i];
    if (valor == null || valor.startsWith('--')) throw new Error(`A opção --${chave} precisa de um valor.`);
    opcoes[chave] = valor;
  }
  return { opcoes, extras };
}

/** "SP, mg" → ['SP', 'MG'];  "" / undefined → null (sem filtro). */
export function listaMaiuscula(v) {
  if (!v) return null;
  const l = String(v).split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  return l.length ? l : null;
}
