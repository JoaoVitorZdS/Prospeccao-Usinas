-- 0006_auth_rls.sql — login por e-mail/senha (Supabase Auth) e RLS de verdade.
--
-- O que muda: até aqui todas as tabelas tinham política `using (true)` para `anon`
-- (0002) — quem tivesse a chave pública lia e gravava tudo, inclusive virar gestor.
-- Esta migration liga o RLS por usuário:
--   • agente enxerga só os próprios leads e as conversas (interações) desses leads;
--   • gestor/admin enxerga tudo e é o único que muda papéis e situação das contas;
--   • `anon` perde todo acesso às tabelas; só quem fez login (e foi aprovado) entra.
--
-- Como a identidade funciona: `profiles.id` continua sendo o id que `lead.owner_id`,
-- `interacao.agente_id` etc. já referenciam (nada é re-chaveado). Novidade: a coluna
-- `profiles.auth_user_id` liga o perfil ao usuário do Supabase Auth. O app chama
-- `reivindicar_perfil()` depois do login:
--   1. já tem perfil ligado → devolve;
--   2. existe perfil com o mesmo e-mail (já CONFIRMADO no Auth) e sem vínculo → liga
--      e herda papel/ativo (é assim que os agentes atuais "assumem" a carteira);
--   3. senão cria um perfil `agente` com ativo=false — "pendente" até um gestor aprovar.
--   Exceção de bootstrap: se NÃO existe nenhum gestor/admin no banco (instalação
--   nova), a primeira conta confirmada vira gestor ativo.
--
-- Rodar no SQL Editor do Supabase, DEPOIS de 0001–0005 e ANTES de publicar o
-- front novo (o front antigo, que usa `anon`, para de funcionar na hora).
-- Pré-requisito no painel: Authentication → Providers → Email ligado, "Confirm
-- email" LIGADO (sem isso qualquer um assume o perfil de outro pelo e-mail).
--
-- ROLLBACK (emergência): ver bloco comentado no fim do arquivo.

begin;

/* ════════════════ 1. Identidade ════════════════ */

alter table public.profiles
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

create unique index if not exists profiles_email_lower_idx on public.profiles (lower(email));

-- quando uma conta foi aprovada. Distingue "pendente" (ativo=false e nunca aprovada) de
-- "desativada" (ativo=false mas já foi aprovada) na tela de gestão de contas.
alter table public.profiles add column if not exists aprovado_em timestamptz;
update public.profiles set aprovado_em = created_at where ativo and aprovado_em is null;

create table if not exists public.perfil_auditoria (
  id           uuid primary key default gen_random_uuid(),
  perfil_id    uuid not null references public.profiles(id) on delete cascade,
  alterado_por uuid references public.profiles(id) on delete set null,
  campo        text not null check (campo in ('papel', 'ativo')),
  de           text,
  para         text,
  created_at   timestamptz not null default now()
);
create index if not exists perfil_auditoria_perfil_idx on public.perfil_auditoria (perfil_id, created_at desc);

/* ════════════════ 2. Colunas novas (CRUD de listas e "devolver à base") ════════════════ */

alter table public.import_lote
  add column if not exists nome          text,
  add column if not exists descricao     text,
  add column if not exists atualizado_em timestamptz,
  add column if not exists deleted_at    timestamptz;

alter table public.lead
  add column if not exists devolvido_em     timestamptz,
  add column if not exists devolvido_motivo text;

create index if not exists lead_import_lote_idx on public.lead (import_lote_id) where import_lote_id is not null;
create index if not exists lead_owner_idx on public.lead (owner_id) where deleted_at is null;

/* ════════════════ 3. Funções de apoio (security definer, search_path vazio) ════════════════ */

drop function if exists public.is_gestor();   -- versão de 0001 (dependia de claim no JWT); sem uso desde 0002

-- id do perfil do usuário logado — só se a conta está ATIVA (pendente/desativado = null)
create or replace function public.perfil_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id from public.profiles p
  where p.auth_user_id = (select auth.uid()) and p.ativo
  limit 1;
$$;

create or replace function public.eh_gestor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.auth_user_id = (select auth.uid()) and p.ativo and p.papel in ('gestor', 'admin'));
$$;

create or replace function public.usuario_ativo() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select public.perfil_id()) is not null;
$$;

