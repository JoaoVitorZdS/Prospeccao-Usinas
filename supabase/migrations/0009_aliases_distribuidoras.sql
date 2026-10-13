-- 0009_aliases_distribuidoras.sql — a ANEEL identifica estas distribuidoras pela RAZÃO SOCIAL, não pela marca.
--
-- Achado ao rodar a base real da ANEEL (GD + SIGA) no `pnpm sincronizar`: quatro nomes de alto volume não
-- casavam com o cadastro e deixavam ~26 mil usinas sem distribuidora (e, portanto, fora do filtro do Backlog):
--
--   COMPANHIA ENERGETICA DO CEARA                 → ENEL-CE        (Enel Distribuição Ceará, ex-Coelce)
--   COMPANHIA ENERGETICA DE PERNAMBUCO            → CELPE          (Neoenergia Pernambuco)
--   NEOENERGIA DISTRIBUICAO BRASILIA S.A.         → CEB-DIS        (Neoenergia Brasília, ex-CEB Distribuição)
--   COMPANHIA DE ELETRICIDADE DO AMAPA CEA        → EQUATORIAL-AP  (Equatorial Amapá, ex-CEA)
--
-- O alias é escrito EXATAMENTE como a ANEEL escreve (o casamento exato compara o texto inteiro, sem acento e
-- pontuação — por isso o "S.A." e o "CEA" no fim). Só ACRESCENTA aliases (nunca remove os que o gestor já cadastrou) e é idempotente. Rodar no SQL Editor do
-- Supabase. Depois: Mercado › "Reassociar distribuidoras" (ou o próximo `pnpm sincronizar`) liga as usinas.

update public.concessionaria c
   set aliases = (select coalesce(array_agg(distinct a order by a), '{}') from unnest(coalesce(c.aliases, '{}') || v.novos) as a)
  from (values
    ('ENEL-CE',       array['COMPANHIA ENERGETICA DO CEARA']),
    ('CELPE',         array['COMPANHIA ENERGETICA DE PERNAMBUCO']),
    ('CEB-DIS',       array['NEOENERGIA DISTRIBUICAO BRASILIA S.A.']),
    ('EQUATORIAL-AP', array['COMPANHIA DE ELETRICIDADE DO AMAPA CEA'])
  ) as v(codigo, novos)
 where c.codigo = v.codigo;
