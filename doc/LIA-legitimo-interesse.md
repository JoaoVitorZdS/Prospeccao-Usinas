# Relatório de Impacto à Proteção de Dados — Legítimo Interesse
### Prospecção comercial B2B de usinas de geração distribuída (Lex Prospecta)

**Versão 1.0 · elaborado junto com o lançamento do Lex Prospecta.**
**Responsável pela atividade:** equipe comercial de usinas — Alexandria.
**Base legal invocada:** art. 7º, IX, da LGPD (legítimo interesse do controlador).

---

## 1. Descrição da atividade de tratamento

Coleta e tratamento de dados de contato (telefone, e-mail, nome de sócio/contato)
de pessoas jurídicas titulares de usinas de geração distribuída, com a finalidade
de prospecção comercial B2B — oferta de serviços de gestão/comercialização de
energia excedente.

Os dados pessoais tratados (telefone e e-mail de sócio, majoritariamente pessoa
física atuando em nome da empresa) são **dado pessoal mesmo em contexto B2B** —
esse ponto não é ambíguo na LGPD e o tratamento reconhece isso desde o desenho.

## 2. Origem dos dados

| Fonte | Natureza | Base para o uso |
|---|---|---|
| ANEEL — Geração Distribuída (CKAN, `dadosabertos.aneel.gov.br`) | Dado público, licença ODbL | Dado aberto por política pública; recorte PJ, sem PF |
| OpenCNPJ / BrasilAPI | Espelho de dados públicos do CNPJ (Receita Federal) | Cadastro público de pessoa jurídica |
| Planilha legada da equipe | Contato já trabalhado anteriormente | Continuidade de relação comercial já iniciada |
| Colagem/import manual de sites de CNPJ | Dado público de cadastro empresarial | Consulta pontual, feita por humano, em velocidade humana |

**O que este sistema não faz**: não cruza a base para reidentificar titulares
pessoa física — a ANEEL já mascara CPF/nome de PF nesse dataset, e o app usa
exclusivamente o recorte PJ (aberto). Reidentificar sairia de "dado público" e
entraria em tratamento de alto risco, fora do escopo desta atividade.

## 3. Teste de balanceamento (legitimate interest assessment)

**Finalidade legítima**: oferta de serviço a empresas que já operam geração
própria — o produto é relevante especificamente para quem tem usina, não é
prospecção genérica de qualquer CNPJ.

**Necessidade**: não há alternativa menos invasiva para identificar quem tem
usina em operação além de consultar a base pública da ANEEL — é a fonte
primária e oficial desse fato.

**Proporcionalidade e expectativa do titular**: dado de contato empresarial
(telefone comercial, e-mail — majoritariamente institucional/fiscal, não
pessoal) usado para uma oferta relacionada à atividade profissional do titular.
Um titular de usina de geração distribuída, PJ, tem expectativa razoável de ser
contatado por fornecedores do setor de energia.

**Salvaguardas** (o que reduz o impacto ao titular):
- **Sem disparo automatizado.** Toda mensagem é escrita e enviada por uma pessoa,
  no canal dela — não há campanha em massa, nem bot, nem número dedicado a spam.
- **Opt-out em 1 clique, persistente.** Tabela `supressao`, consultada em toda
  ingestão e todo import — quem pede para sair continua fora mesmo depois de
  reimportar a base da ANEEL no mês seguinte.
- **Procedência registrada por linha**: todo contato tem `fonte_enriquecimento`
  e `origem` gravados — a defesa documental deste LIA é auditável registro a
  registro, não uma alegação genérica.
- **Minimização**: não se coleta CPF de contato, nem dado sensível (saúde,
  origem racial, opinião política etc.) — irrelevante para a finalidade.
- **Retenção limitada**: leads sem interação por 12–24 meses são candidatos a
  eliminação/requalificação.

## 4. Direitos do titular

Canal: **privacidade@alexandriabr.com**. SLA de atendimento: **15 dias**.
Direitos garantidos: confirmação de tratamento, acesso, correção, eliminação
(via opt-out, seção acima) e informação sobre uso e compartilhamento.

## 5. Conclusão

O tratamento é considerado compatível com o legítimo interesse do controlador,
observadas as salvaguardas descritas. Este documento deve ser revisto sempre
que a finalidade, a fonte de dados ou o volume de tratamento mudar
materialmente (ex.: inclusão de nova fonte de enriquecimento, ou expansão para
tratamento de dado de PF).

---

*Este é um documento de referência elaborado como parte do plano de produto do
Lex Prospecta. Não substitui orientação jurídica formal — antes de operar em
produção com dado pessoal real, submeta à revisão do time jurídico/DPO da
organização.*
