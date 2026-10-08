// views/lead.js — a página do lead (#/lead/<id>): campos à esquerda, registro de contato e
// histórico no centro, widgets (script, empresa, usinas, sócios) à direita.
//
// É o mesmo cockpit da gaveta (views/cockpit.js) montado em três colunas: a lógica de abordagem,
// as ações e o atalho de teclado são compartilhados; aqui só decidimos onde cada seção aparece.

import {
  h, maskCnpj, maskFone, fmtData, fmtDataHora, fmtPotencia, fmtNum, urlSegura,
} from '../util.js';
import { statusLabel, origemLabel } from '../seed.js';
import { get } from '../db.js';
import {
  cabecalhoPagina, card, badge, badgeStatus, breadcrumb, menuSuspenso, icone, vazio, navegar,
} from '../ui.js';
import { criarCockpit } from './cockpit.js';

const par = (rotulo, valor) => (valor == null || valor === ''
  ? null
  : [h('dt', {}, rotulo), h('dd', {}, valor)]);

export async function viewLead(params, ctxApp) {
  const { perfil } = ctxApp;
  const id = params._resto;
  const lead = id ? await get('lead', id) : null;
  if (!lead) {
    return h('div', { class: 'pagina' },
      breadcrumb([{ label: 'Leads', rota: 'leads' }, { label: 'Lead não encontrado' }]),
      vazio('Lead não encontrado',
        'Ele pode ter sido excluído ou estar na carteira de outro agente — cada agente vê só os próprios leads.',
        h('a', { class: 'btn btn--primario', href: '#/leads' }, 'Voltar para Leads')));
  }

  const raiz = h('div', { class: 'pagina' });
  const colEsq = h('aside', { class: 'col-campos' });
  const colMeio = h('div', { class: 'col-centro' });
  const colDir = h('aside', { class: 'col-widgets' });
  const cabeca = h('div', {});

  const cockpit = await criarCockpit({
    lead, perfil,
    aoSair: () => navegar('leads'),
  });

  function compor(s, ctx) {
    const { d, empresa, atual, nomeAgente, mapaConc, nomeLista, acoes, ehGestor } = ctx;

    /* ── cabeçalho: migalhas, título, ações ── */
    const principais = acoes.filter((a) => ['editar', 'completar', 'concluir', 'devolver'].includes(a.id));
    const secundarias = acoes.filter((a) => !principais.includes(a) && (!a.soGestor || ehGestor));
    const botaoMais = h('button', { class: 'btn', type: 'button' }, icone('seta', { tamanho: 'peq' }), 'Mais');
    cabeca.replaceChildren(
      breadcrumb([{ label: 'Leads', rota: 'leads' }, { label: d.razao || d.contato || 'Lead' }]),
      cabecalhoPagina(
        d.razao || d.contato || 'Lead sem nome',
        [d.cnpj ? maskCnpj(d.cnpj) : 'sem CNPJ', [d.cidade, d.uf].filter(Boolean).join('/')].filter(Boolean).join(' · '),
        ...principais.map((a) => h('button', {
          class: `btn${a.id === 'concluir' ? ' btn--primario' : ''}`, type: 'button', onclick: a.executar,
        }, a.rotulo)),
        menuSuspenso(botaoMais, secundarias.map((a) => ({ rotulo: a.rotulo, perigo: a.perigo, onclick: a.executar })))),
      h('div', { class: 'cockpit__meta' },
        badgeStatus(atual.status),
        badge(origemLabel(atual.origem), 'azul'),
        badge(atual.tipo === 'intermediador' ? 'Intermediador' : 'Usina', 'roxo'),
        atual.deleted_at ? badge('DEVOLVIDO À BASE', 'ambar') : null,
        atual.opt_out ? badge('OPT-OUT', 'vermelho') : null));

    /* ── esquerda: campos do lead ── */
    colEsq.replaceChildren(
      card('Contato', h('dl', { class: 'dl' },
        par('Nome', atual.contato_nome), par('Cargo', atual.contato_cargo),
        par('Telefone', d.telefone ? maskFone(d.telefone) : null),
        par('Telefone 2', d.telefone2 ? maskFone(d.telefone2) : null),
        par('E-mail', d.email),
        atual.linkedin_url
          ? [h('dt', {}, 'LinkedIn'), h('dd', {}, h('a', { href: urlSegura(atual.linkedin_url), target: '_blank', rel: 'noopener' }, 'abrir perfil'))]
          : null,
        par('CEP', d.cep), par('Cidade/UF', [d.cidade, d.uf].filter(Boolean).join('/')))),
      card('Usina e distribuidora', h('dl', { class: 'dl' },
        par('Distribuidora', d.conc),
        par('Potência', d.potencia == null ? null : fmtPotencia(d.potencia)),
        par('Tipo', atual.tipo === 'intermediador' ? 'Intermediador' : 'Usina geradora'),
        par('Origem', origemLabel(atual.origem)),
        par('Detalhe da origem', atual.origem_detalhe),
        par('Observações', atual.descricao))),
      card('Acompanhamento', h('dl', { class: 'dl' },
        par('Status', statusLabel(atual.status)),
        par('Motivo', atual.status_motivo),
        par('Tentativas', String(atual.tentativas || 0)),
        par('Último contato', fmtData(atual.ultimo_contato_em)),
        par('Próxima ação', fmtData(atual.proxima_acao_em)),
        par('Dono', nomeAgente.get(atual.owner_id)),
        par('Lista', atual.import_lote_id ? nomeLista(atual.import_lote_id) : null),
        par('Criado em', fmtDataHora(atual.created_at)),
        par('Devolvido em', atual.devolvido_em ? fmtDataHora(atual.devolvido_em) : null),
        par('Motivo da devolução', atual.devolvido_motivo))));

    /* ── centro: registrar + histórico ── */
    colMeio.replaceChildren(s.registrar, s.timeline);

    /* ── direita: abordar (script/links) + empresa + usinas + sócios ── */
    const e = empresa || {};
    const widgets = [s.abordar];
    if (empresa) {
      widgets.push(
        card('Empresa', h('dl', { class: 'dl' },
          par('Razão social', e.razao_social), par('Nome fantasia', e.nome_fantasia),
          par('Situação', e.situacao_cadastral), par('CNAE', e.cnae_descricao || e.cnae_principal),
          par('Porte', e.porte), par('Natureza jurídica', e.natureza_juridica),
          par('Abertura', e.data_abertura ? fmtData(e.data_abertura) : null),
          par('Capital social', e.capital_social == null ? null : `R$ ${fmtNum(e.capital_social, 2)}`),
          par('Endereço', e.logradouro),
          par('Fonte do cadastro', e.fonte_enriquecimento))),
        card('Usinas (ANEEL)', e.qtd_usinas
          ? h('dl', { class: 'dl' },
            par('Usinas', String(e.qtd_usinas)),
            par('Potência total', e.potencia_total_kw == null ? null : fmtPotencia(e.potencia_total_kw)),
            par('Distribuidoras', (e.distribuidoras || []).map((c) => mapaConc.get(c) || c).join(', ')),
            par('Estados', (e.ufs || []).join(', ')),
            par('Primeira conexão', e.primeira_conexao ? fmtData(e.primeira_conexao) : null),
            par('Última conexão', e.ultima_conexao ? fmtData(e.ultima_conexao) : null))
          : h('p', { class: 'texto-fraco' }, 'Nenhuma usina da ANEEL associada a este CNPJ.')));
      if ((e.socios || []).length) {
        widgets.push(card('Sócios', h('ul', { class: 'lista-simples' }, e.socios.map((so) =>
          h('li', {}, h('strong', {}, so.nome), so.qualificacao ? ` — ${so.qualificacao}` : '')))));
      }
    }
    colDir.replaceChildren(...widgets);
  }

  cockpit.montar(compor, raiz);
  raiz.append(cabeca,
    h('div', { class: 'layout-3col' }, colEsq, colMeio, colDir));
  return raiz;
}
