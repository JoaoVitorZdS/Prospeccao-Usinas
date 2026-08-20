# SETUP.md — o que não cabe em código

O front-end é **estático** (sem servidor próprio, sem passo de build — abre
com qualquer servidor HTTP simples), mas os DADOS são reais: `js/db.js` fala
com um projeto Supabase de verdade via `@supabase/supabase-js` (vendorado em
`vendor/`, sem CDN). "Login" ainda é escolher/criar um perfil na primeira vez
que abre — **ainda não há Entra ID configurado** (isso é fase 2, ver seção
"RLS e o que falta para autenticação real" abaixo) — mas os leads, toques,
usinas e empresas já são permanentes e compartilhados entre todos os agentes
e dispositivos, não uma cópia por navegador.

O Vercel entra só como HOSPEDAGEM ESTÁTICA (o repo já vem pronto pra isso —
ver "Deploy no Vercel" abaixo); nada aqui depende das funções server-side dele.

## Rodar localmente

Precisa de um servidor HTTP — módulos ES e service worker **não funcionam**
abrindo `index.html` direto (`file://`). Também precisa de `js/supabase-config.js`
existindo (ver seção seguinte) — sem ele o app mostra "Não consegui iniciar"
na cara, de propósito, em vez de falhar silenciosamente depois.

```bash
cd lex-prospecta
python3 -m http.server 8080
# → http://localhost:8080
```

Qualquer servidor estático serve (`npx serve`, `php -S localhost:8080`, Caddy,
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
   `0003_colunas_faltantes.sql` → `0004_lead_razao_social.sql`.
   As duas últimas existem porque `empresa`/`lead` ganharam campos (enriquecimento
   de CNPJ, dedup por telefone/e-mail, nome direto no lead) depois que
   `0001_init.sql` foi escrito — sem elas, importar a ANEEL ou criar lead em
   Descobrir falha com "column not found".
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
   seção "RLS e o que falta para autenticação real"), e o app não tem passo
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

## RLS e o que falta para autenticação real

`supabase/migrations/0002_fase1_dados_compartilhados.sql` deixa Row Level
Security **ligada** (o Security Advisor do Supabase não reclama de tabela
exposta) mas com políticas **abertas** pra `anon`/`authenticated` — a
publishable key acessa e edita qualquer linha de qualquer tabela. Isso não é
uma chave vazando (ela é pública por design, vai no bundle do navegador de
qualquer forma) — é a MESMA ausência de isolamento por usuário que a versão
100% local já tinha, só que agora sobre dado compartilhado e permanente em
vez de uma cópia por navegador. "Trocar de perfil" na barra superior continua
sendo escolha de UI, não login: qualquer pessoa com a URL do app pode virar
qualquer agente, inclusive gestor.

Isso é fase 1, documentado, não escondido. Fase 2 — real Entra ID (seção 5.6
do plano original) — exige: app registrado no Azure AD como single-tenant,
Azure Tenant URL travada em `https://login.microsoftonline.com/<tenant-id>`
(sem isso o `/common` padrão do Supabase aceita qualquer conta Microsoft do
mundo), claim `xms_edov` no manifest, SMTP próprio (o embutido do Supabase
manda só 2 e-mails/hora), Custom Access Token Hook pro papel viajar no JWT, e
então **substituir as políticas abertas de 0002 por políticas reais** (como
as que `0001_init.sql` já tem escritas — usam `auth.uid()`/`is_gestor()`,
foram desenhadas pra isso desde o início, só não foram ativadas porque
dependem de login de verdade existir). Nada disso dá pra fazer numa sessão de
agente — precisa do tenant Azure AD de vocês e de um fluxo OAuth interativo
no navegador de alguém com permissão de admin.

Quando o Entra ID acontecer: rodar o Security Advisor do Supabase antes de
qualquer go-live (checklist de armadilhas de RLS na seção 5.5 do plano
original), e lembrar que redirect URIs do OAuth precisam ser atualizados
**nos dois lados** (Entra e Supabase → Auth → URL Configuration) sempre que o
domínio mudar — é o bug mais comum de callback quebrado.

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
lex-prospecta/
├─ index.html                      # shell da página — inclui a CSP e o <script> do vendor
├─ manifest.webmanifest             # PWA
├─ sw.js                           # service worker "Nível 0" — hand-rolled, sem build step
├─ vercel.json                      # headers de segurança + cache para deploy real
├─ .vercelignore                    # exclusões extras só pra `vercel deploy` direto do disco
├─ package.json                     # só pra `npm test` — zero dependência de runtime
├─ css/app.css
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
│  └─ views/                        # uma tela por arquivo (inclui conversas.js)
├─ icons/                           # ícones do PWA + gerador Python
├─ etl/amostras/                    # ZIP/CSV reais da ANEEL, para testar sem baixar 110 MB
├─ test/                            # node --test — cobre util/parse/aneel contra dado real
├─ supabase/
│  ├─ migrations/0001_init.sql      # schema base — RLS com auth.uid()/is_gestor(), pronta pra fase 2
│  ├─ migrations/0002_fase1_dados_compartilhados.sql   # RLS aberta pra rodar sem Entra ID (fase 1, atual)
│  ├─ migrations/0003_colunas_faltantes.sql            # colunas de empresa que 0001 não previu
│  ├─ migrations/0004_lead_razao_social.sql            # idem, pra lead
│  └─ seed.sql                       # concessionárias
└─ doc/LIA-legitimo-interesse.md
```
