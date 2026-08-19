// views/cockpit.js — o drawer de abordagem (seção 7.C).
//
// Regra do produto: a ferramenta PREPARA e REGISTRA. Não dispara nada.
// Os links abaixo só abrem o canal do agente — nenhum envio automático, nem
// WhatsApp, nem e-mail. É o que protege o número oficial e limita a exposição LGPD.
//
// O encadeamento "Ctrl+Enter salva e avança para o próximo da fila" é o que faz
// um lead levar ~20 s. Se algo aqui ficar lento, é aqui que dói.

import {
  h, esc, maskCnpj, maskFone, waLink, fmtData, fmtDataHora, fmtPotencia,
  addDias, hojeISO, copiar, digits, urlSegura,
} from '../util.js';
import {
  CANAIS, RESULTADOS, RESULTADO_MAP, STATUS, STATUS_MAP, MOTIVOS_PERDA,
  statusLabel, origemLabel, renderScript, SCRIPT_PADRAO,
} from '../seed.js';
import {
  get, todos, salvarLead, registrarInteracao, interacoesDoLead, getConfig, suprimir,
} from '../db.js';
import {
  drawer, fecharDrawer, badge, badgeStatus, toast, botaoCopiar, confirmar, perguntar,
} from '../ui.js';

/** Links externos vêm da config — dá para corrigir uma URL sem tocar em código. */
export const LINKS_PADRAO = [
  { label: 'LinkedIn (empresa)', url: 'https://www.linkedin.com/search/results/companies/?keywords={{razao_enc}}', ativo: true },
  { label: 'LinkedIn (pessoas)', url: 'https://www.linkedin.com/search/results/people/?keywords={{razao_enc}}', ativo: true },
  { label: 'Google', url: 'https://www.google.com/search?q={{razao_q}}+{{cidade_enc}}+contato', ativo: true },
  { label: 'CNPJ Biz', url: 'https://cnpj.biz/{{cnpj}}', ativo: true },
  { label: 'Casa dos Dados', url: 'https://casadosdados.com.br/solucao/cnpj/{{cnpj}}', ativo: true },
];

function montarURL(tpl, ctx) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    switch (k) {
      case 'cnpj': return ctx.cnpj || '';
      case 'cnpj_mask': return maskCnpj(ctx.cnpj || '');
      case 'razao_enc': return encodeURIComponent(ctx.razao || '');
      case 'razao_q': return encodeURIComponent(`"${ctx.razao || ''}"`);
      case 'cidade_enc': return encodeURIComponent(ctx.cidade || '');
      case 'uf': return ctx.uf || '';
      case 'telefone': return digits(ctx.telefone || '');
      default: return '';
    }
  });
}

/**
 * Abre o cockpit. `fila`/`indice` habilitam o "salvar e avançar".
 * `aoMudar` avisa a tela de trás para redesenhar a linha.
 */
