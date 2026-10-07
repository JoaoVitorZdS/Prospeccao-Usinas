# Relatório de Impacto à Proteção de Dados — Legítimo Interesse
### Prospecção comercial B2B de usinas de geração distribuída (WattScout)

**Versão 1.1 · elaborado junto com o lançamento do WattScout (antes chamado Lex Prospecta); revisado para incluir a Base CNPJ (seção 2-A).**
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
| Base CNPJ — dados abertos da Receita Federal (servidor MCP local, seção 2-A) | Dado aberto oficial, publicação mensal | Cadastro público de pessoa jurídica; sem PF, sem raspagem |

**O que este sistema não faz**: não cruza a base para reidentificar titulares
pessoa física — a ANEEL já mascara CPF/nome de PF nesse dataset, e o app usa
exclusivamente o recorte PJ (aberto). Reidentificar sairia de "dado público" e
entraria em tratamento de alto risco, fora do escopo desta atividade.

## 2-A. Fonte adicional — Base CNPJ (dados abertos da Receita Federal)

Esta revisão registra uma nova fonte, como exige a seção 5: o cadastro de CNPJ que a Receita
Federal publica todo mês como **dado aberto** (arquivos Empresas, Estabelecimentos e Sócios), o mesmo
conjunto que serviços como o Casa dos Dados exibem. O WattScout o lê **direto da fonte oficial**
(compartilhamento público da Receita), sem raspar o Casa dos Dados nem outros sites — o que seria
descumprir os termos deles — e sem enviar dado a terceiros.

**Como é usado.** Um servidor MCP local (`mcp/`) carrega a base **já filtrada na leitura** (apenas
empresas ativas de CNAEs de energia, nas UFs escolhidas, ou apenas uma lista de CNPJs) num SQLite no
computador de quem opera; o Claude consulta esse arquivo e exporta um CSV que é importado em
*Importar → Base CNPJ*. A base completa (dezenas de milhões de registros) **nunca** é carregada.

**Salvaguardas específicas desta fonte:**
- **Pessoa física fora por padrão.** Empresário individual e MEI (natureza jurídica 2135) têm a razão
  social composta pelo nome da pessoa e parte do CPF: são removidos já na carga do SQLite e de novo
  na importação (opção explícita, desligada, para incluí-los). Mantém-se a regra da seção 2: não se
  reidentifica pessoa física.
- **Sócios: só o necessário.** Guarda-se nome, qualificação, data de entrada e faixa etária; o
  documento (CPF/CNPJ mascarado) **não é gravado** nem exportado. A coluna Sócios é opcional na
  exportação (desligada por padrão).
- **Opt-out vale também aqui.** A importação consulta a lista de supressão por CNPJ, telefone e
  e-mail antes de gravar: CNPJ suprimido não entra; contato suprimido é descartado.
- **Procedência registrada.** Cada empresa importada leva `fonte_cadastro` e `competencia_cadastro`
  (mês da base da Receita), e o lote fica na tela Listas.
- **Dado em repouso.** O SQLite fica em `mcp/dados/`, fora do controle de versão e do deploy; os
  CSVs exportados ficam em `mcp/dados/exportacoes/`. Não devem ser enviados por e-mail nem
  compartilhados fora da equipe de prospecção.
- **Finalidade preservada.** Prospecção B2B de empresas do setor de energia, para oferta ligada à
  atividade profissional delas — a mesma da seção 1.

**Limite conhecido.** Telefone e e-mail do cadastro da Receita são, em muitas empresas, de contador ou
pessoais do sócio. O teste de balanceamento da seção 3 continua valendo, e o opt-out é o remédio.
Convém o DPO validar este uso antes de operar em volume.

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
WattScout. Não substitui orientação jurídica formal — antes de operar em
produção com dado pessoal real, submeta à revisão do time jurídico/DPO da
organização.*
