-- 0001_init.sql — schema de referência do Lex Prospecta (seção 5 do plano).
--
-- Esta versão do app É AUTOCONTIDA e roda sobre IndexedDB no navegador (js/db.js),
-- não sobre este arquivo. Este DDL fica no repo por dois motivos:
--   1. é o contrato de dados que js/db.js espelha campo a campo — qualquer mudança
--      de schema deveria nascer aqui e ser replicada em db.js, não o contrário;
--   2. é o ponto de partida real se/quando o projeto migrar para Supabase (seção 4/10
--      do plano) ou for traduzido para `hd_prospeccao_*` no titan-helpdesk (seção 12).
--
-- Rodar num projeto Supabase novo:
--   supabase link --project-ref <ref>
--   supabase db push
--
-- Depois disso, RLS (seção 5.5), Auth com Entra ID (seção 5.6) e os hooks descritos
-- no SETUP.md precisam ser configurados no dashboard — não vêm deste arquivo.

create extension if not exists pgcrypto;

create type app_role as enum ('agente', 'gestor', 'admin');
create type lead_status as enum (
  'a_abordar', 'abordado', 'em_conversa', 'qualificado',
  'proposta', 'ganho', 'perdido', 'sem_contato', 'descartado');
create type lead_origem as enum (
  'aneel', 'casa_dos_dados', 'cnpj_biz', 'linkedin', 'whatsapp', 'grupo_whatsapp',
  'facebook', 'google', 'telegram', 'indicacao', 'evento', 'planilha_legada', 'outro');

-- ══ Identidade ═══════════════════════════════════════════════════
create table public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  nome       text not null,
  email      text not null unique,
  papel      app_role not null default 'agente',
  ativo      boolean not null default true,
  created_at timestamptz not null default now()
);

-- ══ Referência ═══════════════════════════════════════════════════
create table public.concessionaria (
  codigo  text primary key,
  nome    text not null,
  uf      text,
  aliases text[] default '{}'
);

-- ══ Fonte externa (espelho ANEEL) ════════════════════════════════
create table public.usina_aneel (
  cod_empreendimento    text primary key,
  cnpj                  text,
  titular               text,
  tipo_consumidor       text,
  distribuidora_nome    text,
  distribuidora_cnpj    text,
  concessionaria_codigo text references public.concessionaria(codigo),
  uf                    text, municipio text, cep text,
  potencia_kw           numeric(14,3),
  tipo_geracao          text,
  porte                 text,
  modalidade            text,
  classe_consumo        text,
  dt_conexao            date,
  fase_usina            text,
  fonte                 text not null,
  ingerido_em           timestamptz not null default now()
);
create index on public.usina_aneel (cnpj) where cnpj is not null;
create index on public.usina_aneel (uf, concessionaria_codigo);
create index on public.usina_aneel (dt_conexao desc);

-- ══ Agregado por CNPJ + enriquecimento ═══════════════════════════
create table public.empresa (
  cnpj                 text primary key check (cnpj ~ '^[0-9]{14}$'),
  razao_social         text, nome_fantasia text,
  situacao_cadastral   text, cnae_principal text, capital_social numeric(18,2),
  porte                text, data_abertura date,
  telefone1            text, telefone2 text, email text,
  socios               jsonb,
  qtd_usinas           int  not null default 0,
  potencia_total_kw    numeric(14,3),
  distribuidoras       text[] default '{}',
  ufs                  text[] default '{}',
  primeira_conexao     date, ultima_conexao date,
  fonte_enriquecimento text,
  enriquecido_em       timestamptz,
  enriquecimento_erro  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.empresa (enriquecido_em nulls first);

-- ══ Lote de importação (referenciado por lead) ═══════════════════
create table public.import_lote (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('colagem', 'planilha', 'extensao', 'aneel', 'manual')),
  agente_id uuid references public.profiles(id),
  arquivo text, total int, criados int, duplicados int, erros int,
  amostra_erro jsonb, created_at timestamptz not null default now()
);

