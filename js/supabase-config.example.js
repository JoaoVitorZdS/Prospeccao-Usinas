// supabase-config.example.js — copie para supabase-config.js e preencha.
//
// supabase-config.js é ignorado pelo git (.gitignore) — não porque a chave seja
// secreta (a publishable key é pública por design, vai no bundle do navegador
// de qualquer forma), mas porque cada ambiente (seu projeto de teste, o
// projeto de produção da equipe) aponta pra um Supabase diferente, e isso não
// deveria estar commitado como se fosse um valor fixo do código.
//
// Onde achar: painel do Supabase → Project Settings → API.
//   SUPABASE_URL  = "Project URL"
//   SUPABASE_KEY  = "anon" / "publishable" key (NUNCA a "service_role"/"secret")

export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx';
