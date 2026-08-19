// supabase-config.js — projeto Supabase real da equipe.
// Committado de propósito: a publishable key é pública por design (RLS é quem
// protege, não o sigilo dela) e o app não tem passo de build pra injetar
// variável de ambiente — sem este arquivo no git, deploy via GitHub
// integration no Vercel (que clona o repo, não lê o disco local) publica o
// app sem conexão nenhuma com o banco.
export const SUPABASE_URL = 'https://qgtqkhjazwlakuvqevao.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_sJauU19YSp8pohVyGxlocA_7VyrXVMh';
