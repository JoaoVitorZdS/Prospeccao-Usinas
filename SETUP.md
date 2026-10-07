# SETUP.md — WattScout: o que não cabe em código

O front-end é **estático** (sem servidor próprio, sem passo de build — abre
com qualquer servidor HTTP simples), mas os DADOS são reais: `js/db.js` fala
com um projeto Supabase de verdade via `@supabase/supabase-js` (vendorado em
`vendor/`, sem CDN). O acesso é por **login com e-mail e senha** (Supabase Auth) e o
isolamento dos dados é feito por **RLS no banco**: cada agente vê só os próprios leads
e conversas; gestores veem tudo e são os únicos que mudam papéis de conta (seções
"Login e contas" e "RLS" abaixo). Leads, toques, usinas e empresas são permanentes e
compartilhados entre os dispositivos de quem tem acesso, não uma cópia por navegador.

O Vercel entra só como HOSPEDAGEM ESTÁTICA (o repo já vem pronto pra isso —
ver "Deploy no Vercel" abaixo); nada aqui depende das funções server-side dele.

## Rodar localmente

Precisa de um servidor HTTP — módulos ES e service worker **não funcionam**
abrindo `index.html` direto (`file://`). Também precisa de `js/supabase-config.js`
existindo (ver seção seguinte) — sem ele o app mostra "Não consegui iniciar"
na cara, de propósito, em vez de falhar silenciosamente depois.

```bash
pnpm dev            # ou: npm run dev
# → http://localhost:8080
# outra porta:  pnpm dev -- --port 3000   |   abrir o navegador:  pnpm dev -- --open
```

`pnpm dev` roda `scripts/dev.mjs`: um servidor estático em Node puro (sem dependências, sem
Python), com `Cache-Control: no-store` para você sempre ver a última edição. Só escuta em
127.0.0.1 por padrão. `pnpm test` roda os testes.

