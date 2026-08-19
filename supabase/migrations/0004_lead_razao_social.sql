-- 0004_lead_razao_social.sql — mais uma coluna que o código usa e a migration
-- original não previu.
--
-- `lead.razao_social` é usado em todo lugar que mostra/ordena/busca leads
-- (fila, conversas, painel, export, cockpit) — o desenho original (seção 5.2
-- do plano) assumia que o nome da empresa sempre viria de `empresa.razao_social`
-- via join por `cnpj`, mas na prática um lead pode existir sem CNPJ resolvido
-- ainda (import de planilha legada, contato manual) e precisa guardar o nome
-- digitado/importado direto nele. Achado testando a criação de leads a partir
-- de Descobrir contra o projeto real (erro do PostgREST: "Could not find the
-- 'razao_social' column of 'lead'").

alter table public.lead
  add column if not exists razao_social text;
