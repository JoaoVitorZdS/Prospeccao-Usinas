-- 0008_empresa_cnpj_aberto.sql — colunas para a Base CNPJ (dados abertos da Receita Federal).
--
-- A importação "Base CNPJ" (app, modo CNPJ) e o servidor MCP (mcp/) trabalham com o cadastro
-- completo do CNPJ: CNAEs secundários, matriz/filial, município e UF da SEDE (separados de
-- `municipio_principal`/`uf_principal`, que são do local da usina vindo da ANEEL) e a procedência
-- do dado. Tudo opcional: importar um CSV pobre não apaga o que já está preenchido.
--
-- Rodar no SQL Editor do Supabase, depois de 0001–0007.

alter table public.empresa
  add column if not exists cnaes_secundarios       text[] default '{}',
  add column if not exists matriz                  boolean,
  add column if not exists data_situacao_cadastral date,
  add column if not exists municipio_sede          text,
  add column if not exists uf_sede                 text,
  add column if not exists fonte_cadastro          text,   -- 'receita_federal' | 'casa_dos_dados' | …
  add column if not exists competencia_cadastro    text;   -- mês da base da Receita (AAAA-MM)

create index if not exists empresa_cnae_principal_idx on public.empresa (cnae_principal);

-- Prospecção mostra, por padrão, só empresas COM usina (as que vieram da ANEEL), maiores primeiro.
-- Com a Base CNPJ entram empresas sem usina; este índice mantém a ordenação padrão rápida.
create index if not exists empresa_com_usina_idx
  on public.empresa (potencia_total_kw desc nulls last) where qtd_usinas > 0;