-- Chamada pelo app logo após o login (ver cabeçalho).
create or replace function public.reivindicar_perfil() returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_uid        uuid := auth.uid();
  v_email      text;
  v_confirmado timestamptz;
  v_nome       text;
  v_perfil     public.profiles;
  v_ha_gestor  boolean;
  v_ligou      boolean;
begin
  if v_uid is null then
    raise exception 'não autenticado' using errcode = '28000';
  end if;

  select * into v_perfil from public.profiles where auth_user_id = v_uid;
  if found then return v_perfil; end if;

  select lower(u.email), u.email_confirmed_at,
         coalesce(nullif(u.raw_user_meta_data ->> 'nome', ''), nullif(u.raw_user_meta_data ->> 'name', ''), split_part(u.email, '@', 1))
    into v_email, v_confirmado, v_nome
    from auth.users u where u.id = v_uid;

  if v_confirmado is null then
    raise exception 'confirme o e-mail antes de entrar' using errcode = '42501';
  end if;

  -- perfil já cadastrado com esse e-mail e ainda sem conta: assume (herda papel e situação).
  -- O sinal libera o gatilho profiles_proteger só para este vínculo.
  perform set_config('wattscout.perfil_rpc', '1', true);
  update public.profiles set auth_user_id = v_uid
   where lower(email) = v_email and auth_user_id is null
   returning * into v_perfil;
  v_ligou := found;   -- guarda antes: PERFORM abaixo sobrescreve o FOUND
  perform set_config('wattscout.perfil_rpc', '', true);
  if v_ligou then return v_perfil; end if;

  select exists (select 1 from public.profiles where papel in ('gestor', 'admin')) into v_ha_gestor;

  insert into public.profiles (nome, email, papel, ativo, auth_user_id, aprovado_em)
  values (v_nome, v_email,
          case when v_ha_gestor then 'agente'::public.app_role else 'gestor'::public.app_role end,
          not v_ha_gestor,
          v_uid,
          case when v_ha_gestor then null else now() end)
  returning * into v_perfil;
  return v_perfil;
end;
$$;

-- Proteção das colunas sensíveis de `profiles`: papel, ativo, e-mail e vínculo só mudam
-- pelas RPCs abaixo (que sinalizam a transação) ou direto pelo SQL Editor/service role
-- (auth.uid() nulo). Qualquer UPDATE vindo da API, inclusive de gestor, é barrado aqui.
create or replace function public.profiles_proteger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('wattscout.perfil_rpc', true) = '1' then return new; end if;
  if auth.uid() is null then return new; end if;
  if new.id is distinct from old.id
     or new.papel is distinct from old.papel
     or new.ativo is distinct from old.ativo
     or new.aprovado_em is distinct from old.aprovado_em
     or new.email is distinct from old.email
     or new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'papel, situação e e-mail só mudam pela gestão de contas' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Perfil que já nasce ativo (pré-cadastro do gestor, instalação nova) conta como aprovado agora.
create or replace function public.profiles_aprovado_padrao() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.ativo and new.aprovado_em is null then new.aprovado_em := now(); end if;
  return new;
end;
$$;

drop trigger if exists profiles_aprovado_padrao on public.profiles;
create trigger profiles_aprovado_padrao before insert on public.profiles
  for each row execute function public.profiles_aprovado_padrao();

drop trigger if exists profiles_proteger on public.profiles;
create trigger profiles_proteger before update on public.profiles
  for each row execute function public.profiles_proteger();

-- Gestão de contas: só gestor; nunca deixa o sistema sem gestor ativo; grava auditoria.
create or replace function public.alterar_papel(p_perfil uuid, p_papel public.app_role) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_atual  public.profiles;
  v_antigo text;
  v_quem   uuid := (select public.perfil_id());
begin
  if not (select public.eh_gestor()) then
    raise exception 'apenas gestores alteram papéis' using errcode = '42501';
  end if;
  select * into v_atual from public.profiles where id = p_perfil for update;
  if not found then raise exception 'perfil não encontrado'; end if;
  if v_atual.papel = p_papel then return v_atual; end if;

  if v_atual.papel in ('gestor', 'admin') and p_papel = 'agente' and v_atual.ativo
     and not exists (select 1 from public.profiles
                     where papel in ('gestor', 'admin') and ativo and id <> p_perfil) then
    raise exception 'não é possível rebaixar o último gestor ativo';
  end if;

  v_antigo := v_atual.papel::text;
  perform set_config('wattscout.perfil_rpc', '1', true);
  update public.profiles set papel = p_papel where id = p_perfil returning * into v_atual;
  perform set_config('wattscout.perfil_rpc', '', true);   -- desliga o sinal logo após a escrita
  insert into public.perfil_auditoria (perfil_id, alterado_por, campo, de, para)
  values (p_perfil, v_quem, 'papel', v_antigo, p_papel::text);
  return v_atual;
