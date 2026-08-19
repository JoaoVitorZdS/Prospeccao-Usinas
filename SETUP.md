# SETUP.md — o que não cabe em código

Esta é a **versão autocontida** do Lex Prospecta descrito em `PLANO-LEX-PROSPECTA.md`:
roda inteira no navegador, sem Supabase, sem Entra ID. Banco = IndexedDB local.
"Login" = escolher/criar um perfil local na primeira vez que abre. Cada
navegador/dispositivo tem sua própria base — não há sincronização entre pessoas.
O Vercel entra só como HOSPEDAGEM ESTÁTICA (o repo já vem pronto para isso —
ver "Deploy no Vercel" abaixo); nada aqui depende das funções server-side dele.

Isso é uma troca deliberada: zero custo recorrente (o plano original previa
~US$ 45/mês de Vercel Pro + Supabase Pro) e zero dependência de infraestrutura,
em troca de não ter RLS de verdade, não ter backup automático e não ter os dados
compartilhados entre a equipe. Se/quando isso virar dor, o caminho de migração
está pronto: `supabase/migrations/0001_init.sql` já tem o schema com RLS, e
`js/db.js` foi escrito para espelhar esse schema campo a campo.

## Rodar localmente

Precisa de um servidor HTTP — módulos ES, IndexedDB e service worker **não
funcionam** abrindo `index.html` direto (`file://`).

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

## Backup

Sem servidor, não existe backup diário automático (o Supabase Pro do plano
original tinha). O substituto é manual: **Config → Backup e armazenamento →
Exportar backup**, que baixa um JSON com todas as tabelas. Faça isso ao fim do
dia, ou antes de qualquer operação arriscada ("Apagar tudo", restaurar outro
backup). Restaurar aceita "substituir" ou "mesclar".

O navegador pode descartar o IndexedDB sob pressão de disco, especialmente se o
site não estiver instalado como app. Clique em "Proteger dados" (chama
`navigator.storage.persist()`) — funciona melhor depois de instalado.

⚠️ **iOS**: o Safari apaga o storage de um site após 7 dias sem acesso, **a
menos que esteja instalado na Tela de Início** (`beforeinstallprompt` não existe
no Safari, então o app mostra um passo a passo manual no primeiro acesso em
iPhone/iPad). Trate isso como obrigatório, não como sugestão, para quem usa
iOS.

## Multiusuário sem servidor — o que isso realmente significa

Não há autenticação real nem Row Level Security. "Trocar de perfil" na barra
superior é uma escolha de UI, não um login: qualquer pessoa com acesso ao
navegador pode abrir o menu e virar outro agente, inclusive gestor. A separação
por `owner_id` organiza o trabalho, não protege dado de ninguém. Se isso for um
problema real (mais de uma pessoa no mesmo dispositivo, ou necessidade de
auditoria de acesso), a resposta certa é migrar para Supabase com Entra ID —
não tentar remendar autenticação no cliente.

## Migrar para o Supabase do plano original

O schema em `supabase/migrations/0001_init.sql` e o seed em `supabase/seed.sql`
já são o Postgres real — RLS incluído. Para ativar:

1. Criar projeto Supabase (Pro — ver seção 4.3 do plano sobre por que Free não
   serve para uso de equipe: pausa após ~1 semana de inatividade e não tem
   backup para download).
2. `supabase link --project-ref <ref> && supabase db push --include-seed`.
3. Configurar Entra ID como provider (seção 5.6 do plano): app single-tenant,
   Azure Tenant URL travada em `https://login.microsoftonline.com/<tenant-id>`
   (sem isso o `/common` padrão aceita qualquer conta Microsoft do mundo),
   claim `xms_edov` no manifest, Before User Created Hook restringindo ao
   domínio corporativo, SMTP próprio (o embutido do Supabase manda só 2
   e-mails/hora).
4. Configurar o Custom Access Token Hook para o papel viajar no JWT (é o que
   torna a policy `is_gestor()` rápida — sem ele, RLS consulta a tabela de
   perfis em toda linha).
5. Escrever a camada de rede em `js/db.js`: hoje toda função ali fala com
   IndexedDB; a versão Supabase troca essas chamadas por `@supabase/supabase-js`
   mantendo a mesma assinatura de função — o resto do app (views, cockpit,
   ui.js) não precisa mudar, porque não conhece o banco por trás.
6. Rodar o Security Advisor do Supabase antes de qualquer go-live. Checklist de
   armadilhas de RLS está na seção 5.5 do plano.

Redirect URIs do OAuth precisam ser atualizados **nos dois lados** (Entra e
Supabase → Auth → URL Configuration) sempre que o domínio mudar — é o bug mais
comum de callback quebrado.

## Segurança — o que já está feito e o que fica com quem hospeda

**Já no código, testado:**
- **CSP** via `<meta>` em `index.html` (funciona em qualquer host estático,
  mesmo sem controle de headers) — `script-src 'self'`, sem inline, sem `eval`.
  `connect-src` só libera os dois destinos reais do enriquecimento (OpenCNPJ,
  BrasilAPI); qualquer outro `fetch` é bloqueado pelo próprio navegador —
  verificado na prática (um `fetch` de teste para `example.com` foi recusado
  pela CSP, os dois de verdade passaram).
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
├─ index.html            # shell da página, monta js/app.js — inclui a CSP
├─ manifest.webmanifest   # PWA
├─ sw.js                 # service worker "Nível 0" — hand-rolled, sem build step
├─ vercel.json            # headers de segurança + cache para deploy real
├─ package.json           # só pra `npm test` — zero dependência de runtime
├─ css/app.css
├─ js/
│  ├─ app.js             # bootstrap, shell, roteamento
│  ├─ db.js              # camada de dados (IndexedDB espelhando o Postgres)
│  ├─ util.js            # normalização, CSV, formatação, urlSegura, dataLocal
│  ├─ seed.js            # vocabulário controlado (status, canais, concessionárias)
│  ├─ parse.js           # colar/CSV/XLSX → matriz de linhas
│  ├─ aneel.js            # links diretos, leitor de ZIP em streaming, extração SIGA
│  ├─ enriquecer.js       # adaptador OpenCNPJ + fallback
│  ├─ exporta.js          # CSV e relatório de impressão
│  ├─ ui.js               # primitivas de interface
│  └─ views/              # uma tela por arquivo (inclui conversas.js)
├─ icons/                 # ícones do PWA + gerador Python
├─ etl/amostras/          # ZIP/CSV reais da ANEEL, para testar sem baixar 110 MB
├─ test/                  # node --test — cobre util/parse/aneel contra dado real
├─ supabase/
│  ├─ migrations/0001_init.sql   # o schema Postgres de referência
│  └─ seed.sql                    # concessionárias
└─ doc/LIA-legitimo-interesse.md
```
