# WattScout — servidor MCP da base de CNPJ (Receita Federal)

Filtra e exporta o cadastro de CNPJ que a **Receita Federal publica como dado aberto** — a mesma origem do
[Casa dos Dados](https://casadosdados.com.br/) — **sem usar o sistema deles** (que fica atrás de Cloudflare, com
limite de plano e termos que proíbem raspagem). O Claude consulta uma base local e exporta o CSV que o WattScout
importa em **Importar → Base CNPJ (Receita)**.

```
Receita Federal (dados abertos)  →  etl/baixar.mjs  →  etl/carregar.mjs  →  mcp/dados/cnpj.sqlite
                                                                                   ↓
                                  WattScout ← CSV ← cnpj_exportar ← servidor MCP (stdio) ← Claude
```

Tudo roda no seu computador. Nada é enviado a terceiros.

## Requisitos

- **Node 22.13+** (testado no 24). Usa o `node:sqlite` embutido: sem módulo nativo, sem compilar nada.
- Espaço em disco: o download completo tem ~5,7 GB de zips (a base descomprimida passa de 20 GB, mas **você nunca
  carrega isso** — o filtro acontece durante a leitura). O SQLite final costuma ter de dezenas de MB a alguns GB,
  conforme os filtros.

## 1. Instalar

```bash
pnpm --dir mcp install
```

## 2. Baixar os arquivos da Receita

```bash
pnpm --dir mcp baixar                       # competência mais recente, tudo (~5,7 GB, ~40 min a 2,5 MB/s)
pnpm --dir mcp baixar -- --sem-socios       # sem os 10 arquivos de sócios (−0,5 GB)
pnpm --dir mcp baixar -- --competencia 2026-09
pnpm --dir mcp baixar -- --listar           # só lista meses e arquivos, sem baixar
```

- Fonte: o compartilhamento público oficial da Receita (`arquivos.receitafederal.gov.br`). O endereço antigo
  (`dadosabertos.rfb.gov.br/CNPJ/`) saiu do ar.
- **Retomável**: se a conexão cair, rode de novo — continua do byte onde parou; arquivos completos são pulados.
- Vai para `mcp/dados/downloads/AAAA-MM/` (fora do git).

## 3. Carregar com filtros

```bash
# geradoras, comercializadoras e integradores de SP e MG
pnpm --dir mcp carregar -- --cnae geracao,comercializacao,instalacao --uf SP,MG

# só os CNPJs de uma lista (ex.: donos de usina exportados da base da ANEEL no WattScout)
pnpm --dir mcp carregar -- --cnpjs-arquivo donos-de-usina.csv

# exige ao menos um filtro de carga; a base completa não cabe
```

| Opção | O que faz |
|---|---|
| `--cnae` | Presets (`geracao`, `comercializacao`, `instalacao`, `material`, `rede`), códigos de 7 dígitos ou prefixos. Casa também CNAE **secundário**. |
| `--uf` | Siglas separadas por vírgula. |
| `--cnpjs-arquivo` | `.txt`/`.csv` com CNPJs (um por linha ou 1ª coluna), de 14 dígitos ou o "básico" de 8. |
| `--situacao` | Padrão `02` (ativa). Ex.: `02,03`. |
| `--so-matriz` | Só matrizes. |
| `--incluir-ei` | **Não recomendado.** Mantém empresário individual/MEI (pessoa física). |
| `--sem-socios` | Não carrega sócios. |
| `--baixar` | Baixa antes, se faltar. |
| `--apagar-zips` | Apaga os zips depois de carregar. |

O arquivo é gerado com nome temporário e só vira `mcp/dados/cnpj.sqlite` se tudo terminar bem; se o layout da Receita
mudar (mais de 1% de linhas com número de colunas diferente do esperado), a carga **aborta sem gravar nada**.

### Sobre os CNAEs de energia