end;
$$;

create or replace function public.definir_ativo(p_perfil uuid, p_ativo boolean) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_atual public.profiles;
  v_quem  uuid := (select public.perfil_id());
begin
  if not (select public.eh_gestor()) then
    raise exception 'apenas gestores aprovam ou desativam contas' using errcode = '42501';
  end if;
  select * into v_atual from public.profiles where id = p_perfil for update;
  if not found then raise exception 'perfil não encontrado'; end if;
  if v_atual.ativo = p_ativo then return v_atual; end if;

  if v_atual.ativo and not p_ativo and v_atual.papel in ('gestor', 'admin')
     and not exists (select 1 from public.profiles
                     where papel in ('gestor', 'admin') and ativo and id <> p_perfil) then
    raise exception 'não é possível desativar o último gestor ativo';
  end if;

  perform set_config('wattscout.perfil_rpc', '1', true);
  update public.profiles
     set ativo = p_ativo,
         aprovado_em = case when p_ativo then coalesce(aprovado_em, now()) else aprovado_em end
   where id = p_perfil returning * into v_atual;
  perform set_config('wattscout.perfil_rpc', '', true);   -- desliga o sinal logo após a escrita
  insert into public.perfil_auditoria (perfil_id, alterado_por, campo, de, para)
  values (p_perfil, v_quem, 'ativo', (not p_ativo)::text, p_ativo::text);
  return v_atual;
end;
$$;

-- Dedup entre agentes SEM revelar leads alheios: o app manda as chaves candidatas e
-- recebe só quais já existem (e se são do próprio usuário). Sem nome de dono, sem PII.
create or replace function public.checar_duplicados(
  p_cnpjs text[] default '{}', p_tel_keys text[] default '{}', p_email_keys text[] default '{}')
returns table (tipo text, chave text, meu boolean)
language sql stable security definer set search_path = '' as $$
  select 'cnpj'::text, l.cnpj, l.owner_id = (select public.perfil_id())
    from public.lead l
   where (select public.usuario_ativo()) and l.deleted_at is null and l.cnpj = any (p_cnpjs)
  union all
  select 'telefone', l.tel_key, l.owner_id = (select public.perfil_id())
    from public.lead l
   where (select public.usuario_ativo()) and l.deleted_at is null and l.tel_key = any (p_tel_keys)
  union all
  select 'email', l.email_key, l.owner_id = (select public.perfil_id())
    from public.lead l
   where (select public.usuario_ativo()) and l.deleted_at is null and l.email_key = any (p_email_keys);
$$;

-- CNPJs que já têm lead ativo (de qualquer agente) — Prospecção usa para esconder quem já está na carteira de alguém.
create or replace function public.cnpjs_com_lead() returns setof text
language sql stable security definer set search_path = '' as $$
  select distinct l.cnpj from public.lead l
   where (select public.usuario_ativo()) and l.deleted_at is null and l.cnpj is not null;
$$;

-- Opt-out (LGPD) vale para a carteira inteira: o agente que registra a supressão só enxerga os
-- próprios leads, então a marcação nos leads dos colegas precisa rodar com privilégio do dono.
create or replace function public.supressao_aplicar() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.lead
     set opt_out = true, status = 'descartado', status_motivo = 'Opt-out (LGPD)', updated_at = now()
   where deleted_at is null and not opt_out and (
        (new.cnpj is not null and cnpj = new.cnpj)
     or (new.telefone is not null and tel_key = new.telefone)
     or (new.email is not null and email_key = new.email));
  return new;
end;
$$;

drop trigger if exists supressao_aplicar on public.supressao;
create trigger supressao_aplicar after insert on public.supressao
  for each row execute function public.supressao_aplicar();

