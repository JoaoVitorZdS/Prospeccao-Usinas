-- 0007_recasar_distribuidoras.sql — conserta o filtro por distribuidora (Backlog → Prospecção).
--
-- O problema: `usina_aneel.concessionaria_codigo` só é preenchido NA HORA da importação, quando o
-- nome da distribuidora (NomAgente da ANEEL) casa com o cadastro. Usinas importadas antes de uma
-- distribuidora entrar no cadastro (ex.: as permissionárias do backlog) ficaram sem código, e
-- `empresa.distribuidoras` guardou o nome bruto em vez do código. O botão do Backlog filtra por
-- código, então voltava vazio. Aqui ficam as funções que o app usa para reassociar o que já está
-- no banco, e os índices que deixam o filtro rápido numa base grande.
--
-- Rodar no SQL Editor do Supabase, depois de 0006.

-- Filtros de Prospecção (`ufs @> '{SP}'`, `distribuidoras && '{…}'`) varriam a tabela inteira.
create index if not exists empresa_distribuidoras_gin on public.empresa using gin (distribuidoras);
create index if not exists empresa_ufs_gin            on public.empresa using gin (ufs);

-- Só as usinas ainda sem código — encolhe à medida que a reassociação avança.
create index if not exists usina_aneel_sem_codigo_idx
  on public.usina_aneel (distribuidora_nome) where concessionaria_codigo is null;

-- Nomes de distribuidora que ainda não casaram com nenhum código, com a quantidade de usinas.
-- security invoker: respeita o RLS (todo usuário ativo lê usina_aneel).
create or replace function public.distribuidoras_sem_codigo()
returns table (nome text, qtd bigint)
language sql stable security invoker set search_path = '' as $$
  select u.distribuidora_nome, count(*)
    from public.usina_aneel u
   where u.concessionaria_codigo is null and u.distribuidora_nome is not null
   group by 1
   order by 2 desc;
$$;

-- Liga um lote de usinas (as que têm este nome e ainda estão sem código) ao código informado.
-- Devolve quantas ligou; o app chama em laço até voltar menos que o limite (cada chamada é curta,
-- para não estourar o statement_timeout da API). security invoker: só o gestor escreve em
-- usina_aneel (RLS), então para os demais devolve 0 sem alterar nada.
create or replace function public.recasar_usinas(p_nome text, p_codigo text, p_limite int default 20000)
returns int
language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  with alvo as (
    select cod_empreendimento from public.usina_aneel
     where distribuidora_nome = p_nome and concessionaria_codigo is null
     limit greatest(p_limite, 1))
  update public.usina_aneel u set concessionaria_codigo = p_codigo
    from alvo where u.cod_empreendimento = alvo.cod_empreendimento;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.distribuidoras_sem_codigo() from public, anon;
revoke all on function public.recasar_usinas(text, text, int) from public, anon;
grant execute on function public.distribuidoras_sem_codigo() to authenticated;
grant execute on function public.recasar_usinas(text, text, int) to authenticated;