**Não existe CNAE específico de energia solar.** Usinas solares empresariais se registram em *Geração de energia
elétrica* (3511-5/01). Mas o dono de uma usina de geração distribuída costuma ser uma empresa de **qualquer ramo**
(agro, comércio, indústria) — esses só aparecem pela base da **ANEEL**, que o WattScout já importa. Por isso:

- filtro por CNAE → acha geradoras, comercializadoras e integradores;
- `--cnpjs-arquivo` / `cnpjs_arquivo` → cruza a lista de donos de usina da ANEEL com o cadastro da Receita
  (CNAE, porte, sócios, contatos).

Os códigos dos presets foram conferidos na tabela oficial de CNAEs (`pnpm --dir mcp` → ferramenta `cnpj_presets`).

## 4. Registrar o servidor no Claude

O repositório já traz o `.mcp.json` na raiz (escopo de projeto). Abra o Claude Code na pasta do projeto e aprove o
servidor `wattscout-cnpj`. Para outro cliente MCP:

```json
{ "mcpServers": { "wattscout-cnpj": { "command": "node", "args": ["--disable-warning=ExperimentalWarning", "D:/caminho/Prospeccao-Usinas/mcp/src/server.mjs"] } } }
```

Variáveis opcionais: `CNPJ_DB` (caminho do SQLite), `CNPJ_DADOS` (pasta de dados), `CNPJ_EXPORT_DIR` (pasta das exportações).

## Ferramentas

| Ferramenta | Para quê |
|---|---|
| `cnpj_status` | Mês da base, filtros usados na carga, contagens. Rode primeiro. |
| `cnpj_presets` | Grupos de CNAE prontos e seus códigos. |
| `cnpj_cnae_buscar` | Procura CNAE por texto ou início do código. |
| `cnpj_municipio_buscar` | Procura município (sem acento); com `uf`, só os que têm empresa na base. |
| `cnpj_contar` | Quantas empresas atendem aos filtros (barato — use antes de exportar). |
| `cnpj_buscar` | Amostra paginada (até 100/página), ordenada por capital social. |
| `cnpj_detalhe` | Cadastro completo de um CNPJ, com CNAEs secundários e sócios (sem CPF). |
| `cnpj_exportar` | Grava o CSV para o WattScout em `mcp/dados/exportacoes/`. |

Filtros (todos combinam em **E**): `cnae` (+ `cnae_modo`), `uf`, `municipio`, `porte`, `natureza`, `capital_min/max`,
`abertura_de/ate`, `matriz`, `com_telefone`, `com_email`, `texto`, `situacao` (padrão: ativa),
`incluir_empresario_individual` (padrão: não) e `cnpjs_arquivo`.

Exemplo de conversa: *"Quantas geradoras ativas há em Minas com capital acima de 500 mil? Exporte as 300 maiores com
telefone, incluindo sócios."* → `cnpj_contar` → `cnpj_exportar` (`limite: 300`, `incluir_socios: true`).

## 5. Importar no WattScout

*Importar → Base CNPJ (Receita)* → arraste o CSV. As colunas são reconhecidas sem mapeamento manual (o contrato é
testado em `test/formato.test.mjs`). Há opções para criar leads das empresas novas e para incluir empresário
individual (desligada). **Antes**, rode a migration `0008_empresa_cnpj_aberto.sql` no Supabase.

## Privacidade e LGPD

- Empresário individual/MEI (natureza 2135) é pessoa física: **fica de fora por padrão**, na carga e na importação.
- O CPF de sócios **não é gravado nem exportado** (só nome, qualificação, entrada e faixa etária).
- A importação aplica a lista de supressão (opt-out) por CNPJ, telefone e e-mail.
- Detalhes e limites no `doc/LIA-legitimo-interesse.md`, seção 2-A.
- `mcp/dados/` está no `.gitignore`: não commite nem publique esses arquivos.

## Testes

```bash
pnpm --dir mcp test
```

Cobrem o layout real da Receita, o leitor de zip (inclusive truncado), a carga ponta a ponta com filtros, as consultas
(com tentativa de SQL injection), o contrato do CSV contra o importador do app e o servidor via cliente MCP stdio.