-- Funções só para quem fez login (PUBLIC e anon perdem o EXECUTE padrão)
do $$
declare f text;
begin
  foreach f in array array[
    'public.perfil_id()', 'public.eh_gestor()', 'public.usuario_ativo()', 'public.reivindicar_perfil()',
    'public.alterar_papel(uuid, public.app_role)', 'public.definir_ativo(uuid, boolean)',
    'public.checar_duplicados(text[], text[], text[])', 'public.cnpjs_com_lead()']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

/* ════════════════ 4. RLS ════════════════ */

-- remove as políticas abertas de 0002/0005
drop policy if exists lead_tudo on public.lead;
drop policy if exists interacao_tudo on public.interacao;
drop policy if exists empresa_tudo on public.empresa;
drop policy if exists usina_tudo on public.usina_aneel;
drop policy if exists profiles_tudo on public.profiles;
drop policy if exists concessionaria_tudo on public.concessionaria;
drop policy if exists supressao_tudo on public.supressao;
drop policy if exists lote_tudo on public.import_lote;
drop policy if exists captura_config_tudo on public.captura_config;
drop policy if exists backlog_tudo on public.backlog;

alter table public.lead enable row level security;
alter table public.interacao enable row level security;
alter table public.empresa enable row level security;
alter table public.usina_aneel enable row level security;
alter table public.profiles enable row level security;
alter table public.concessionaria enable row level security;
alter table public.supressao enable row level security;
alter table public.import_lote enable row level security;
alter table public.captura_config enable row level security;
alter table public.backlog enable row level security;
alter table public.perfil_auditoria enable row level security;

-- profiles: cada um vê a própria linha; gestor vê todas e pré-cadastra e-mails
create policy profiles_select on public.profiles for select to authenticated
  using (auth_user_id = (select auth.uid()) or (select public.eh_gestor()));
create policy profiles_insert on public.profiles for insert to authenticated
  with check ((select public.eh_gestor()) and auth_user_id is null);
create policy profiles_update on public.profiles for update to authenticated
  using (auth_user_id = (select auth.uid()) or (select public.eh_gestor()))
  with check (auth_user_id = (select auth.uid()) or (select public.eh_gestor()));

create policy perfil_auditoria_select on public.perfil_auditoria for select to authenticated
  using ((select public.eh_gestor()));

-- lead: dono ou gestor. Agente não transfere lead (with check amarra o dono a ele mesmo);
-- redistribuir é do gestor. Exclusão física só do gestor ("devolver à base" é soft delete = update).
create policy lead_select on public.lead for select to authenticated
  using ((select public.eh_gestor()) or owner_id = (select public.perfil_id()));
create policy lead_insert on public.lead for insert to authenticated
  with check ((select public.eh_gestor()) or owner_id = (select public.perfil_id()));
create policy lead_update on public.lead for update to authenticated
  using ((select public.eh_gestor()) or owner_id = (select public.perfil_id()))
  with check ((select public.eh_gestor()) or owner_id = (select public.perfil_id()));
create policy lead_delete on public.lead for delete to authenticated
  using ((select public.eh_gestor()));

-- interação (= conversa): só de leads que o usuário enxerga
create policy interacao_select on public.interacao for select to authenticated
  using ((select public.eh_gestor()) or exists (
    select 1 from public.lead l where l.id = interacao.lead_id and l.owner_id = (select public.perfil_id())));
create policy interacao_insert on public.interacao for insert to authenticated
  with check ((select public.eh_gestor()) or (
    agente_id = (select public.perfil_id()) and exists (
      select 1 from public.lead l where l.id = interacao.lead_id and l.owner_id = (select public.perfil_id()))));
create policy interacao_update on public.interacao for update to authenticated
  using ((select public.eh_gestor())) with check ((select public.eh_gestor()));
create policy interacao_delete on public.interacao for delete to authenticated
  using ((select public.eh_gestor()));

-- listas de importação: do criador ou do gestor
create policy lote_select on public.import_lote for select to authenticated
  using ((select public.eh_gestor()) or agente_id = (select public.perfil_id()));
create policy lote_insert on public.import_lote for insert to authenticated
  with check ((select public.eh_gestor()) or agente_id = (select public.perfil_id()));
create policy lote_update on public.import_lote for update to authenticated
  using ((select public.eh_gestor()) or agente_id = (select public.perfil_id()))
  with check ((select public.eh_gestor()) or agente_id = (select public.perfil_id()));
