// views/config.js — configuração e operação (seção 7.G).
// Também é onde mora o que o plano resolveria com Supabase e aqui não existe:
// backup manual, gestão de perfis locais e persistência de armazenamento.

import {
  h, fmtNum, fmtData, fmtDataHora, maskCnpj, maskFone, baixar, nomeArquivo, hojeISO,
} from '../util.js';
import { SCRIPT_PADRAO, PLACEHOLDERS, CONCESSIONARIAS, renderScript } from '../seed.js';
import {
  todos, get, put, remover, getConfig, setConfig, criarPerfil, definirPerfilAtual,
  suprimir, semearConcessionarias, invalidarAliases, exportarBackup, importarBackup,
  apagarTudo, usoArmazenamento, contar,
} from '../db.js';
import {
  cabecalhoPagina, card, toast, confirmar, perguntar, tabela, badge, kpi, vazio,
} from '../ui.js';
import { LINKS_PADRAO } from './cockpit.js';
import { lerArquivo } from '../parse.js';

export async function viewConfig(params, ctxApp) {
  const { perfil, ehGestor, recarregarApp } = ctxApp;
  const raiz = h('div', { class: 'pagina' });

  const [perfis, concessionarias, lotes, supressoes, tpl, links, uso] = await Promise.all([
    todos('profiles'), todos('concessionaria'), todos('import_lote'), todos('supressao'),
    getConfig('script_template', SCRIPT_PADRAO), getConfig('links_externos', LINKS_PADRAO),
    usoArmazenamento(),
  ]);

  /* ═══════════ Script ═══════════ */

  const areaScript = h('textarea', { rows: 12, class: 'mono' }, tpl);
  const preview = h('pre', { class: 'script script--preview' });
  const atualizarPreview = () => {
    preview.textContent = renderScript(areaScript.value, {
      contato_nome: 'Marcos',
      razao_social: 'ELITE ENGENHARIA LTDA',
      cidade: 'Campinas',
      uf: 'SP',
      concessionaria: 'CPFL Paulista',
      potencia: '412,50 kW',
      qtd_usinas: '2',
      cnpj: '12.005.360/0001-65',
      agente: perfil.nome,
    });
  };
  areaScript.addEventListener('input', atualizarPreview);
  atualizarPreview();

  const cardScript = card('Script de abordagem',
    h('p', { class: 'texto-fraco' },
      'Placeholder sem valor vira "_____", nunca "undefined". Vale para todos os agentes.'),
    h('div', { class: 'chips-ph' }, PLACEHOLDERS.map(([p, desc]) =>
      h('button', {
        class: 'chip', title: desc, type: 'button',
        onclick: () => {
          const i = areaScript.selectionStart ?? areaScript.value.length;
          areaScript.value = areaScript.value.slice(0, i) + p + areaScript.value.slice(i);
          areaScript.focus();
          areaScript.selectionStart = areaScript.selectionEnd = i + p.length;
          atualizarPreview();
        },
      }, p))),
    h('div', { class: 'grade-2 grade-2--larga' },
      h('label', { class: 'campo' }, h('span', {}, 'Template'), areaScript),
      h('label', { class: 'campo' }, h('span', {}, 'Prévia com dados de exemplo'), preview)),
    h('div', { class: 'linha-botoes' },
      h('button', {
        class: 'btn btn--primario',
        onclick: async () => {
          await setConfig('script_template', areaScript.value);
          toast('Script salvo.', 'ok');
        },
      }, 'Salvar script'),
      h('button', {
        class: 'btn btn--fantasma',
        onclick: () => { areaScript.value = SCRIPT_PADRAO; atualizarPreview(); },
      }, 'Restaurar padrão')));

  /* ═══════════ Agentes ═══════════ */

  const areaPerfis = h('div', {});
  function desenharPerfis(lista) {
    areaPerfis.replaceChildren(tabela({
      colunas: [
        {
          titulo: 'Nome',
          render: (p) => h('div', { class: 'cel-principal' },
            h('strong', {}, p.nome),
            h('span', {}, p.email)),
        },
        {
          titulo: 'Papel',
          largura: '140px',
          render: (p) => badge(p.papel, p.papel === 'agente' ? 'azul' : 'roxo'),
        },
        {
          titulo: 'Situação',
          largura: '110px',
          render: (p) => (p.ativo ? badge('ativo', 'verde') : badge('inativo', 'cinza')),
        },
        {
          titulo: '',
          largura: '250px',
          render: (p) => h('div', { class: 'linha-botoes linha-botoes--fina' },
            h('button', {
              class: 'btn btn--mini',
              disabled: !ehGestor,
              onclick: async () => {
                const r = await perguntar('Editar agente', [
                  { campo: 'nome', label: 'Nome', valor: p.nome, obrigatorio: true },
                  { campo: 'email', label: 'E-mail', valor: p.email, obrigatorio: true },
                  {
                    campo: 'papel', label: 'Papel', tipo: 'select', valor: p.papel,
                    opcoes: [{ v: 'agente', label: 'agente' }, { v: 'gestor', label: 'gestor' }, { v: 'admin', label: 'admin' }],
                    ajuda: 'Gestor enxerga a carteira de todo mundo.',
                  },
                ]);
                if (!r) return;
                await put('profiles', { ...p, ...r, email: r.email.toLowerCase() });
                toast('Agente atualizado.', 'ok');
                recarregarApp();
              },
            }, 'Editar'),
            h('button', {
              class: 'btn btn--mini',
              disabled: !ehGestor || p.id === perfil.id,
              onclick: async () => {
                await put('profiles', { ...p, ativo: !p.ativo });
                toast(p.ativo ? 'Agente desativado.' : 'Agente reativado.', 'ok');
                recarregarApp();
              },
            }, p.ativo ? 'Desativar' : 'Reativar'),
            p.id !== perfil.id
              ? h('button', {
                class: 'btn btn--mini btn--fantasma',
                onclick: async () => {
                  await definirPerfilAtual(p.id);
                  toast(`Agora você está como ${p.nome}.`, 'ok');
                  recarregarApp();
                },
              }, 'Entrar como')
              : badge('você', 'verde')),
        },
      ],
      linhas: lista,
      aoAbrir: () => {},
    }));
  }
  desenharPerfis(perfis);

  const cardPerfis = card(
    h('div', { class: 'card__cabeca' },
      h('h2', {}, 'Agentes e papéis'),
      h('button', {
        class: 'btn btn--mini btn--primario',
        onclick: async () => {
          const r = await perguntar('Novo agente', [
            { campo: 'nome', label: 'Nome', obrigatorio: true },
            { campo: 'email', label: 'E-mail corporativo', obrigatorio: true },
            {
              campo: 'papel', label: 'Papel', tipo: 'select', valor: 'agente',
              opcoes: [{ v: 'agente', label: 'agente' }, { v: 'gestor', label: 'gestor' }],
            },
          ]);
          if (!r) return;
          await criarPerfil(r);
          toast('Agente criado.', 'ok');
          recarregarApp();
        },
      }, '+ Novo agente')),
    h('p', { class: 'aviso' },
      'Nesta versão autocontida não há login: o "perfil atual" é uma escolha local, e cada '
      + 'navegador tem sua própria base. No plano original isto vira Entra ID + RLS no Supabase, '
      + 'onde o agente realmente não consegue ler o lead do colega. Está detalhado no SETUP.md.'),
    areaPerfis);

  /* ═══════════ Supressão ═══════════ */

  const areaSup = h('div', {});
  function desenharSup(lista) {
    areaSup.replaceChildren(lista.length
      ? tabela({
        colunas: [
          { titulo: 'CNPJ', render: (s) => (s.cnpj ? maskCnpj(s.cnpj) : '—') },
          { titulo: 'Telefone (8 últimos)', render: (s) => s.telefone || '—' },
          { titulo: 'E-mail', render: (s) => s.email || '—' },
          { titulo: 'Motivo', render: (s) => s.motivo || '—' },
          { titulo: 'Registrado em', largura: '150px', render: (s) => fmtDataHora(s.created_at) },
          {
            titulo: '',
            largura: '90px',
            render: (s) => h('button', {
              class: 'btn btn--mini btn--fantasma',
              disabled: !ehGestor,
              onclick: async () => {
                const ok = await confirmar('Remover da supressão',
                  'O titular volta a poder ser prospectado. Só faça isso com registro do consentimento.',
                  { ok: 'Remover', perigo: true });
                if (!ok) return;
                await remover('supressao', s.id);
                toast('Removido da supressão.', 'ok');
                desenharSup((await todos('supressao')));
              },
            }, 'Remover'),
          },
        ],
        linhas: lista,
        aoAbrir: () => {},
      })
      : h('p', { class: 'texto-fraco' }, 'Nenhum opt-out registrado.'));
  }
  desenharSup(supressoes);

  const cardSup = card(
    h('div', { class: 'card__cabeca' },
      h('h2', {}, 'Lista de supressão (opt-out)'),
      h('button', {
        class: 'btn btn--mini',
        onclick: async () => {
          const r = await perguntar('Registrar opt-out', [
            { campo: 'cnpj', label: 'CNPJ', dica: 'só dígitos ou com máscara' },
            { campo: 'telefone', label: 'Telefone' },
            { campo: 'email', label: 'E-mail' },
            { campo: 'motivo', label: 'Motivo', valor: 'Solicitado pelo titular' },
          ]);
          if (!r) return;
          try {
            const reg = await suprimir({ ...r, registrado_por: perfil.id });
            toast(reg ? 'Opt-out registrado.' : 'Já estava na lista.', reg ? 'ok' : 'aviso');
            desenharSup(await todos('supressao'));
          } catch (e) { toast(e.message, 'erro'); }
        },
      }, '+ Registrar')),
    h('p', { class: 'texto-fraco' },
      'Chaveada por CNPJ, telefone (últimos 8 dígitos) e e-mail. Consultada em toda ingestão '
      + 'e em todo import — quem pediu descadastro continua bloqueado depois de reimportar a ANEEL.'),
    areaSup);

  /* ═══════════ Links externos ═══════════ */

  const areaLinks = h('div', { class: 'links-cfg' });
  const linksEditaveis = (links || LINKS_PADRAO).map((l) => ({ ...l }));
  function desenharLinks() {
    areaLinks.replaceChildren(...linksEditaveis.map((l, i) => {
      const chk = h('input', { type: 'checkbox', checked: l.ativo !== false });
      chk.addEventListener('change', () => { l.ativo = chk.checked; });
      const rot = h('input', { type: 'text', value: l.label });
      rot.addEventListener('input', () => { l.label = rot.value; });
      const url = h('input', { type: 'text', value: l.url, class: 'mono' });
      url.addEventListener('input', () => { l.url = url.value; });
      return h('div', { class: 'link-linha' },
        chk, rot, url,
        h('button', {
          class: 'btn btn--mini btn--fantasma',
          onclick: () => { linksEditaveis.splice(i, 1); desenharLinks(); },
        }, '×'));
    }));
  }
  desenharLinks();

  const cardLinks = card('Links de pesquisa do cockpit',
    h('p', { class: 'texto-fraco' },
      'Placeholders: {{cnpj}} · {{cnpj_mask}} · {{razao_enc}} · {{razao_q}} · {{cidade_enc}} · {{uf}}. '
      + 'Se um site mudar a URL, corrige aqui — não precisa mexer em código.'),
    areaLinks,
    h('div', { class: 'linha-botoes' },
      h('button', {
        class: 'btn btn--primario',
        onclick: async () => {
          const ruins = linksEditaveis.filter((l) => l.ativo !== false && !/^https?:\/\//i.test(l.url.trim()));
          if (ruins.length) {
            toast(`Link(s) rejeitado(s) — só http(s) é aceito: ${ruins.map((l) => l.label).join(', ')}`, 'erro', 7000);
            return;
          }
          await setConfig('links_externos', linksEditaveis);
          toast('Links salvos.', 'ok');
        },
      }, 'Salvar links'),
      h('button', {
        class: 'btn',
        onclick: () => { linksEditaveis.push({ label: 'Novo link', url: 'https://', ativo: true }); desenharLinks(); },
      }, '+ Adicionar'),
      h('button', {
        class: 'btn btn--fantasma',
        onclick: () => { linksEditaveis.length = 0; linksEditaveis.push(...LINKS_PADRAO.map((l) => ({ ...l }))); desenharLinks(); },
      }, 'Restaurar padrão')));

  /* ═══════════ Concessionárias ═══════════ */

  const cardConc = card(
    h('div', { class: 'card__cabeca' },
      h('h2', {}, 'Concessionárias'),
      h('span', { class: 'texto-fraco' }, `${concessionarias.length} cadastradas`)),
    h('p', { class: 'texto-fraco' },
      'Mesma lista e mesmos códigos de `hd_oferta_concessionaria` no titan-helpdesk — é o que '
      + 'torna o join trivial se a integração acontecer. Os aliases casam o `NomAgente` da ANEEL '
      + 'com o código canônico; sem match, o texto original é preservado em `concessionaria_raw`.'),
    h('div', { class: 'chips-conc' }, concessionarias.slice(0, 60).map((c) =>
      h('span', { class: 'chip', title: (c.aliases || []).join(' · ') },
        c.codigo, h('em', {}, c.uf || '—')))),
    h('div', { class: 'linha-botoes' },
      h('button', {
        class: 'btn btn--fantasma',
        onclick: async () => {
          const ok = await confirmar('Recarregar concessionárias',
            'Regrava a lista padrão por cima da atual. Códigos e aliases voltam ao original.');
          if (!ok) return;
          const n = await semearConcessionarias(true);
          invalidarAliases();
          toast(`${n} concessionárias recarregadas.`, 'ok');
          recarregarApp();
        },
      }, 'Recarregar lista padrão')));

  /* ═══════════ Lotes de importação ═══════════ */

  const cardLotes = card('Log de importações',
    lotes.length
      ? tabela({
        colunas: [
          { titulo: 'Quando', largura: '150px', render: (l) => fmtDataHora(l.created_at) },
          { titulo: 'Tipo', largura: '110px', render: (l) => badge(l.tipo, 'azul') },
          { titulo: 'Arquivo/origem', render: (l) => l.arquivo || '—' },
          { titulo: 'Total', largura: '80px', alinha: 'dir', render: (l) => fmtNum(l.total) },
          { titulo: 'Criados', largura: '80px', alinha: 'dir', render: (l) => fmtNum(l.criados) },
          { titulo: 'Duplicados', largura: '95px', alinha: 'dir', render: (l) => fmtNum(l.duplicados) },
          { titulo: 'Erros', largura: '75px', alinha: 'dir', render: (l) => fmtNum(l.erros) },
          {
            titulo: 'Amostra de erro',
            render: (l) => ((l.amostra_erro || []).length
              ? h('details', {}, h('summary', {}, `${l.amostra_erro.length} exemplo(s)`),
                h('ul', { class: 'lista-erro' }, l.amostra_erro.map((e) =>
                  h('li', {}, `linha ${e.linha}: ${e.motivo}`))))
              : '—'),
          },
        ],
        linhas: lotes.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        aoAbrir: () => {},
      })
      : h('p', { class: 'texto-fraco' }, 'Nenhuma importação registrada ainda.'));

  /* ═══════════ Backup ═══════════ */

  const inputBackup = h('input', {
    type: 'file', accept: '.json', hidden: true,
    onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const { json } = await lerArquivo(f);
        const substituir = await confirmar('Restaurar backup',
          'Escolha OK para SUBSTITUIR a base atual pelo backup. Cancele e use "Mesclar" se quiser '
          + 'apenas somar os registros do arquivo à base existente.',
          { ok: 'Substituir tudo', perigo: true });
        const resumo = await importarBackup(json, { substituir });
        toast(`Backup restaurado: ${Object.entries(resumo).filter(([, n]) => n)
          .map(([k, n]) => `${k} ${n}`).join(' · ')}`, 'ok', 8000);
        recarregarApp();
      } catch (err) {
        toast(err.message, 'erro', 7000);
      } finally {
        e.target.value = '';
      }
    },
  });

  const pctUso = uso && uso.quota ? (uso.usage / uso.quota) * 100 : null;
  const cardBackup = card('Backup e armazenamento',
    h('p', { class: 'aviso' },
      'Esta versão guarda tudo no IndexedDB DESTE navegador. Não há backup automático, e o '
      + 'navegador pode descartar os dados sob pressão de disco. Exporte o backup ao fim do dia '
      + '— é o equivalente ao backup diário do Supabase Pro previsto no plano.'),
    uso
      ? h('div', { class: 'kpis kpis--fina' },
        kpi('Em uso', `${(uso.usage / 1048576).toFixed(1)} MB`,
          pctUso != null ? `${pctUso.toFixed(1)}% da cota` : ''),
        kpi('Cota do navegador', `${(uso.quota / 1048576).toFixed(0)} MB`),
        kpi('Armazenamento persistente', uso.persistido ? 'sim' : 'não',
          uso.persistido ? 'protegido contra descarte' : 'clique em "Proteger dados"'))
      : null,
    h('div', { class: 'linha-botoes' },
      h('button', {
        class: 'btn btn--primario',
        onclick: async () => {
          const dump = await exportarBackup();
          baixar(new Blob([JSON.stringify(dump)], { type: 'application/json' }),
            nomeArquivo('backup-lex-prospecta', perfil.nome, 'json'), 'application/json');
          toast('Backup gerado.', 'ok');
        },
      }, 'Exportar backup (JSON)'),
      h('button', { class: 'btn', onclick: () => inputBackup.click() }, 'Restaurar backup'),
      h('button', {
        class: 'btn',
        onclick: async () => {
          if (!navigator.storage?.persist) return toast('Navegador não suporta.', 'aviso');
          const ok = await navigator.storage.persist();
          toast(ok ? 'Dados marcados como persistentes.' : 'O navegador negou. Instale o app para melhorar a chance.',
            ok ? 'ok' : 'aviso', 6000);
        },
      }, 'Proteger dados'),
      inputBackup),
    ehGestor
      ? h('div', { class: 'zona-perigo' },
        h('strong', {}, 'Zona de perigo'),
        h('button', {
          class: 'btn btn--perigo btn--mini',
          onclick: async () => {
            const ok = await confirmar('Apagar TODA a base local',
              'Isso apaga leads, interações, usinas, empresas, supressão e perfis deste navegador. '
              + 'Não dá para desfazer. Exporte o backup antes.',
              { ok: 'Apagar tudo', perigo: true });
            if (!ok) return;
            const conf = await perguntar('Confirme digitando', [{
              campo: 'txt', label: 'Digite APAGAR', obrigatorio: true,
            }]);
            if (conf?.txt !== 'APAGAR') return toast('Cancelado.', 'aviso');
            await apagarTudo();
            location.reload();
          },
        }, 'Apagar tudo'))
      : null);

  /* ═══════════ Sobre / lacunas ═══════════ */

  const cardSobre = card('O que esta versão não faz (e por quê)',
    h('ul', { class: 'lista-check' },
      h('li', {}, h('strong', {}, 'Não dispara mensagem. '),
        'Nem WhatsApp, nem e-mail em massa — decisão de produto, não limitação. Protege o número '
        + 'oficial de atendimento e reduz a exposição de LGPD.'),
      h('li', {}, h('strong', {}, 'Não raspa Casa dos Dados nem CNPJ Biz. '),
        'Ambos atrás de Cloudflare; scraping quebra ToS. Viram links de pesquisa pontual no cockpit.'),
      h('li', {}, h('strong', {}, 'Não tem login nem RLS. '),
        'Sem servidor não há como um agente ser impedido de ler o lead do colega. '
        + 'A separação por dono aqui é organização, não segurança.'),
      h('li', {}, h('strong', {}, 'Não sincroniza entre pessoas. '),
        'Cada navegador tem sua base. Para trabalhar em equipe de verdade é preciso o Supabase '
        + 'do plano — o schema já está pronto em supabase/migrations/0001_init.sql.'),
      h('li', {}, h('strong', {}, 'Não ingere os 4,6 milhões de linhas da ANEEL. '),
        'Isso é trabalho de ETL fora do navegador. Importe recortes por UF/distribuidora.')));

  raiz.append(
    cabecalhoPagina('Configuração', 'Script, agentes, supressão, links e operação'),
    cardScript,
    cardPerfis,
    cardSup,
    cardLinks,
    cardConc,
    cardLotes,
    cardBackup,
    cardSobre);
  return raiz;
}