-- ══ Trabalho comercial ═══════════════════════════════════════════
create table public.lead (
  id                    uuid primary key default gen_random_uuid(),
  cnpj                  text references public.empresa(cnpj),
  tipo                  text not null default 'usina_geradora'
                          check (tipo in ('usina_geradora', 'intermediador')),
  origem                lead_origem not null,
  origem_detalhe        text,
  contato_nome          text, contato_cargo text,
  telefone              text, telefone2 text, email text, linkedin_url text,
  status                lead_status not null default 'a_abordar',
  status_motivo         text,
  owner_id              uuid not null references public.profiles(id),
  proxima_acao_em       date,
  primeiro_contato_em   date, ultimo_contato_em date,
  tentativas            int not null default 0,
  concessionaria_codigo text references public.concessionaria(codigo),
  concessionaria_raw    text,
  potencia_kwp          numeric(12,3),
  cep text, cidade text, uf text,
  descricao             text,
  opt_out               boolean not null default false,
  duplicado_de          uuid references public.lead(id),
  import_lote_id        uuid references public.import_lote(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index on public.lead (owner_id, status, proxima_acao_em);
create unique index lead_cnpj_ativo on public.lead (cnpj)
  where deleted_at is null and cnpj is not null;
create index on public.lead (concessionaria_codigo);
create index on public.lead (updated_at desc);

create table public.interacao (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references public.lead(id) on delete cascade,
  agente_id    uuid not null references public.profiles(id),
  canal        text not null check (canal in
                 ('whatsapp', 'linkedin', 'telefone', 'email', 'telegram', 'facebook', 'presencial', 'outro')),
  sentido      text not null default 'saida' check (sentido in ('saida', 'entrada')),
  ocorrido_em  timestamptz not null default now(),
  resultado    text check (resultado in
                 ('sem_resposta', 'respondeu', 'agendou', 'recusou', 'numero_errado', 'pediu_retorno', 'sem_perfil')),
  status_apos  lead_status,
  descricao    text,
  created_at   timestamptz not null default now()
);
create index on public.interacao (lead_id, ocorrido_em desc);

-- ══ Conformidade e operação ══════════════════════════════════════
create table public.supressao (
  id uuid primary key default gen_random_uuid(),
  cnpj text, telefone text, email text,
  motivo text, registrado_por uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  check (cnpj is not null or telefone is not null or email is not null)
);
create unique index on public.supressao (cnpj)     where cnpj is not null;
create unique index on public.supressao (telefone) where telefone is not null;
create unique index on public.supressao (email)    where email is not null;

create table public.captura_config (
  id uuid primary key default gen_random_uuid(),
  site text not null, versao int not null default 1, ativo boolean not null default true,
  config jsonb not null,
  updated_at timestamptz not null default now()
);

-- ══ RLS — agente vê o dele, gestor vê tudo (seção 5.5) ═══════════
create or replace function public.is_gestor() returns boolean
language sql stable security invoker set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'user_role', '') in ('gestor', 'admin');
$$;

alter table public.lead enable row level security;
alter table public.interacao enable row level security;
alter table public.empresa enable row level security;
alter table public.usina_aneel enable row level security;
alter table public.profiles enable row level security;
alter table public.supressao enable row level security;
alter table public.import_lote enable row level security;

create policy lead_select on public.lead for select to authenticated
using ( (select public.is_gestor()) or owner_id = (select auth.uid()) );

create policy lead_insert on public.lead for insert to authenticated
with check ( (select public.is_gestor()) or owner_id = (select auth.uid()) );

create policy lead_update on public.lead for update to authenticated
using      ( (select public.is_gestor()) or owner_id = (select auth.uid()) )
with check ( (select public.is_gestor()) or owner_id = (select auth.uid()) );

create policy lead_delete on public.lead for delete to authenticated
using ( (select public.is_gestor()) );

create policy interacao_select on public.interacao for select to authenticated
using ( (select public.is_gestor()) or exists (
  select 1 from public.lead l where l.id = interacao.lead_id and l.owner_id = (select auth.uid())) );

create policy interacao_insert on public.interacao for insert to authenticated
with check ( exists (
  select 1 from public.lead l where l.id = interacao.lead_id
    and ((select public.is_gestor()) or l.owner_id = (select auth.uid()))) );

-- empresa/usina_aneel/concessionaria: leitura liberada a qualquer autenticado (dado de referência)
create policy empresa_select on public.empresa for select to authenticated using (true);
create policy usina_select on public.usina_aneel for select to authenticated using (true);

-- profiles: cada um vê o próprio e o de todo mundo (nomes não são sensíveis); só gestor edita outros
create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
using ( (select public.is_gestor()) or id = (select auth.uid()) )
with check ( (select public.is_gestor()) or id = (select auth.uid()) );

create policy supressao_select on public.supressao for select to authenticated using (true);
create policy supressao_insert on public.supressao for insert to authenticated with check (true);

create policy lote_select on public.import_lote for select to authenticated
using ( (select public.is_gestor()) or agente_id = (select auth.uid()) );
create policy lote_insert on public.import_lote for insert to authenticated with check (true);

-- ══ Trigger: cria profile ao criar usuário no Auth (padrão oficial Supabase) ══
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, nome, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)), new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
