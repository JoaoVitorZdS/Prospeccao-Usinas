// supabase-config.example.js — copie para supabase-config.js e preencha.
//
// Neste repo o supabase-config.js É commitado (o deploy via GitHub precisa dele — ver SETUP.md).
// A publishable key é pública por design: vai no bundle do navegador de qualquer forma e, sozinha,
// não lê nenhuma tabela (o RLS exige login). Use este exemplo como modelo para apontar outro
// projeto Supabase (um de teste, por exemplo).
//
// Onde achar: painel do Supabase → Project Settings → API.
//   SUPABASE_URL  = "Project URL"
//   SUPABASE_KEY  = "anon" / "publishable" key (NUNCA a "service_role"/"secret")

export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_xxxxxxxxxxxxxxxxxxxxxxxx';
