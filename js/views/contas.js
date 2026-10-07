// views/contas.js — gestão de contas (só gestor). É aqui que se aprova quem acabou de criar
// conta, se desativa acesso e se muda o papel (agente / gestor / administrador).
//
// A trava de verdade está no banco (0006): `alterar_papel` e `definir_ativo` recusam quem não é
// gestor e nunca deixam o sistema sem gestor ativo. Esta tela só esconde o que o usuário não pode.

import { h, fmtData, fmtDataHora } from '../util.js';
import { perfis, alterarPapel, definirAtivo, precadastrarPerfil, auditoriaPerfis } from '../db.js';
import {
  cabecalhoPagina, card, kpi, tabela, badge, avatar, abas, vazio, toast, confirmar, perguntar, navegar,
} from '../ui.js';

const PAPEIS = [
  { v: 'agente', label: 'Agente' },
  { v: 'gestor', label: 'Gestor' },
  { v: 'admin', label: 'Administrador' },
];
const ROTULO_PAPEL = Object.fromEntries(PAPEIS.map((p) => [p.v, p.label]));

/** pendente = criou a conta e nunca foi aprovada · convidado = cadastrado por um gestor, ainda sem conta. */
function situacao(p) {
  if (p.ativo) return p.auth_user_id ? 'ativo' : 'convidado';
  return !p.aprovado_em && p.auth_user_id ? 'pendente' : 'inativo';
}
const BADGE_SITUACAO = {
  ativo: ['Ativa', 'verde'], pendente: ['Aguardando aprovação', 'ambar'],
  convidado: ['Ainda não criou conta', 'azul'], inativo: ['Desativada', 'cinza'],
};