Qualquer outro servidor estático também serve (`npx serve`, `php -S localhost:8080`, Caddy,
nginx). Para instalar como PWA de verdade (ícone, standalone, offline), é
preciso HTTPS — em produção, hospede em qualquer provedor estático com TLS
(GitHub Pages, Netlify, Vercel, Cloudflare Pages, um Nginx com Let's Encrypt).
`localhost` é exceção e funciona em HTTP puro para desenvolvimento.

## Configurar o Supabase (obrigatório — o app não funciona sem isto)

1. **Crie o projeto** em [supabase.com](https://supabase.com) se ainda não tiver
   um (plano Pro recomendado — seção 4.3 do plano original explica por quê:
   Free pausa após ~1 semana de inatividade e não tem backup pra download).
2. **Rode as migrations, em ordem.** Painel do Supabase → **SQL Editor** →
   New query. Cole e rode, uma de cada vez, nesta ordem exata (cada uma
   ajusta o que a anterior criou):
   `0001_init.sql` → `0002_fase1_dados_compartilhados.sql` →
   `0003_colunas_faltantes.sql` → `0004_lead_razao_social.sql` →
   `0005_backlog.sql` → `0006_auth_rls.sql` (login e RLS por usuário — **leia a
   seção "Login e contas" antes de rodar**: depois dela o app antigo, que usava a
   chave pública sem login, para de funcionar) → `0007_recasar_distribuidoras.sql`
   (índices e funções para reassociar a distribuidora das usinas — ver "Backlog") →
   `0008_empresa_cnpj_aberto.sql` (colunas da Base CNPJ — ver "Base CNPJ e servidor MCP").
   `0003`/`0004` existem porque `empresa`/`lead` ganharam campos (enriquecimento
   de CNPJ, dedup por telefone/e-mail, nome direto no lead) depois que
   `0001_init.sql` foi escrito — sem elas, importar a ANEEL ou criar lead em
   Descobrir falha com "column not found". `0005` cria a tabela `backlog`
   (consumo por distribuidora ainda sem usina casada — ver seção "Backlog"
   abaixo); sem ela a tela Backlog do app dá erro, o resto funciona.
   (Se um dia autenticar o `supabase` CLI: `supabase link --project-ref <ref> && supabase db push`
   roda todas de uma vez, na ordem dos nomes dos arquivos.)
3. **Rode o seed** das concessionárias: cole `supabase/seed.sql` no SQL Editor
   também. Sem isso `casarConcessionaria()` não tem o que casar — o app ainda
   funciona (fail-open, guarda em `concessionaria_raw`), só fica sem os
   nomes canônicos até você rodar isto.
4. **Pegue a URL e a chave.** Painel → Project Settings → API. `Project URL` é
   `https://<ref>.supabase.co`. A chave é a **anon/public** (ou, na
   nomenclatura nova do Supabase, a que começa com `sb_publishable_...`) —
   **nunca** a `service_role`/`secret`.
5. **`js/supabase-config.js` já está no repo, committado**, apontando pro
   projeto real da equipe. Isso é deliberado, não descuido: a publishable
   key é pública por design (quem protege é o RLS, não o sigilo dela — ver
   seção "RLS — como o isolamento funciona"), e o app não tem passo
   de build pra injetar variável de ambiente. Se você commitasse via
   `.gitignore` como uma "config local", o deploy no Vercel por integração
   com GitHub (o caminho mais comum — Vercel clona do git, não lê o disco de
   quem programou) publicaria o app **sem conexão nenhuma** — foi exatamente
   isso que aconteceu na primeira tentativa de deploy, com um 404 em
   `js/supabase-config.js`. Se quiser apontar pra outro projeto (um Supabase
   de teste separado, por exemplo), edite este arquivo direto ou copie
   `supabase-config.example.js` como referência.
6. **Se o domínio do seu projeto Supabase mudar** (novo projeto, por exemplo),
   atualize o `connect-src` da CSP em DOIS lugares: `index.html` (a `<meta
   http-equiv="Content-Security-Policy">`) e `vercel.json`. Esquecer um dos
   dois faz a CSP bloquear silenciosamente a conexão só em produção (ou só
   em dev) — sintoma confuso, causa simples.

## Gerar os ícones de novo

Os PNGs em `icons/` são gerados por um script Python sem dependências (stdlib
pura — sem Pillow, sem npm):

```bash
python3 icons/gen-icons.py
```

## Testes

`test/` cobre as funções puras (`util.js`, `parse.js`) e a extração de dados da
ANEEL (`aneel.js`) contra **amostras reais** de dado público — não fixture
sintética. `etl/amostras/aneel-gd-amostra.zip` e `etl/amostras/aneel-siga-amostra.csv`
são recortes genuínos baixados de `dadosabertos.aneel.gov.br` em 14/08/2026
(inclusive a mesma ELITE ENGENHARIA LTDA usada como exemplo neste plano — ela
existe de verdade na base da ANEEL). Node 24+ tem `File`/`Blob`/
`DecompressionStream`/`TextDecoderStream` nativos, então o leitor de ZIP roda
no teste exatamente como no navegador, sem mock.

```bash
npm test
# ou: node --test
```

Rode depois de qualquer mudança em `util.js`, `parse.js`, `aneel.js` ou na
lógica de `analisarAneel`/`analisarLeads` em `views/importar.js`. Os dois bugs
mais sutis encontrados nesta versão (mapeamento de coluna trocado por
substring genérico, e um zip cujo `DecompressionStream` recebia bytes demais e
rejeitava como "trailing junk") só apareceram rodando contra dado real — vale
manter esse hábito ao estender o importador.

## Primeiro uso

1. Abra a URL. Como não há usuários cadastrados, a tela pede nome/e-mail/papel
   (gestor ou agente) — isso cria o primeiro `profiles` local.
2. Vá em **Importar** e cole ou arraste a planilha atual (CSV/XLSX). A prévia
   mostra o veredito linha a linha antes de gravar qualquer coisa.
3. Em **Importar → Base da ANEEL**, use os links diretos (não precisa navegar o
   site da ANEEL) ou clique em "Testar com amostra real" para ver o fluxo
   funcionando sem baixar nada. O ZIP da GD (110 MB) pode ser arrastado direto —
   o app descompacta e filtra PJ **em streaming**, sem nunca montar o CSV inteiro
   (~1 GB descomprimido) na memória; só usinas PJ (a imensa maioria é PF e é
   descartada no caminho). O CSV do SIGA baixa pronto, sem precisar de ZIP.
4. Em **Descobrir**, filtre e clique em "Criar leads". Em **Minha fila**, comece
   a abordar pelo cockpit. Em **Conversas**, acompanhe quem está esperando
   resposta — é a mesma base de toques, só que organizada como caixa de entrada
   em vez de lista de tarefas.

## Enriquecimento de contato (OpenCNPJ)

`js/enriquecer.js` chama `api.opencnpj.org` direto do navegador (CORS `*`, sem
custo, sem chave). Isso é ponto único de falha por desenho — é um serviço
comunitário sem SLA (seção 2.3/13.1 do plano). O adaptador já cai para
`brasilapi.com.br` se o OpenCNPJ falhar; se ambos ficarem fora do ar, o
enriquecimento simplesmente não avança até um dos dois voltar. Para acrescentar
uma fonte paga (CNPJá, Casa dos Dados) como terceiro fallback, adicione um
objeto em `PROVEDORES` — a interface é `{ url(cnpj), mapear(json) }`. Se a fonte
paga exigir chave, a chamada precisa sair do navegador (a chave não pode viver
em JS público) e vira uma função de borda/servidor — nesse ponto o projeto já
deixou de ser 100% autocontido nessa peça específica.

## Limites de requisição — por que Descobrir nunca busca a tabela inteira

Depois que a equipe importou um recorte grande da ANEEL (centenas de milhares
de linhas em `empresa`), a tela **Descobrir** ficou lenta e martelando o
Supabase — cada carregamento fazia `todos('empresa')`, que pagina de 1000 em
1000: numa base de ~180 mil empresas isso é ~180 requisições sequenciais **só
pra abrir a tela**, repetido toda vez.

Correção, em `js/db.js`:

- **`todos()` ganhou um teto de segurança** (`TETO_PAGINAS_SEGURANCA`, 30 mil
  linhas) — para de paginar e avisa no console em vez de continuar pra
  sempre. É uma rede de segurança genérica, não a solução principal.
- **`buscarTop(loja, { ordenarPor, limite, filtro })`** — busca ordenada e
  limitada **numa só requisição**. Descobrir usa isto pra pegar só as
  empresas de maior potência (as mais valiosas comercialmente), em vez da
  base inteira. ⚠️ O Supabase tem um teto próprio de linhas por requisição
  (`db-max-rows` do PostgREST, ~1000 por padrão) que vale mesmo pedindo
  `limite` maior — confirmado testando contra o projeto real. O código nunca
  assume que pediu N e recebeu N; sempre confere o que voltou de verdade.
- **UF e distribuidora disparam nova busca no servidor** (`.contains()` na
  coluna array) quando o filtro muda, em vez de só refiltrar o que já estava
  carregado — é como o operador alcança qualquer recorte da base sem baixar
  tudo. Os demais filtros (potência, porte, modalidade, texto) continuam
  client-side sobre o que já foi carregado.
- **`empresasPorCnpj(cnpjs)`** — Painel, Fila e Exportar precisavam só do
  contato/potência dos CNPJs que já viraram lead, não da tabela inteira;
  trocado de `todos('empresa')` para uma busca `.in('cnpj', [...])` nesses
  CNPJs específicos.
- **`agregarEmpresas()` continua sem teto**, de propósito — usa `percorrer()`
  (que não tem o teto de `todos()`) porque precisa ver TODA `usina_aneel`/
  `empresa` pra agregar corretamente; truncar aqui perderia telefone/e-mail
  já enriquecido de quem ficasse de fora do corte.
- **`putMuitos` foi de lotes de 500 pra 2000** — reduz em ~4× o número de
  requisições de um import grande (confirmado: 5.000 linhas em 3
  requisições, ~5s).

Testado contra o projeto real inserindo 5.000 linhas sintéticas por cima das
~180 mil reais (limpo depois, contagem conferida antes e depois pra garantir
que nada real foi apagado): busca ordenada em 1 requisição, filtro por UF
batendo com a contagem real, `taxaPreenchimento()` respondendo em <0,5s via
`contar()` em vez de baixar a tabela.

## Backlog — o mapa de onde faltam usinas

"Backlog" aqui é comercial, não de engenharia: é o consumo (kWh/mês) que a
Alexandria já tem contratado ou em pipeline numa área de concessão e que
**ainda não casou com uma usina geradora na mesma distribuidora**. A
compensação de GD amarra usina e unidade consumidora à mesma distribuidora,
então isso é sempre um problema por distribuidora — não dá pra atender Enel SP
com usina em Minas. Quanto maior a lacuna, mais vale prospectar geração ali.

- **Tabela `backlog`** (`0005_backlog.sql`): uma linha por distribuidora,
  `backlog_kwh_mes` + `nota` + rastro de `atualizado_por`/`atualizado_em`. FK
  pra `concessionaria(codigo)`. RLS aberta pra `anon` como as outras (fase 1).
- **Tela Backlog** (`js/views/backlog.js`, rota `#/backlog`): barras
  ranqueadas por lacuna, KPIs (distribuidoras aguardando, backlog somado,
  maior lacuna) e, por linha, dois links de verdade (`href`, não só clique em JS):
  **"Ver usinas"** — Prospecção filtrada na distribuidora
  (`#/descobrir?conc=<codigo>`) — e **"Ver leads (n)"** — a lista de Leads
  filtrada nela (`#/leads?conc=<codigo>`; gestor vê a equipe toda, agente os
  dele). O nome da distribuidora também abre Prospecção. Gestor edita o valor
  inline (✎) e adiciona distribuidora ("+ Distribuidora"); agente vê só leitura.
  Zerar o valor tira a linha da lista ativa sem apagá-la.
- **Por que "Ver usinas" podia abrir vazio**: o filtro é por *código* de
  distribuidora, mas o código só era gravado em `usina_aneel` no momento da
  importação, quando o nome da ANEEL casava com o cadastro. Usinas importadas
  antes de uma distribuidora entrar no cadastro (como as permissionárias do
  backlog) ficaram sem código e as empresas guardaram o **nome bruto** em
  `empresa.distribuidoras`. Duas correções: o filtro agora aceita também o nome
  e os aliases cadastrados, e o botão **"Reassociar distribuidoras"** (gestor,
  no Mercado e na Prospecção) reprocessa a base já importada (migration 0007).
  O que casa **exatamente** (código, nome ou alias) é ligado sozinho; o que só
  casa de forma aproximada aparece numa lista para o gestor **conferir** antes
  de aplicar (ligar a distribuidora errada é pior do que deixar sem ligar).
- **Prospecção mostra o filtro e o motivo**: chip "Distribuidora: X ✕", link
  "← Voltar ao Mercado" e, se a lista vier vazia, a razão (nenhuma empresa
  associada — com o botão de reassociar —, ou "todas já são leads"; o filtro
  padrão "Esconder quem já é lead" esconde o que a equipe já está trabalhando).
- **Carga inicial**: `BACKLOG_INICIAL` em `js/seed.js` (do levantamento atual)
  + o `insert` em `supabase/seed.sql`. O app semeia sozinho na primeira visita
  à tela (`semearBacklog()`), só com códigos que já existem em `concessionaria`.
- **7 permissionárias novas no cadastro** (Demei, Coopera, Ceres, Cerbranorte,
  Certel, Cooperaliança, Cedrap): apareciam no backlog mas não estavam no
  espelho do titan-helpdesk. Adicionadas a `CONCESSIONARIAS`/`seed.sql`;
  `semearConcessionarias()` passou a preencher só os códigos que faltam num
  banco já populado, em vez de reescrever a lista inteira a cada boot. UF de
  Ceres (coop. de Resende/RJ) e Cedrap (coop. do interior de SP) vale conferir.
- **"Equatorial GO"** do relatório cai em `ENEL-GO` — o cadastro já trata
  `EQUATORIAL GO` como alias de Enel Goiás.

Nada de conversão kWp→kWh nem "% de cobertura por usina": a tela é sobre
*onde* falta e *quanto* falta em números absolutos, e a priorização em
Prospecção continua sendo por potência somada da empresa.

## Base CNPJ e servidor MCP (dados abertos da Receita Federal)

O **Casa dos Dados** exibe o cadastro de CNPJ que a **Receita Federal publica todo mês como dado aberto**. O
WattScout usa essa mesma origem **direto da fonte**, sem raspar o Casa dos Dados (atrás de Cloudflare, com limite
de plano e termos que proíbem raspagem — por isso o app nunca o fez, ver LIA seção 2-A). Duas peças:

1. **Servidor MCP local** (`mcp/`, ver `mcp/README.md`): baixa os zips da Receita, carrega **já filtrados** (CNAE, UF
   ou lista de CNPJs; só empresas ativas) num SQLite no seu computador e expõe ferramentas ao Claude para contar,
   buscar, detalhar e **exportar um CSV**. Pacote separado — o app continua sem dependências de runtime.
2. **Importar → "Base CNPJ (Receita)"** no app: lê esse CSV (ou qualquer exportação parecida) **sem mapeamento
   manual** e grava em `empresa` — sem apagar o que já existe (importar um CSV pobre não zera dado enriquecido nem os
   agregados da ANEEL). Opcionalmente cria os leads das empresas novas, numa lista com nome.

```bash
pnpm --dir mcp install
pnpm --dir mcp baixar -- --sem-socios                       # ~5,1 GB de zips da competência mais recente
pnpm --dir mcp carregar -- --cnae geracao,instalacao --uf SP,MG
# no Claude (com o servidor wattscout-cnpj aprovado): "exporte as geradoras de SP com telefone"
```

- **Rode antes** `supabase/migrations/0008_empresa_cnpj_aberto.sql` (colunas `cnaes_secundarios`, `matriz`,
  `municipio_sede`, `uf_sede`, `fonte_cadastro`, `competencia_cadastro`…). Sem ela a importação avisa qual migration falta.
- **Prospecção** continua mostrando por padrão só empresas **com usina** (as da ANEEL); desmarque "Só empresas com
  usina (ANEEL)" para ver as que vieram só da Base CNPJ.
- **Limites honestos**: não existe CNAE de "energia solar" (usinas se registram em *Geração de energia elétrica*); o
  dono de uma usina de GD costuma ser de qualquer ramo e só aparece pela ANEEL — use `--cnpjs-arquivo` para cruzar os
  CNPJs dos donos de usina com o cadastro da Receita. Telefone/e-mail da Receita são, muitas vezes, do contador.
- **LGPD**: empresário individual/MEI (pessoa física) fica de fora por padrão; CPF de sócio nunca é gravado; a
  importação aplica o opt-out. `mcp/dados/` não vai para o git nem para o deploy.
- O arquivo CSV importado é lido inteiro na memória do navegador: exportações de até algumas dezenas de milhares de
  linhas funcionam bem; para listas maiores, exporte em várias partes (`limite`) ou por UF.

## Backup

Os dados vivem no Supabase agora — plano Pro faz backup diário automático,
isso não é mais responsabilidade do app. **Config → Backup e armazenamento →
Exportar backup** ainda existe, mas serve pra outra coisa: mover dados entre
projetos Supabase (staging → produção), ou um snapshot pontual antes de uma
operação arriscada. Não é mais "a única cópia que existe" — é conveniência.

⚠️ O que ISSO significa pra "Apagar tudo" em Config: não apaga uma cópia
local, apaga o banco Supabase **de verdade**, pra **todos os agentes, em
todos os dispositivos, imediatamente**. O app avisa isso explicitamente na
tela — leia o aviso antes de confirmar, não é retórica de segurança padrão.

Os avisos de iOS sobre o Safari apagar storage local em 7 dias sem instalar
o PWA na Tela de Início **não se aplicam mais aos dados de negócio** (eles
não estão no navegador). Ainda vale instalar o app pra melhor experiência
(ícone, tela cheia), mas não é mais uma questão de perder leads.

## Login e contas (Supabase Auth)

O WattScout entra por e-mail e senha. Ordem para ligar:

1. **Painel do Supabase → Authentication → Providers → Email**: ligado, com **"Confirm email" LIGADO**.
   Sem a confirmação, qualquer pessoa assumiria o perfil de outra só digitando o e-mail dela — a
   migration 0006 só liga conta a perfil por e-mail **confirmado**.
2. **Authentication → URL Configuration**: em *Site URL* ponha o endereço do app em produção e, em
   *Redirect URLs*, adicione `https://SEU-DOMINIO/**` e `http://localhost:8080/**` (para `pnpm dev`).
   Sem isso os links de confirmação e de "esqueci minha senha" caem na página errada.
3. **Authentication → SMTP Settings**: configure um SMTP próprio. O envio embutido do Supabase manda
   pouquíssimos e-mails por hora e a equipe vai esbarrar nele ao criar contas.
4. (Opcional) **Authentication → Policies**: aumente o tamanho mínimo de senha; o app já exige 8
   caracteres com letras e números.
5. **Rode `supabase/migrations/0006_auth_rls.sql`** no SQL Editor e, em seguida, **publique o front** (o
   deploy é pelo GitHub → Vercel). Entre a migration e o deploy o app antigo fica sem acesso; para uma
   equipe pequena é questão de minutos — faça fora do horário de uso.
6. **Rode `supabase/tests/rls_teste.sql`** (SQL Editor): ele monta usuários e leads de mentira, confere
   o isolamento entre agentes, gestor, conta pendente e `anon`, e termina em ROLLBACK (não deixa nada).
   Cada linha `ok:` nas mensagens é uma garantia confirmada; qualquer `FALHOU:` aborta.

### Como cada pessoa entra

- **Quem já era agente/gestor** (perfil já existente em `profiles`): cria a conta com o **mesmo e-mail**
  do cadastro, confirma o e-mail e entra — a carteira de leads e o papel vêm junto, nada se perde.
  Se o e-mail cadastrado não é o que a pessoa usa, corrija antes:
  `update public.profiles set email = 'novo@dominio.com' where nome = 'Fulano';`
- **Quem é novo**: cria a conta, confirma o e-mail e fica em **"Aguardando aprovação"** sem ver dado
  nenhum até um gestor aprovar em *Gestão de contas*. O gestor também pode **pré-cadastrar** o e-mail
  com o papel certo; quando a pessoa criar a conta, já entra liberada.
- **Instalação nova, sem nenhum gestor**: a primeira conta confirmada vira gestor. Se isso não for o
  que você quer, crie o perfil do gestor em `profiles` antes (com o e-mail dele) e só depois abra o app.
- **Leads de quem ainda não criou conta** continuam no banco e ficam visíveis só para gestores (que
  podem redistribuí-los) até a pessoa assumir o perfil.

### O que cada papel pode

| | Agente | Gestor / Administrador |
|---|---|---|
| Ver leads e conversas | só os próprios | todos |
| Meu perfil / trocar senha | sim | sim |
| Aprovar contas, mudar papéis, desativar | não | **sim** (gestão de contas) |
| Redistribuir leads entre agentes | não | sim |
| Importar a base ANEEL, editar backlog e distribuidoras | não | sim |
| Backup, restaurar e apagar tudo | não | sim |

O papel de uma conta só muda pelas funções `alterar_papel` / `definir_ativo` (ficam registradas na tabela
`perfil_auditoria`), o banco recusa mudar o papel por qualquer outro caminho e **nunca deixa o sistema
sem um gestor ativo**.

### Limitações conhecidas

- Os links do e-mail usam PKCE: **abra-os no mesmo navegador** em que pediu o cadastro ou a recuperação.
  Em outro aparelho o e-mail fica confirmado, mas é preciso entrar com a senha (ou pedir novo link).
- Não há login social nem Entra ID — só e-mail e senha. Entra ID continua possível no futuro (a
  `reivindicar_perfil` liga qualquer conta do Supabase Auth pelo e-mail).

## RLS — como o isolamento funciona

`0006_auth_rls.sql` troca as políticas abertas de `0002` por políticas reais e revoga todo acesso de
`anon`. A chave publicável continua pública no bundle (é assim por design), mas sozinha ela não lê
nenhuma tabela: é preciso estar logado **e** aprovado.

- `lead`: dono ou gestor. `interacao` (as conversas): só de leads que a pessoa enxerga.
- `import_lote`: de quem criou ou gestor. `profiles`: a própria linha (gestor vê todas).
- `empresa`, `usina_aneel`, `concessionaria`, `backlog`, `supressao`: leitura para contas ativas;
  escrita da base ANEEL/distribuidoras/backlog só do gestor.
- **Dedup entre agentes** sem vazar leads alheios: as funções `checar_duplicados` e `cnpjs_com_lead`
  respondem só "essa chave já existe" (e se é sua), nunca de quem é nem o conteúdo.
- **Opt-out (LGPD)** vale para a carteira inteira: um gatilho no banco marca como descartado o lead
  correspondente de **qualquer** agente quando uma supressão é registrada.

Se algo der errado logo após a migration, o arquivo traz no fim um bloco **ROLLBACK** comentado que
volta ao modelo aberto anterior (use só em emergência: ele reabre os dados para quem tem a chave).

## Segurança — o que já está feito e o que fica com quem hospeda

**Já no código, testado:**
- **CSP** via `<meta>` em `index.html` (funciona em qualquer host estático,
  mesmo sem controle de headers) — `script-src 'self'`, sem inline, sem `eval`.
  `connect-src` só libera os três destinos reais (Supabase, OpenCNPJ,
  BrasilAPI); qualquer outro `fetch` é bloqueado pelo próprio navegador —
  verificado na prática (um `fetch` de teste para `example.com` foi recusado
  pela CSP, os três de verdade passaram, e uma query real contra o Supabase
  do projeto — antes até da migration existir — voltou o erro esperado do
  Postgres, não um bloqueio de CSP).
- **Sem `innerHTML` em lugar nenhum do app.** `h()` (o helper que monta toda a
  UI) nunca aceita HTML bruto — só `createTextNode`/`setAttribute`. Dado
  importado (CSV/XLSX/colagem, a fonte menos confiável do app) não tem como
  virar markup executável.
- **Todo `target="_blank"` tem `rel="noopener"`** (sem isso, a aba aberta
  ganha acesso de volta à aba original — tabnabbing).
- **Links configuráveis pelo gestor** (Config → Links do cockpit) passam por
  `urlSegura()`: só `http(s)` é aceito como `href`; `javascript:`/`data:`
  colados ali (por engano ou não) caem em `#` em vez de virar um clique que
  executa código.
- **Relatório de impressão** (`exporta.js`) escapa cada campo interpolado —
  nome de lead, descrição, tudo — antes de ir para `document.write()`.
- **CNPJ nunca é "inventado" por padding.** `normCnpj` só completa o caso
  específico de 13 dígitos (Excel comeu 1 zero); qualquer outra contagem curta
  (ex.: fragmento de CPF mascarado da própria ANEEL) devolve `null` em vez de
  virar um CNPJ de 14 dígitos que parece válido e pode deduplicar errado.

**Fica para quem hospeda** (por isso `vercel.json` já vem pronto no repo —
ver seção seguinte): `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, `Permissions-Policy` e HSTS só funcionam como **header HTTP
de verdade**, não como `<meta>` — nenhum navegador honra a versão `<meta>`
dessas diretivas (é limitação da spec, não do código). A CSP do `vercel.json`
repete a do `<meta>` e ainda cobre `frame-ancestors` (que via `<meta>` é
ignorado — o Chrome avisa isso no console de propósito).

## Deploy no Vercel

`vercel.json` já está no repo com os headers acima, `Cache-Control:
no-cache` no `sw.js`/`index.html` (evita demora pra pegar atualização do
service worker) e cache longo/imutável pros ícones. Rotas usam `#/fila` etc.
(hash, não path) — como o fragmento nunca vai pro servidor, **não precisa de
rewrite de SPA**, qualquer host estático serve isto sem configuração especial
de roteamento.

Quando for publicar (login e deploy ficam com você — não algo que se roda por
aqui):

```bash
npx vercel login
npx vercel --prod
```

Antes disso, releia a seção 4.3 do plano: **Vercel Hobby proíbe uso
comercial** em duas cláusulas separadas do ToS — precisa ser plano Pro.

## WhatsApp / "CRM de conversas" — o que existe e o que foi deliberadamente deixado de fora

A tela **Conversas** é uma caixa de entrada sobre os toques já registrados
(`interacao`), ordenada por contato mais recente, com "aguardando resposta há
Xd" e filtro por canal. Isso é o CRM de conversas dentro da regra que o plano
já tinha fixado (seção 3.2): **a ferramenta prepara e registra, nunca envia**.
Não há integração com a API do WhatsApp Business, não há inbox de mensagens de
verdade dentro do app, não há MCP de WhatsApp conectado a nada — de propósito.
As duas razões do plano continuam valendo: prospecção fria por template Meta
pelo número oficial de atendimento arrisca banimento, e enviar automaticamente
aumenta a exposição de LGPD sem necessidade. Se um dia a resposta for
integrar de verdade, a rota é a **WhatsApp Business Cloud API oficial** (exige
App Meta Business verificado, número dedicado, tokens reais — trabalho de
configuração de conta, não de código) — nunca uma biblioteca não-oficial via
QR code do WhatsApp pessoal do agente.

## Estrutura do repo

```
wattscout/
├─ index.html                      # shell da página — inclui a CSP e o <script> do vendor
├─ manifest.webmanifest             # PWA
├─ sw.js                           # service worker "Nível 0" — hand-rolled, sem build step
├─ vercel.json                      # headers de segurança + cache para deploy real
├─ .vercelignore                    # exclusões extras só pra `vercel deploy` direto do disco
├─ package.json                     # só pra `npm test` — zero dependência de runtime
├─ css/wattscout.css                 # sistema visual (casca, componentes) sobre os tokens do Garden
├─ vendor/zendesk-garden/          # tokens de cor do Zendesk Garden (Apache-2.0) + LICENSE e NOTICE
├─ scripts/dev.mjs                 # servidor de desenvolvimento (pnpm dev)
├─ mcp/                            # servidor MCP da base de CNPJ da Receita (pacote separado; ver mcp/README.md)
├─ .mcp.json                       # registra o servidor wattscout-cnpj no Claude Code
├─ vendor/
│  └─ supabase-js-2.112.3.umd.js    # supabase-js vendorado — mantém CSP script-src 'self'
├─ js/
│  ├─ app.js                       # bootstrap, shell, roteamento
│  ├─ db.js                        # camada de dados — fala com Supabase de verdade
│  ├─ supabase-config.js            # COMMITTADO — URL + publishable key real da equipe (não é segredo)
│  ├─ supabase-config.example.js    # template, pra quem quiser apontar pra outro projeto
│  ├─ util.js                      # normalização, CSV, formatação, urlSegura, dataLocal
│  ├─ seed.js                      # vocabulário controlado (status, canais, concessionárias)
│  ├─ parse.js                     # colar/CSV/XLSX → matriz de linhas
│  ├─ aneel.js                      # links diretos, leitor de ZIP em streaming, extração SIGA
│  ├─ enriquecer.js                 # adaptador OpenCNPJ + fallback
│  ├─ exporta.js                    # CSV e relatório de impressão
│  ├─ ui.js                         # primitivas de interface
│  └─ views/                        # uma tela por arquivo (inclui conversas.js, backlog.js)
├─ icons/                           # ícones do PWA + gerador Python
├─ etl/amostras/                    # ZIP/CSV reais da ANEEL, para testar sem baixar 110 MB
├─ test/                            # node --test — cobre util/parse/aneel contra dado real
├─ supabase/
│  ├─ migrations/0001_init.sql      # schema base (as políticas daqui foram substituídas por 0006)
│  ├─ migrations/0002_fase1_dados_compartilhados.sql   # RLS aberta (fase 1) — substituída por 0006
│  ├─ migrations/0003_colunas_faltantes.sql            # colunas de empresa que 0001 não previu
│  ├─ migrations/0004_lead_razao_social.sql            # idem, pra lead
│  ├─ migrations/0005_backlog.sql                      # tabela backlog (consumo por distribuidora sem usina)
│  ├─ migrations/0006_auth_rls.sql                     # login (Supabase Auth) + RLS por usuário + gestão de contas
│  ├─ migrations/0007_recasar_distribuidoras.sql       # reassociar distribuidoras das usinas + índices GIN
│  ├─ migrations/0008_empresa_cnpj_aberto.sql          # colunas da Base CNPJ em empresa
│  ├─ tests/rls_teste.sql            # prova o isolamento (monta usuários de mentira, termina em ROLLBACK)
│  └─ seed.sql                       # concessionárias + carga inicial do backlog
└─ doc/LIA-legitimo-interesse.md
```
