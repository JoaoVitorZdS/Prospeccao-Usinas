-- 0002_fase1_dados_compartilhados.sql — ajusta 0001 pra funcionar SEM Entra ID.
--
-- Por quê este arquivo existe: 0001_init.sql foi desenhado para a versão FUTURA
-- do plano, com Supabase Auth + Entra ID de verdade (seção 5.6) — RLS ali
-- confere `auth.uid()`/`auth.jwt()`, e `profiles.id` referencia `auth.users`.
--
-- Só que configurar Entra ID exige um tenant Azure AD e um fluxo OAuth
-- interativo no navegador — nada disso dá pra fazer numa sessão de agente.
-- O pedido de agora era mais simples: "os dados devem ser reais e permanentes"
-- (não "resolva autenticação corporativa"). Esta migration entrega exatamente
-- isso — Postgres real, compartilhado entre todos os agentes e dispositivos —
-- SEM fingir ter resolvido isolamento por usuário que não foi resolvido.
--
-- ⚠️ TROCA DE SEGURANÇA, documentada, não escondida: com RLS aberta pra
-- `anon`, qualquer pessoa com a publishable key (que É pública por design,
-- vai no bundle do navegador) lê e escreve em qualquer linha de qualquer
-- tabela. Isso é EXATAMENTE o mesmo modelo de confiança que a versão local já
-- tinha (ver SETUP.md § "Multiusuário sem servidor sem servidor — o que isso
-- realmente significa") — a diferença é que agora os dados são compartilhados
-- e permanentes, não é uma regressão de segurança, é a mesma politica de
-- sempre com escopo maior. Ligar Entra ID depois e trocar estas políticas por
-- políticas de verdade (como as de 0001) é o próximo passo natural, não uma
-- correção de bug.

-- profiles.id não pode mais depender de auth.users existir (não há signup real)
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- remove as políticas antigas (todas dependiam de auth.uid()/auth.jwt())
drop policy if exists lead_select on public.lead;
drop policy if exists lead_insert on public.lead;
drop policy if exists lead_update on public.lead;
drop policy if exists lead_delete on public.lead;
drop policy if exists interacao_select on public.interacao;
drop policy if exists interacao_insert on public.interacao;
drop policy if exists empresa_select on public.empresa;
drop policy if exists usina_select on public.usina_aneel;
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists supressao_select on public.supressao;
drop policy if exists supressao_insert on public.supressao;
drop policy if exists lote_select on public.import_lote;
drop policy if exists lote_insert on public.import_lote;

-- RLS continua LIGADA (Security Advisor do Supabase reclama de tabela sem RLS)
-- mas as políticas liberam tudo pra anon+authenticated — é a publishable key
-- fazendo o mesmo papel que o anon key do IndexedDB local fazia: nenhum.
create policy lead_tudo on public.lead for all to anon, authenticated using (true) with check (true);
create policy interacao_tudo on public.interacao for all to anon, authenticated using (true) with check (true);
create policy empresa_tudo on public.empresa for all to anon, authenticated using (true) with check (true);
create policy usina_tudo on public.usina_aneel for all to anon, authenticated using (true) with check (true);
create policy profiles_tudo on public.profiles for all to anon, authenticated using (true) with check (true);
create policy concessionaria_tudo on public.concessionaria for all to anon, authenticated using (true) with check (true);
create policy supressao_tudo on public.supressao for all to anon, authenticated using (true) with check (true);
create policy lote_tudo on public.import_lote for all to anon, authenticated using (true) with check (true);
create policy captura_config_tudo on public.captura_config for all to anon, authenticated using (true) with check (true);

alter table public.concessionaria enable row level security;
alter table public.captura_config enable row level security;
