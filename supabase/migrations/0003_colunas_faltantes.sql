-- 0003_colunas_faltantes.sql — corrige deriva real entre 0001_init.sql e o
-- código que efetivamente roda hoje.
--
-- Como aconteceu: `empresa`/`lead` em 0001_init.sql seguiram o DDL da seção
-- 5.2 do plano original, escrito ANTES do enriquecimento (js/enriquecer.js)
-- e do dedup por telefone/e-mail (js/db.js) ganharem campos que o plano não
-- previa (cnae_descricao, natureza_juridica, logradouro, os agregados de
-- tipo de geração/porte/modalidade/fase da ANEEL, e as chaves de dedup
-- tel_key/email_key). O código evoluiu, a migration não acompanhou — e
-- como IndexedDB não tem schema fixo, isso nunca deu erro até rodar contra
-- Postgres de verdade. Descoberto testando a importação real da ANEEL contra
-- o projeto (erro do PostgREST: "Could not find the 'cep' column of 'empresa'").
--
-- Rodar no SQL Editor do Supabase, depois de 0001 e 0002.

alter table public.empresa
  add column if not exists cep                  text,
  add column if not exists uf_principal          text,
  add column if not exists municipio_principal   text,
  add column if not exists tipos_geracao         text[] default '{}',
  add column if not exists portes                text[] default '{}',
  add column if not exists modalidades           text[] default '{}',
  add column if not exists fases                 text[] default '{}',
  add column if not exists cnae_descricao        text,
  add column if not exists natureza_juridica     text,
  add column if not exists logradouro            text;

alter table public.lead
  add column if not exists tel_key   text,
  add column if not exists email_key text;

-- mesmos índices que o IndexedDB tinha nessas colunas (dedup por telefone/e-mail
-- em acharDuplicado — seção 7.D do plano)
create index if not exists lead_tel_key_idx   on public.lead (tel_key)   where deleted_at is null;
create index if not exists lead_email_key_idx on public.lead (email_key) where deleted_at is null;
create index if not exists empresa_uf_principal_idx on public.empresa (uf_principal);