export async function abrirCockpit({ lead, fila = [], indice = 0, perfil, aoMudar }) {
  let atual = lead;

  const [empresa, conc, links, tplScript, perfis] = await Promise.all([
    atual.cnpj ? get('empresa', atual.cnpj) : null,
    todos('concessionaria'),
    getConfig('links_externos', LINKS_PADRAO),
    getConfig('script_template', SCRIPT_PADRAO),
    todos('profiles'),
  ]);
  const mapaConc = new Map(conc.map((c) => [c.codigo, c.nome]));
  const nomeAgente = new Map(perfis.map((p) => [p.id, p.nome]));

  const dados = () => {
    const e = empresa || {};
    return {
      razao: atual.razao_social || e.razao_social || '',
      contato: atual.contato_nome || '',
      cnpj: atual.cnpj || '',
      telefone: atual.telefone || e.telefone1 || '',
      telefone2: atual.telefone2 || e.telefone2 || '',
      email: atual.email || e.email || '',
      cidade: atual.cidade || e.municipio_principal || '',
      uf: atual.uf || e.uf_principal || '',
      cep: atual.cep || e.cep || '',
      conc: mapaConc.get(atual.concessionaria_codigo) || atual.concessionaria_raw || '',
      potencia: atual.potencia_kwp ?? e.potencia_total_kw ?? null,
      usinas: e.qtd_usinas ?? null,
      fonte: e.fonte_enriquecimento || null,
      socios: e.socios || [],
      situacao: e.situacao_cadastral || null,
      cnae: e.cnae_descricao || e.cnae_principal || null,
    };
  };

  const scriptResolvido = () => {
    const d = dados();
    return renderScript(tplScript, {
      contato_nome: d.contato,
      razao_social: d.razao,
      cidade: d.cidade,
      uf: d.uf,
      concessionaria: d.conc,
      potencia: d.potencia == null ? '' : fmtPotencia(d.potencia),
      qtd_usinas: d.usinas == null ? '' : String(d.usinas),
      cnpj: maskCnpj(d.cnpj),
      agente: perfil?.nome || '',
    });
  };

  /* ── estado do formulário de registro ── */
  const form = {
    canal: 'whatsapp',
    sentido: 'saida',
    resultado: null,
    status: atual.status,
    status_motivo: atual.status_motivo || '',
    proxima_acao_em: atual.proxima_acao_em || hojeISO(),
    descricao: '',
  };

  const raiz = h('div', { class: 'cockpit' });
  const painel = drawer({ conteudo: raiz, aoFechar: () => document.removeEventListener('keydown', onTeclaGlobal, true) });

  function redesenhar() {
    const d = dados();

    /* ── Cabeçalho ── */
    const topo = h('header', { class: 'cockpit__topo' },
      h('div', { class: 'cockpit__ident' },
        h('h2', {}, d.razao || d.contato || 'Lead sem nome'),
        h('div', { class: 'cockpit__meta' },
          d.cnpj
            ? h('button', {
              class: 'chip chip--copia',
              title: 'Copiar CNPJ',
              onclick: async () => { await copiar(d.cnpj); toast('CNPJ copiado.', 'ok', 1500); },
            }, maskCnpj(d.cnpj), h('span', { class: 'chip__ico' }, '⧉'))
            : badge('sem CNPJ', 'cinza'),
          badgeStatus(atual.status),
          badge(origemLabel(atual.origem), 'azul'),
          badge(atual.tipo === 'intermediador' ? 'Intermediador' : 'Usina', 'roxo'),
          atual.opt_out ? badge('OPT-OUT', 'vermelho') : null)),
      h('div', { class: 'cockpit__navfila' },
        fila.length > 1 ? h('span', { class: 'cockpit__pos' }, `${indice + 1} / ${fila.length}`) : null,
        h('button', { class: 'btn-icone', title: 'Fechar (Esc)', onclick: fecharDrawer }, '×')));

    /* ── Faixa de fatos ── */
    const fato = (rot, val, dica) => h('div', { class: 'fato', title: dica || '' },
      h('span', {}, rot), h('strong', {}, val || '—'));
    const fatos = h('div', { class: 'cockpit__fatos' },
      fato('Distribuidora', d.conc),
      fato('Potência', d.potencia == null ? '' : fmtPotencia(d.potencia)),
      fato('Usinas', d.usinas == null ? '' : String(d.usinas)),
      fato('Cidade/UF', [d.cidade, d.uf].filter(Boolean).join('/')),
      fato('Tentativas', String(atual.tentativas || 0)),
      fato('Último contato', fmtData(atual.ultimo_contato_em)),
      fato('Próxima ação', fmtData(atual.proxima_acao_em)),
      fato('Dono', nomeAgente.get(atual.owner_id) || '—'));

    /* ── Bloco Abordar ── */
    const wa = waLink(d.telefone);
    const linkCtx = { cnpj: d.cnpj, razao: d.razao, cidade: d.cidade, uf: d.uf, telefone: d.telefone };

    const areaScript = h('pre', { class: 'script' }, scriptResolvido());

    const blocoAbordar = h('section', { class: 'bloco' },
      h('div', { class: 'bloco__topo' },
        h('h3', {}, 'Abordar'),
        h('span', { class: 'bloco__nota' }, 'a ferramenta prepara — o envio é você, no seu canal')),
      areaScript,
      h('div', { class: 'linha-botoes' },
        botaoCopiar('Copiar script', scriptResolvido, { classe: 'btn--primario', atalho: 'C' }),
        d.telefone ? botaoCopiar('Copiar telefone', () => maskFone(d.telefone)) : null,
        d.cnpj ? botaoCopiar('Copiar CNPJ', () => d.cnpj) : null,
        d.email ? botaoCopiar('Copiar e-mail', () => d.email) : null),
      h('div', { class: 'linha-links' },
        wa ? h('a', { class: 'btn btn--wa', href: wa, target: '_blank', rel: 'noopener' }, '💬 WhatsApp ', h('em', {}, maskFone(d.telefone))) : null,
        d.email ? h('a', { class: 'btn btn--fantasma', href: `mailto:${d.email}`, target: '_blank', rel: 'noopener' }, '✉️ ', d.email) : null,
        (links || LINKS_PADRAO).filter((l) => l.ativo !== false).map((l) =>
          h('a', {
            class: 'btn btn--fantasma', target: '_blank', rel: 'noopener',
            href: urlSegura(montarURL(l.url, linkCtx)),
          }, l.label))),
      (d.telefone2 || d.socios.length || d.situacao || d.cnae)
        ? h('details', { class: 'extra' },
          h('summary', {}, 'Mais dados do cadastro'),
          h('dl', { class: 'dl' },
            d.situacao ? [h('dt', {}, 'Situação'), h('dd', {}, d.situacao)] : null,
            d.cnae ? [h('dt', {}, 'CNAE'), h('dd', {}, d.cnae)] : null,
            d.telefone2 ? [h('dt', {}, 'Telefone 2'), h('dd', {}, maskFone(d.telefone2))] : null,
            d.cep ? [h('dt', {}, 'CEP'), h('dd', {}, d.cep)] : null,
            d.fonte ? [h('dt', {}, 'Origem do dado'), h('dd', {}, d.fonte)] : null,
            d.socios.length
              ? [h('dt', {}, 'Sócios'), h('dd', {}, d.socios.map((s) =>
                h('div', {}, `${s.nome}${s.qualificacao ? ` — ${s.qualificacao}` : ''}`)))]
              : null))
        : null);

    /* ── Bloco Registrar ── */
    const selStatus = h('select', { class: 'sel-status' },
      STATUS.map((s) => h('option', { value: s.v, selected: s.v === form.status }, s.label)));
    selStatus.addEventListener('change', () => {
      form.status = selStatus.value;
      atualizarMotivo();
    });

    const campoMotivo = h('div', { class: 'campo-motivo' });
    function atualizarMotivo() {
      campoMotivo.replaceChildren();
      if (form.status !== 'perdido' && form.status !== 'descartado') return;
      const sel = h('select', {},
        h('option', { value: '' }, 'Motivo… (obrigatório)'),
        MOTIVOS_PERDA.map((m) => h('option', { value: m, selected: m === form.status_motivo }, m)));
      sel.addEventListener('change', () => { form.status_motivo = sel.value; });
      campoMotivo.append(h('label', { class: 'campo' }, h('span', {}, 'Motivo'), sel));
    }
    atualizarMotivo();

    const inpProxima = h('input', { type: 'date', value: form.proxima_acao_em || '' });
    inpProxima.addEventListener('change', () => { form.proxima_acao_em = inpProxima.value || null; });

    const txtDescricao = h('textarea', {
      rows: 3,
      placeholder: 'O que aconteceu neste toque? (vira a coluna "Descrição do contato" no export)',
    }, form.descricao);
    txtDescricao.addEventListener('input', () => { form.descricao = txtDescricao.value; });

    const pillsCanal = h('div', { class: 'pills' },
      CANAIS.map((c, i) => {
        const b = h('button', {
          type: 'button', class: `pill ${form.canal === c.v ? 'is-ativa' : ''}`, 'data-canal': c.v,
        }, h('kbd', {}, String(i + 1)), `${c.icone} ${c.label}`);
        b.addEventListener('click', () => escolherCanal(c.v));
        return b;
      }));

    const pillsResultado = h('div', { class: 'pills' },
      RESULTADOS.map((r) => {
        const b = h('button', {
          type: 'button', class: `pill ${form.resultado === r.v ? 'is-ativa' : ''}`, 'data-res': r.v,
        }, r.label);
        b.addEventListener('click', () => escolherResultado(r.v));
        return b;
      }));

    function escolherCanal(v) {
      form.canal = v;
      pillsCanal.querySelectorAll('.pill').forEach((p) =>
        p.classList.toggle('is-ativa', p.dataset.canal === v));
    }

    /** O resultado sugere status e próxima ação — é o que reduz a 2 cliques. */
    function escolherResultado(v) {
      form.resultado = v;
      pillsResultado.querySelectorAll('.pill').forEach((p) =>
        p.classList.toggle('is-ativa', p.dataset.res === v));
      const r = RESULTADO_MAP[v];
      if (!r) return;
      form.status = r.status;
      selStatus.value = r.status;
      atualizarMotivo();
      form.proxima_acao_em = r.adiar == null ? null : addDias(hojeISO(), r.adiar);
      inpProxima.value = form.proxima_acao_em || '';
    }

    const botoesAdiar = h('div', { class: 'linha-botoes linha-botoes--fina' },
      [1, 3, 7, 15, 30].map((n) => h('button', {
        class: 'btn btn--mini', type: 'button',
        onclick: () => {
          form.proxima_acao_em = addDias(hojeISO(), n);
          inpProxima.value = form.proxima_acao_em;
        },
      }, `+${n}d`)),
      h('button', {
        class: 'btn btn--mini', type: 'button',
        onclick: () => { form.proxima_acao_em = null; inpProxima.value = ''; },
      }, 'sem retorno'));

    const blocoRegistrar = h('section', { class: 'bloco bloco--registrar' },
      h('div', { class: 'bloco__topo' },
        h('h3', {}, 'Registrar'),
        h('span', { class: 'bloco__nota' }, `autor e data automáticos · ${perfil?.nome || '—'} · ${fmtData(hojeISO())}`)),
      h('label', { class: 'campo' }, h('span', {}, 'Canal'), pillsCanal),
      h('label', { class: 'campo' }, h('span', {}, 'Resultado'), pillsResultado),
      h('div', { class: 'grade-2' },
        h('label', { class: 'campo' }, h('span', {}, 'Status após o toque'), selStatus),
        h('label', { class: 'campo' }, h('span', {}, 'Próxima ação'), inpProxima)),
      botoesAdiar,
      campoMotivo,
      h('label', { class: 'campo' }, h('span', {}, 'Descrição'), txtDescricao),
      h('div', { class: 'linha-botoes' },
        h('button', { class: 'btn btn--primario', onclick: () => salvar(true) },
          h('kbd', {}, 'Ctrl+↵'), 'Salvar e próximo'),
        h('button', { class: 'btn', onclick: () => salvar(false) }, 'Salvar e ficar'),
        h('button', {
          class: 'btn btn--fantasma',
          onclick: async () => {
            const s = { ...form, sentido: form.sentido === 'saida' ? 'entrada' : 'saida' };
            form.sentido = s.sentido;
            toast(`Sentido: ${form.sentido === 'entrada' ? 'entrada (ele respondeu)' : 'saída'}`, 'info', 1800);
          },
        }, 'Alternar entrada/saída')));

    /* ── Timeline ── */
    const timeline = h('section', { class: 'bloco' },
      h('div', { class: 'bloco__topo' }, h('h3', {}, 'Histórico')),
      h('div', { class: 'timeline' }, h('p', { class: 'texto-fraco' }, 'carregando…')));

    interacoesDoLead(atual.id).then((lista) => {
      const alvo = timeline.querySelector('.timeline');
      if (!lista.length) {
        alvo.replaceChildren(h('p', { class: 'texto-fraco' }, 'Nenhum toque registrado ainda.'));
        return;
      }
      alvo.replaceChildren(...lista.map((i) => {
        const c = CANAIS.find((x) => x.v === i.canal);
        return h('div', { class: 'toque' },
          h('div', { class: 'toque__topo' },
            h('strong', {}, `${c?.icone || '•'} ${c?.label || i.canal}`),
            i.sentido === 'entrada' ? badge('entrada', 'ciano') : null,
            i.resultado ? badge(RESULTADO_MAP[i.resultado]?.label || i.resultado, 'cinza') : null,
            i.status_apos ? badge(statusLabel(i.status_apos), STATUS_MAP[i.status_apos]?.cor || 'cinza') : null,
            h('span', { class: 'toque__data' }, fmtDataHora(i.ocorrido_em)),
            h('span', { class: 'toque__autor' }, nomeAgente.get(i.agente_id) || '')),
          i.descricao ? h('p', {}, i.descricao) : null);
      }));
    });

    /* ── Rodapé de ações menos usadas ── */
    const rodape = h('div', { class: 'cockpit__rodape' },
      h('button', { class: 'btn btn--mini', onclick: editarLead }, 'Editar dados'),
      h('button', { class: 'btn btn--mini', onclick: trocarDono }, 'Trocar dono'),
      h('button', { class: 'btn btn--mini btn--perigo-fraco', onclick: registrarOptOut }, 'Registrar opt-out'),
      h('span', { class: 'cockpit__id' }, `id ${atual.id.slice(0, 8)}`));

    raiz.replaceChildren(topo, fatos,
      h('div', { class: 'cockpit__corpo' }, blocoAbordar, blocoRegistrar, timeline, rodape));
  }

  /* ═══════════ Ações ═══════════ */

  async function salvar(avancar) {
    if ((form.status === 'perdido' || form.status === 'descartado') && !form.status_motivo) {
      toast('Status "perdido"/"descartado" exige motivo.', 'erro');
      return;
    }
    if (!form.resultado && !form.descricao.trim()) {
      toast('Escolha um resultado ou escreva a descrição.', 'aviso');
      return;
    }
    const { lead: salvo } = await registrarInteracao({
      lead: atual,
      agente_id: perfil.id,
      canal: form.canal,
      sentido: form.sentido,
      resultado: form.resultado,
      status_apos: form.status,
      status_motivo: form.status_motivo || null,
      descricao: form.descricao.trim() || null,
      proxima_acao_em: form.proxima_acao_em,
    });
    atual = salvo;
    aoMudar?.(salvo);
    toast('Toque registrado.', 'ok', 1600);

    if (avancar) {
      const prox = fila[indice + 1];
      if (prox) {
        fecharDrawer();
        // recarrega o lead do banco: pode ter mudado na tela de trás
        const fresco = (await get('lead', prox.id)) || prox;
        return abrirCockpit({ lead: fresco, fila, indice: indice + 1, perfil, aoMudar });
      }
      fecharDrawer();
      toast('Fim da fila. 👏', 'ok');
      return;
    }
    form.resultado = null;
    form.descricao = '';
    redesenhar();
  }

  async function editarLead() {
    const d = dados();
    const r = await perguntar('Editar dados do lead', [
      { campo: 'razao_social', label: 'Razão social', valor: atual.razao_social || d.razao },
      { campo: 'contato_nome', label: 'Nome do contato', valor: atual.contato_nome || '' },
      { campo: 'contato_cargo', label: 'Cargo', valor: atual.contato_cargo || '' },
      { campo: 'telefone', label: 'Telefone', valor: atual.telefone || '' },
      { campo: 'email', label: 'E-mail', valor: atual.email || '' },
      { campo: 'cidade', label: 'Cidade', valor: atual.cidade || '' },
      { campo: 'uf', label: 'UF', valor: atual.uf || '' },
      { campo: 'linkedin_url', label: 'LinkedIn', valor: atual.linkedin_url || '' },
    ]);
    if (!r) return;
    atual = await salvarLead({ ...atual, ...r, uf: (r.uf || '').toUpperCase().slice(0, 2) || null });
    aoMudar?.(atual);
    redesenhar();
    toast('Dados atualizados.', 'ok');
  }

  async function trocarDono() {
    const lista = (await todos('profiles')).filter((p) => p.ativo);
    const r = await perguntar('Trocar dono do lead', [{
      campo: 'owner_id', label: 'Novo dono', tipo: 'select', valor: atual.owner_id,
      opcoes: lista.map((p) => ({ v: p.id, label: `${p.nome} (${p.papel})` })),
      ajuda: 'O histórico de toques mantém a autoria original.',
    }]);
    if (!r) return;
    atual = await salvarLead({ ...atual, owner_id: r.owner_id });
    aoMudar?.(atual);
    redesenhar();
    toast('Dono atualizado.', 'ok');
  }

  async function registrarOptOut() {
    const d = dados();
    const ok = await confirmar('Registrar opt-out',
      'O CNPJ, telefone e e-mail deste lead entram na lista de supressão e continuam '
      + 'bloqueados mesmo depois de reimportar a ANEEL. O lead vira "descartado". Confirma?',
      { ok: 'Registrar opt-out', perigo: true });
    if (!ok) return;
    await suprimir({
      cnpj: d.cnpj, telefone: d.telefone, email: d.email,
      motivo: 'Solicitado pelo titular', registrado_por: perfil.id,
    });
    atual = await salvarLead({
      ...atual, opt_out: true, status: 'descartado', status_motivo: 'Opt-out (LGPD)',
      proxima_acao_em: null,
    });
    aoMudar?.(atual);
    redesenhar();
    toast('Opt-out registrado e supressão gravada.', 'ok');
  }

  /* ═══════════ Teclado ═══════════ */

  function onTeclaGlobal(e) {
    if (!painel.isConnected) return;
    const emCampo = e.target.matches('input,textarea,select');

    if (e.key === 'Escape') { e.preventDefault(); fecharDrawer(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); salvar(true); return; }
    if (emCampo) return;

    if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      copiar(scriptResolvido()).then(() => toast('Script copiado.', 'ok', 1400));
      return;
    }
    const n = Number(e.key);
    if (n >= 1 && n <= CANAIS.length) {
      e.preventDefault();
      const alvo = CANAIS[n - 1].v;
      form.canal = alvo;
      painel.querySelectorAll('[data-canal]').forEach((p) =>
        p.classList.toggle('is-ativa', p.dataset.canal === alvo));
    }
  }
  document.addEventListener('keydown', onTeclaGlobal, true);

  redesenhar();
  return painel;
}