create policy lote_delete on public.import_lote for delete to authenticated
  using ((select public.eh_gestor()) or agente_id = (select public.perfil_id()));

-- empresa: dado de referência compartilhado (o enriquecimento grava, qualquer conta ativa)
create policy empresa_select on public.empresa for select to authenticated
  using ((select public.usuario_ativo()));
create policy empresa_insert on public.empresa for insert to authenticated
  with check ((select public.usuario_ativo()));
create policy empresa_update on public.empresa for update to authenticated
  using ((select public.usuario_ativo())) with check ((select public.usuario_ativo()));
create policy empresa_delete on public.empresa for delete to authenticated
  using ((select public.eh_gestor()));

-- base ANEEL, distribuidoras e backlog: leitura geral, escrita do gestor
create policy usina_select on public.usina_aneel for select to authenticated
  using ((select public.usuario_ativo()));
create policy usina_gestor on public.usina_aneel for all to authenticated
  using ((select public.eh_gestor())) with check ((select public.eh_gestor()));

create policy concessionaria_select on public.concessionaria for select to authenticated
  using ((select public.usuario_ativo()));
create policy concessionaria_gestor on public.concessionaria for all to authenticated
  using ((select public.eh_gestor())) with check ((select public.eh_gestor()));

create policy backlog_select on public.backlog for select to authenticated
  using ((select public.usuario_ativo()));
create policy backlog_gestor on public.backlog for all to authenticated
  using ((select public.eh_gestor())) with check ((select public.eh_gestor()));

create policy captura_config_gestor on public.captura_config for all to authenticated
  using ((select public.eh_gestor())) with check ((select public.eh_gestor()));

-- supressão (opt-out): todos precisam LER (a checagem roda em toda ingestão) e registrar;
-- remover um opt-out é decisão de gestor
create policy supressao_select on public.supressao for select to authenticated
  using ((select public.usuario_ativo()));
create policy supressao_insert on public.supressao for insert to authenticated
  with check ((select public.usuario_ativo()));
create policy supressao_update on public.supressao for update to authenticated
  using ((select public.eh_gestor())) with check ((select public.eh_gestor()));
create policy supressao_delete on public.supressao for delete to authenticated
  using ((select public.eh_gestor()));

/* ════════════════ 5. anon fora ════════════════ */

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

commit;

-- ════════════════ BOOTSTRAP (se precisar) ════════════════
-- Perfis existentes são ligados pelo e-mail CONFIRMADO no primeiro login. Se o e-mail do
-- gestor atual em `profiles` não é o que ele usa para entrar, corrija ANTES dele criar a conta:
--   update public.profiles set email = 'novo@dominio.com' where nome = 'Fulano';
-- Ou promova depois do cadastro (SQL Editor roda como postgres, passa pelo gatilho):
--   update public.profiles set papel = 'gestor', ativo = true where lower(email) = 'fulano@dominio.com';

/* ════════════════ ROLLBACK (volta ao modelo aberto da fase 1) ════════════════
begin;
do $$ declare t text; begin
  foreach t in array array['lead','interacao','empresa','usina_aneel','profiles','concessionaria','supressao','import_lote','captura_config','backlog'] loop
    execute format('drop policy if exists %I on public.%I', t || '_tudo', t);
  end loop;
end $$;
-- apaga TODAS as políticas novas e recria as abertas:
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;
create policy lead_tudo on public.lead for all to anon, authenticated using (true) with check (true);
create policy interacao_tudo on public.interacao for all to anon, authenticated using (true) with check (true);
create policy empresa_tudo on public.empresa for all to anon, authenticated using (true) with check (true);
create policy usina_tudo on public.usina_aneel for all to anon, authenticated using (true) with check (true);
create policy profiles_tudo on public.profiles for all to anon, authenticated using (true) with check (true);
create policy concessionaria_tudo on public.concessionaria for all to anon, authenticated using (true) with check (true);
create policy supressao_tudo on public.supressao for all to anon, authenticated using (true) with check (true);
create policy lote_tudo on public.import_lote for all to anon, authenticated using (true) with check (true);
create policy captura_config_tudo on public.captura_config for all to anon, authenticated using (true) with check (true);
create policy backlog_tudo on public.backlog for all to anon, authenticated using (true) with check (true);
grant all on all tables in schema public to anon;
drop trigger if exists profiles_proteger on public.profiles;
commit;
*/
