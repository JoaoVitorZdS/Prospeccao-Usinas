-- 0005_backlog.sql — backlog comercial por distribuidora.
--
-- "Backlog" aqui = consumo (kWh/mês) que a Alexandria já tem contratado ou em
-- pipeline numa área de concessão e que AINDA NÃO tem usina geradora casada na
-- MESMA área. A regra da compensação de GD amarra usina e unidade consumidora
-- à mesma distribuidora, então o backlog é sempre por distribuidora — não dá
-- pra "cobrir Enel SP" com uma usina em Minas.
--
-- É o mapa de onde vale a pena prospectar geração: quanto maior a lacuna, mais
-- prioridade. A tela Backlog do app (js/views/backlog.js) lê e edita esta
-- tabela; o botão "Ver usinas" de lá abre Descobrir já filtrado na
-- distribuidora. Carga inicial vem de BACKLOG_INICIAL em js/seed.js (o app
-- semeia sozinho na primeira visita) e do insert em supabase/seed.sql.
--
-- Rodar no SQL Editor do Supabase, depois de 0001–0004.

create table if not exists public.backlog (
  concessionaria_codigo text primary key references public.concessionaria(codigo),
  backlog_kwh_mes       numeric(14,2) not null default 0 check (backlog_kwh_mes >= 0),
  nota                  text,
  atualizado_por        uuid references public.profiles(id),
  atualizado_em         timestamptz not null default now()
);

-- RLS LIGADA com política aberta pra anon/authenticated — mesmo modelo de
-- fase 1 das outras tabelas (ver 0002_fase1_dados_compartilhados.sql): não é
-- isolamento por usuário, é a publishable key fazendo o papel do anon key
-- local. Trocar por política real junto com as outras quando Entra ID entrar.
alter table public.backlog enable row level security;
drop policy if exists backlog_tudo on public.backlog;
create policy backlog_tudo on public.backlog for all to anon, authenticated using (true) with check (true);