export async function viewContas(params, ctxApp) {
  const { perfil } = ctxApp;
  const [lista, auditoria] = await Promise.all([perfis(), auditoriaPerfis(40)]);
  const porId = new Map(lista.map((p) => [p.id, p]));

  const cont = { todas: lista.length, pendente: 0, ativo: 0, inativo: 0 };
  for (const p of lista) {
    const s = situacao(p);
    if (s === 'pendente') cont.pendente++;
    else if (s === 'inativo') cont.inativo++;
    else cont.ativo++;
  }
  const gestores = lista.filter((p) => p.ativo && p.papel !== 'agente').length;

  const estado = { aba: params.aba || (cont.pendente ? 'pendente' : 'todas') };
  const areaLista = h('div', {});
  const raiz = h('div', { class: 'pagina' });

  /* ── ações ── */
  async function executar(fn, ok) {
    try {
      await fn();
      toast(ok, 'ok');
      navegar('contas', { aba: estado.aba });
    } catch (e) {
      toast(e.message, 'erro', 6000);
      navegar('contas', { aba: estado.aba }); // devolve o select ao valor real do banco
    }
  }

  async function mudarPapel(p, papel) {
    if (papel === p.papel) return;
    if (papel !== 'agente') {
      const ok = await confirmar(`Dar acesso de ${ROTULO_PAPEL[papel].toLowerCase()} a ${p.nome}?`,
        'Gestores veem todos os leads e conversas da equipe, redistribuem carteira e administram as contas.',
        { ok: 'Confirmar' });
      if (!ok) return navegar('contas', { aba: estado.aba });
    } else if (p.papel !== 'agente') {
      const ok = await confirmar(`Rebaixar ${p.nome} para agente?`,
        'Ela passa a ver apenas os próprios leads e conversas.', { ok: 'Rebaixar', perigo: true });
      if (!ok) return navegar('contas', { aba: estado.aba });
    }
    await executar(() => alterarPapel(p.id, papel), `${p.nome} agora é ${ROTULO_PAPEL[papel].toLowerCase()}.`);
  }

  async function ativar(p) {
    await executar(() => definirAtivo(p.id, true), `${p.nome} foi aprovada.`);
  }

  async function desativar(p) {
    const ok = await confirmar(`Desativar ${p.nome}?`,
      'A conta perde o acesso na hora. Os leads dela continuam na base e podem ser redistribuídos.',
      { ok: 'Desativar', perigo: true });
    if (ok) await executar(() => definirAtivo(p.id, false), `${p.nome} foi desativada.`);
  }

  async function precadastrar() {
    const r = await perguntar('Pré-cadastrar pessoa', [
      { campo: 'nome', label: 'Nome', obrigatorio: true },
      { campo: 'email', label: 'E-mail', tipo: 'email', obrigatorio: true,
        ajuda: 'Quando essa pessoa criar a conta com este e-mail (e confirmá-lo), já entra com o papel abaixo, sem esperar aprovação.' },
      { campo: 'papel', label: 'Papel', tipo: 'select', valor: 'agente', opcoes: PAPEIS.map((x) => ({ v: x.v, label: x.label })) },
    ], { ok: 'Pré-cadastrar' });
    if (!r) return;
    await executar(() => precadastrarPerfil(r), `${r.nome} foi pré-cadastrada.`);
  }

  /* ── tabela ── */
  function desenharLista() {
    const filtradas = lista.filter((p) => {
      const s = situacao(p);
      if (estado.aba === 'pendente') return s === 'pendente';
      if (estado.aba === 'ativo') return s === 'ativo' || s === 'convidado';
      if (estado.aba === 'inativo') return s === 'inativo';
      return true;
    }).sort((a, b) => (situacao(a) === 'pendente' ? -1 : 0) - (situacao(b) === 'pendente' ? -1 : 0)
      || a.nome.localeCompare(b.nome, 'pt-BR'));

    areaLista.replaceChildren(filtradas.length
      ? tabela({
        chave: (p) => p.id,
        linhas: filtradas,
        aoAbrir: () => {},
        colunas: [
          {
            titulo: 'Pessoa',
            render: (p) => h('div', { style: 'display:flex;align-items:center;gap:10px' },
              avatar(p.nome),
              h('div', { class: 'cel-principal' }, h('strong', {}, p.nome, p.id === perfil.id ? ' (você)' : ''), h('span', {}, p.email))),
          },
          {
            titulo: 'Papel', largura: '190px',
            render: (p) => {
              const sel = h('select', {
                'aria-label': `Papel de ${p.nome}`,
                onchange: () => mudarPapel(p, sel.value),
              }, PAPEIS.map((o) => h('option', { value: o.v, selected: o.v === p.papel }, o.label)));
              return sel;
            },
          },
          {
            titulo: 'Situação', largura: '190px',
            render: (p) => badge(...BADGE_SITUACAO[situacao(p)]),
          },
          { titulo: 'Criada em', largura: '110px', render: (p) => fmtData((p.created_at || '').slice(0, 10)) || '—' },
          {
            titulo: 'Ações', largura: '190px',
            render: (p) => {
              const s = situacao(p);
              if (s === 'pendente') return h('button', { class: 'btn btn--mini btn--primario', onclick: () => ativar(p) }, 'Aprovar acesso');
              if (s === 'inativo') return h('button', { class: 'btn btn--mini', onclick: () => ativar(p) }, 'Reativar');
              if (p.id === perfil.id) return h('span', { class: 'texto-fraco' }, '—');
              return h('button', { class: 'btn btn--mini btn--perigo-fraco', onclick: () => desativar(p) }, 'Desativar');
            },
          },
        ],
        vaziaMsg: 'Nenhuma conta neste filtro.',
      })
      : vazio('Nenhuma conta aqui', estado.aba === 'pendente' ? 'Ninguém aguardando aprovação.' : 'Mude o filtro acima.'));
  }

  /* ── histórico de alterações ── */
  const nomeDe = (id) => porId.get(id)?.nome || '—';
  const descreve = (a) => (a.campo === 'papel'
    ? `papel: ${ROTULO_PAPEL[a.de] || a.de} → ${ROTULO_PAPEL[a.para] || a.para}`
    : (a.para === 'true' ? 'conta ativada' : 'conta desativada'));

  const cardHistorico = card('Histórico de alterações',
    auditoria.length
      ? h('div', { class: 'tabela-wrap' }, h('table', { class: 'tabela tabela--mini' },
        h('thead', {}, h('tr', {}, ['Quando', 'Quem alterou', 'Conta', 'O quê'].map((t) => h('th', {}, t)))),
        h('tbody', {}, auditoria.map((a) => h('tr', {},
          h('td', {}, fmtDataHora(a.created_at)),
          h('td', {}, nomeDe(a.alterado_por)),
          h('td', {}, nomeDe(a.perfil_id)),
          h('td', {}, descreve(a)))))))
      : h('p', { class: 'texto-fraco' }, 'Nenhuma alteração de papel ou situação registrada ainda.'));

  raiz.append(
    cabecalhoPagina('Gestão de contas',
      'Aprove acessos, defina papéis e desative contas. Só gestores veem esta tela.',
      h('button', { class: 'btn btn--primario', onclick: precadastrar }, '+ Pré-cadastrar pessoa')),
    h('div', { class: 'kpis kpis--fina' },
      kpi('Contas', String(cont.todas)),
      kpi('Aguardando aprovação', String(cont.pendente), cont.pendente ? 'precisam da sua decisão' : null),
      kpi('Ativas', String(cont.ativo)),
      kpi('Gestores ativos', String(gestores), 'ao menos um é sempre mantido')),
    abas([
      { v: 'todas', label: `Todas (${cont.todas})` },
      { v: 'pendente', label: `Pendentes (${cont.pendente})` },
      { v: 'ativo', label: `Ativas (${cont.ativo})` },
      { v: 'inativo', label: `Desativadas (${cont.inativo})` },
    ], estado.aba, (v) => { estado.aba = v; desenharLista(); }),
    areaLista,
    cardHistorico);

  desenharLista();
  return raiz;
}
