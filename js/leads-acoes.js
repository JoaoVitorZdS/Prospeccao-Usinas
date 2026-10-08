// leads-acoes.js — as ações sobre leads, compartilhadas pela lista (em lote), pela gaveta
// de abordagem e pela página do lead: concluir, mudar status, devolver à base, restaurar,
// excluir, reagendar, distribuir, listas, completar dados, editar tudo e criar à mão.
//
// Cada ação abre o próprio diálogo, aplica no banco (em lote quando dá — uma requisição por
// 200 leads em vez de uma por lead) e devolve algo verdadeiro se mudou alguma coisa, ou
// `null`/`0` se a pessoa cancelou. Quem chama só precisa redesenhar a tela.

import {
  h, uuid, hojeISO, normCnpj, normFone, normEmail, foneKey, parseNum, digits, urlSegura,
} from './util.js';
import {
  STATUS, STATUS_MAP, statusLabel, MOTIVOS_PERDA, ORIGENS, UFS, CONCESSIONARIAS,
} from './seed.js';
import {
  get, todos, putMuitos, atualizarLeads, devolverLeads, restaurarLeads, excluirLeadsDefinitivo,
  criarLista, moverParaLista, listasDeImportacao, upsertEmpresa, criarLead, acharDuplicado,
} from './db.js';
import { processarFila } from './enriquecer.js';
import { perguntar, confirmar, modal, toast } from './ui.js';

const rotulo = (txt, controle, ajuda) =>
  h('label', { class: 'campo' }, h('span', {}, txt), controle, ajuda ? h('small', {}, ajuda) : null);

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

/* ═══════════════ Diálogo de desfecho / status ═══════════════ */

/**
 * Escolhe um status (e o motivo, quando o desfecho é perda/descarte — mesma regra do cockpit).
 * `estados`: lista de { v, label } permitidos. Devolve { status, motivo, obs } ou null.
 */
function dialogoStatus({ titulo, estados, inicial, ok, aviso }) {
  return new Promise((res) => {
    const selStatus = h('select', {}, estados.map((s) =>
      h('option', { value: s.v, selected: s.v === inicial }, s.label)));
    const selMotivo = h('select', {},
      h('option', { value: '' }, 'Selecione o motivo…'),
      MOTIVOS_PERDA.map((m) => h('option', { value: m }, m)));
    const campoMotivo = rotulo('Motivo (obrigatório)', selMotivo);
    const obs = h('textarea', { rows: 3, placeholder: 'Observação opcional — fica no histórico do lead' });
    const exigeMotivo = () => ['perdido', 'descartado'].includes(selStatus.value);
    const sincronizar = () => { campoMotivo.hidden = !exigeMotivo(); };
    selStatus.addEventListener('change', sincronizar);
    sincronizar();

    modal({
      titulo,
      largura: '480px',
      corpo: h('div', { class: 'form' },
        aviso ? h('p', { class: 'texto-fraco' }, aviso) : null,
        rotulo('Resultado', selStatus), campoMotivo, rotulo('Observação', obs)),
      acoes: [
        { label: 'Cancelar', classe: 'btn--fantasma', valor: null },
        {
          label: ok, classe: 'btn--primario',
          onclick: () => {
            if (exigeMotivo() && !selMotivo.value) { toast('Escolha o motivo.', 'erro'); return false; }
            res({ status: selStatus.value, motivo: exigeMotivo() ? selMotivo.value : null, obs: obs.value.trim() });
            return true;
          },
        },
      ],
      aoFechar: (v) => { if (v == null) res(null); },
    });
  });
}

/** Aplica um status a vários leads e registra uma anotação no histórico de cada um. */
async function aplicarStatus(leads, { status, motivo, obs }, perfil, verbo) {
  const ids = leads.map((l) => l.id);
  const estado = STATUS_MAP[status];
  const patch = { status, status_motivo: motivo || null };
  if (!estado?.fila) patch.proxima_acao_em = null;            // saiu da fila de trabalho
  const n = await atualizarLeads(ids, patch);
  if (estado?.fila) {                                         // voltou para a fila: precisa de data
    await atualizarLeads(leads.filter((l) => !l.proxima_acao_em).map((l) => l.id), { proxima_acao_em: hojeISO() });
  }
  const agora = new Date().toISOString();
  const descricao = obs || `${verbo}: ${statusLabel(status)}${motivo ? ` — ${motivo}` : ''}`;
  await putMuitos('interacao', leads.map((l) => ({
    id: uuid(), lead_id: l.id, agente_id: perfil.id, canal: 'outro', sentido: 'saida',
    ocorrido_em: agora, resultado: null, status_apos: status, descricao, created_at: agora,
  })));
  return n;
}

const DESFECHOS = ['ganho', 'perdido', 'sem_contato', 'descartado']
  .map((v) => ({ v, label: STATUS_MAP[v].label }));

/** "Concluir": encerra o trabalho no lead com um desfecho final (e motivo, se perdeu). */
export async function concluirLeads(leads, { perfil }) {
  if (!leads.length) return 0;
  const r = await dialogoStatus({
    titulo: leads.length === 1 ? 'Concluir lead' : `Concluir ${plural(leads.length, 'lead', 'leads')}`,
    estados: DESFECHOS, inicial: 'ganho', ok: 'Concluir',
    aviso: 'O lead sai da fila de trabalho e fica em "Concluídos". O histórico é mantido.',
  });
  if (!r) return 0;
  const n = await aplicarStatus(leads, r, perfil, 'Concluído');
  toast(`${plural(n, 'lead concluído', 'leads concluídos')} como ${statusLabel(r.status).toLowerCase()}.`, 'ok');
  return n;
}

/** Mudar status em lote (qualquer status; perda/descarte exigem motivo). */
export async function mudarStatusLeads(leads, { perfil }) {
  if (!leads.length) return 0;
  const r = await dialogoStatus({
    titulo: `Mudar status de ${plural(leads.length, 'lead', 'leads')}`,
    estados: STATUS.map((s) => ({ v: s.v, label: s.label })), inicial: 'a_abordar', ok: 'Aplicar',
  });
  if (!r) return 0;
  const n = await aplicarStatus(leads, r, perfil, 'Status alterado');
  toast(`${plural(n, 'lead atualizado', 'leads atualizados')} para ${statusLabel(r.status)}.`, 'ok');
  return n;
}

/**
 * Mover um lead de etapa no quadro de Negócios (arrastar ou menu). Perder/descartar pede o motivo, como em
 * qualquer outro lugar; as demais etapas movem direto e deixam uma anotação no histórico.
 */
export async function moverParaEtapa(lead, destino, { perfil }) {
  if (!lead || lead.status === destino) return 0;
  let dados = { status: destino, motivo: null, obs: '' };
  if (['perdido', 'descartado'].includes(destino)) {
    dados = await dialogoStatus({
      titulo: `Mover para ${statusLabel(destino)}`,
      estados: [{ v: destino, label: statusLabel(destino) }], inicial: destino, ok: 'Mover',
      aviso: `${lead.razao_social || lead.contato_nome || 'O lead'} sai da fila de trabalho.`,
    });
    if (!dados) return 0;
  }
  const n = await aplicarStatus([lead], dados, perfil, 'Movido no quadro');
  toast(`${lead.razao_social || lead.contato_nome || 'Lead'} → ${statusLabel(destino)}.`, 'ok', 2500);
  return n;
}

/* ═══════════════ Devolver à base, restaurar, excluir ═══════════════ */

const MOTIVOS_DEVOLUCAO = [
  'Contato incorreto ou inexistente',
  'Sem interesse neste momento',
  'Fora do meu perfil / região',
  'Vou deixar para outro agente',
  'Outro',
];

/** "Retornar à base": sai da carteira, a empresa volta a aparecer em Prospecção. Dá para restaurar. */
export async function devolverALeadsBase(leads) {
  if (!leads.length) return 0;
  const sel = h('select', {}, MOTIVOS_DEVOLUCAO.map((m) => h('option', { value: m }, m)));
  const detalhe = h('input', { type: 'text', placeholder: 'Detalhe (opcional)' });
  const ok = await new Promise((res) => {
    modal({
      titulo: `Devolver ${plural(leads.length, 'lead', 'leads')} à base`,
      largura: '480px',
      corpo: h('div', { class: 'form' },
        h('p', { class: 'texto-fraco' },
          'Sai da sua carteira e a empresa volta a aparecer em Prospecção para qualquer agente '
          + 'pegar. O histórico fica guardado e você pode restaurar em "Devolvidos à base".'),
        rotulo('Motivo', sel), rotulo('Detalhe', detalhe)),
      acoes: [
        { label: 'Cancelar', classe: 'btn--fantasma', valor: false },
        { label: 'Devolver à base', classe: 'btn--primario', valor: true },
      ],
      aoFechar: (v) => res(v === true),
    });
  });
  if (!ok) return 0;
  const motivo = `${sel.value}${detalhe.value.trim() ? ` — ${detalhe.value.trim()}` : ''}`;
  const n = await devolverLeads(leads.map((l) => l.id), motivo);
  toast(`${plural(n, 'lead devolvido', 'leads devolvidos')} à base.`, 'ok');
  return n;
}

export async function restaurarDevolvidos(leads) {
  if (!leads.length) return 0;
  const { ok, conflitos } = await restaurarLeads(leads.map((l) => l.id));
  if (ok) toast(`${plural(ok, 'lead restaurado', 'leads restaurados')}.`, 'ok');
  if (conflitos.length) {
    toast(`${plural(conflitos.length, 'lead não voltou', 'leads não voltaram')}: o CNPJ já tem outro lead ativo.`, 'aviso', 7000);
  }
  return ok;
}

/** Exclusão física — só gestor (o RLS recusa os demais). Leva o histórico junto. */
export async function excluirDefinitivo(leads) {
  if (!leads.length) return 0;
  const ok = await confirmar(`Excluir ${plural(leads.length, 'lead', 'leads')} para sempre?`,
    'O lead e todo o histórico de contatos dele são apagados e não dá para desfazer. '
    + 'Para só tirar da carteira, use "Devolver à base".', { ok: 'Excluir definitivamente', perigo: true });
  if (!ok) return 0;
  const n = await excluirLeadsDefinitivo(leads.map((l) => l.id));
  toast(`${plural(n, 'lead excluído', 'leads excluídos')}.`, 'ok');
  return n;
}

/* ═══════════════ Reagendar, distribuir, listas ═══════════════ */

export async function reagendarLeads(leads) {
  if (!leads.length) return 0;
  const r = await perguntar('Reagendar próxima ação', [
    { campo: 'data', label: 'Nova data', tipo: 'date', valor: hojeISO(), obrigatorio: true },
  ], { ok: 'Reagendar' });
  if (!r) return 0;
  const n = await atualizarLeads(leads.map((l) => l.id), { proxima_acao_em: r.data });
  toast(`${plural(n, 'lead reagendado', 'leads reagendados')}.`, 'ok');
  return n;
}

/** Só gestor: passar leads para outro agente. */
export async function distribuirLeads(leads, perfis) {
  if (!leads.length) return 0;
  const ativos = perfis.filter((p) => p.ativo);
  const r = await perguntar('Distribuir para', [{
    campo: 'owner_id', label: 'Agente', tipo: 'select', valor: ativos[0]?.id,
    opcoes: ativos.map((p) => ({ v: p.id, label: p.nome })),
  }], { ok: 'Distribuir' });
  if (!r) return 0;
  const n = await atualizarLeads(leads.map((l) => l.id), { owner_id: r.owner_id });
  toast(`${plural(n, 'lead redistribuído', 'leads redistribuídos')}.`, 'ok');
  return n;
}

/** Coloca os leads numa lista existente ou numa nova (nome digitado na hora). */
export async function adicionarALista(leads, { perfil }) {
  if (!leads.length) return null;
  const listas = (await listasDeImportacao()).sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  const sel = h('select', {},
    h('option', { value: '__nova' }, '+ Nova lista…'),
    listas.map((l) => h('option', { value: l.id }, l.nome || l.arquivo || `Lista ${String(l.id).slice(0, 6)}`)));
  const nome = h('input', { type: 'text', placeholder: 'Nome da nova lista' });
  const campoNome = rotulo('Nome da nova lista', nome);
  const sync = () => { campoNome.hidden = sel.value !== '__nova'; };
  sel.addEventListener('change', sync);
  if (listas.length) sel.value = listas[0].id;
  sync();

  const ok = await new Promise((res) => {
    modal({
      titulo: `Adicionar ${plural(leads.length, 'lead', 'leads')} a uma lista`,
      largura: '460px',
      corpo: h('div', { class: 'form' }, rotulo('Lista', sel), campoNome),
      acoes: [
        { label: 'Cancelar', classe: 'btn--fantasma', valor: false },
        {
          label: 'Adicionar', classe: 'btn--primario',
          onclick: () => {
            if (sel.value === '__nova' && !nome.value.trim()) { toast('Dê um nome à lista.', 'erro'); return false; }
            return true;
          },
          valor: true,
        },
      ],
      aoFechar: (v) => res(v === true),
    });
  });
  if (!ok) return null;
  let lista = listas.find((l) => l.id === sel.value);
  if (sel.value === '__nova') lista = await criarLista({ nome: nome.value, agente_id: perfil.id });
  const n = await moverParaLista(leads.map((l) => l.id), lista.id);
  toast(`${plural(n, 'lead adicionado', 'leads adicionados')} a "${lista.nome}".`, 'ok');
  return lista;
}

export async function removerDeLista(leads) {
  if (!leads.length) return 0;
  const n = await moverParaLista(leads.map((l) => l.id), null);
  toast(`${plural(n, 'lead removido', 'leads removidos')} da lista.`, 'ok');
  return n;
}

/* ═══════════════ Completar dados (enriquecimento) ═══════════════ */

const CAMPOS_DA_EMPRESA = [
  ['telefone', 'telefone1', 'telefone'], ['telefone2', 'telefone2', 'telefone 2'],
  ['email', 'email', 'e-mail'], ['razao_social', 'razao_social', 'razão social'],
  ['cidade', 'municipio_principal', 'cidade'], ['uf', 'uf_principal', 'UF'], ['cep', 'cep', 'CEP'],
];

/** Preenche só o que está VAZIO no lead, a partir da empresa (já enriquecida). Função pura. */
export function camposParaCompletar(lead, empresa) {
  const patch = {};
  const preenchidos = [];
  for (const [campoLead, campoEmpresa, nome] of CAMPOS_DA_EMPRESA) {
    const atual = lead[campoLead];
    const novo = empresa?.[campoEmpresa];
    if ((atual == null || atual === '') && novo != null && novo !== '') {
      patch[campoLead] = novo;
      preenchidos.push(nome);
    }
  }
  if (patch.telefone) patch.tel_key = foneKey(patch.telefone) || null;
  if (patch.email) patch.email_key = normEmail(patch.email) || null;
  return { patch, preenchidos };
}

/**
 * "Completar dados": consulta o CNPJ nas fontes abertas (mesmo enriquecimento de Prospecção) e
 * preenche o que o lead ainda não tem. Nunca sobrescreve o que o agente já digitou.
 */
export async function completarDados(lead) {
  if (!lead.cnpj) {
    toast('Este lead não tem CNPJ. Informe o CNPJ em "Editar" para buscar os dados.', 'aviso', 6000);
    return null;
  }
  if (!(await get('empresa', lead.cnpj))) await upsertEmpresa({ cnpj: lead.cnpj, razao_social: lead.razao_social });
  const resumo = await processarFila([lead.cnpj]);
  const empresa = await get('empresa', lead.cnpj);
  const { patch, preenchidos } = camposParaCompletar(lead, empresa);
  if (Object.keys(patch).length) await atualizarLeads([lead.id], patch);
  if (preenchidos.length) toast(`Dados completados: ${preenchidos.join(', ')}.`, 'ok', 5000);
  else if (resumo.suprimidos) toast('Este CNPJ está na lista de opt-out — nada foi buscado.', 'aviso');
  else toast(empresa?.enriquecimento_erro
    ? `Não consegui consultar o CNPJ agora (${empresa.enriquecimento_erro}).`
    : 'Nada novo para completar: o lead já tem os dados disponíveis.', 'info', 5000);
  return { patch, preenchidos, empresa };
}

/* ═══════════════ Editar tudo / criar à mão ═══════════════ */

const TIPOS = [{ v: 'usina_geradora', label: 'Usina geradora' }, { v: 'intermediador', label: 'Intermediador' }];

/** Valida o formulário e devolve { erro } ou { patch } já normalizado (nulls explícitos para limpar campos). */
export function validarFormularioLead(r) {
  const cnpj = r.cnpj ? normCnpj(r.cnpj) : '';
  if (r.cnpj && !cnpj) return { erro: 'CNPJ inválido — são 14 dígitos.' };
  const email = r.email ? normEmail(r.email) : '';
  if (r.email && !email) return { erro: 'E-mail inválido.' };
  const uf = (r.uf || '').trim().toUpperCase();
  if (uf && !UFS.includes(uf)) return { erro: `UF "${uf}" não existe.` };
  const potencia = r.potencia_kwp ? parseNum(r.potencia_kwp) : null;
  if (r.potencia_kwp && (potencia == null || potencia < 0)) return { erro: 'Potência inválida — use número em kW (ex.: 1250,5).' };
  const linkedin = (r.linkedin_url || '').trim();
  if (linkedin && urlSegura(linkedin) === '#') return { erro: 'O LinkedIn precisa ser um link http(s).' };
  const telefone = r.telefone ? (normFone(r.telefone) || r.telefone.trim()) : '';
  if (!r.razao_social && !r.contato_nome && !cnpj && !telefone && !email) {
    return { erro: 'Informe ao menos nome, CNPJ, telefone ou e-mail.' };
  }
  const conc = r.concessionaria || '';
  return {
    patch: {
      razao_social: r.razao_social?.trim() || null,
      cnpj: cnpj || null,
      contato_nome: r.contato_nome?.trim() || null,
      contato_cargo: r.contato_cargo?.trim() || null,
      telefone: telefone || null,
      tel_key: foneKey(telefone) || null,
      telefone2: r.telefone2 ? (normFone(r.telefone2) || r.telefone2.trim()) : null,
      email: email || null,
      email_key: email || null,
      linkedin_url: linkedin || null,
      cep: digits(r.cep || '').slice(0, 8) || null,
      cidade: r.cidade?.trim() || null,
      uf: uf || null,
      concessionaria_codigo: conc || null,
      potencia_kwp: potencia,
      tipo: r.tipo || 'usina_geradora',
      origem: r.origem || 'outro',
      descricao: r.descricao?.trim() || null,
    },
  };
}

async function formularioLead({ titulo, valores, ok, extras = [] }) {
  const concs = await todos('concessionaria');
  const opcConc = [{ v: '', label: '— sem distribuidora / não reconhecida —' },
    ...(concs.length ? concs : CONCESSIONARIAS).slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
      .map((c) => ({ v: c.codigo, label: `${c.nome}${c.uf ? ` (${c.uf})` : ''}` }))];
  let atual = valores;
  for (;;) {
    const r = await perguntar(titulo, [
      { campo: 'razao_social', label: 'Razão social / nome', valor: atual.razao_social },
      { campo: 'cnpj', label: 'CNPJ', valor: atual.cnpj, dica: '14 dígitos, com ou sem máscara' },
      { campo: 'contato_nome', label: 'Nome do contato', valor: atual.contato_nome },
      { campo: 'contato_cargo', label: 'Cargo', valor: atual.contato_cargo },
      { campo: 'telefone', label: 'Telefone', valor: atual.telefone },
      { campo: 'telefone2', label: 'Telefone 2', valor: atual.telefone2 },
      { campo: 'email', label: 'E-mail', valor: atual.email },
      { campo: 'linkedin_url', label: 'LinkedIn', valor: atual.linkedin_url, dica: 'https://…' },
      { campo: 'cep', label: 'CEP', valor: atual.cep },
      { campo: 'cidade', label: 'Cidade', valor: atual.cidade },
      { campo: 'uf', label: 'UF', valor: atual.uf },
      { campo: 'concessionaria', label: 'Distribuidora', tipo: 'select', valor: atual.concessionaria, opcoes: opcConc },
      { campo: 'potencia_kwp', label: 'Potência (kW)', valor: atual.potencia_kwp },
      { campo: 'tipo', label: 'Tipo', tipo: 'select', valor: atual.tipo || 'usina_geradora', opcoes: TIPOS },
      { campo: 'origem', label: 'Origem', tipo: 'select', valor: atual.origem || 'outro', opcoes: ORIGENS.map((o) => ({ v: o.v, label: o.label })) },
      { campo: 'descricao', label: 'Observações', tipo: 'textarea', valor: atual.descricao },
      ...extras.map((e) => ({ ...e, valor: atual[e.campo] ?? e.valor })),
    ], { ok });
    if (!r) return null;
    const v = validarFormularioLead(r);
    if (!v.erro) return { patch: v.patch, bruto: r };
    toast(v.erro, 'erro', 6000);
    atual = r; // reabre com o que foi digitado, para corrigir sem perder nada
  }
}

const valoresDoLead = (l) => ({
  razao_social: l.razao_social || '', cnpj: l.cnpj || '', contato_nome: l.contato_nome || '',
  contato_cargo: l.contato_cargo || '', telefone: l.telefone || '', telefone2: l.telefone2 || '',
  email: l.email || '', linkedin_url: l.linkedin_url || '', cep: l.cep || '', cidade: l.cidade || '',
  uf: l.uf || '', concessionaria: l.concessionaria_codigo || '',
  potencia_kwp: l.potencia_kwp == null ? '' : String(l.potencia_kwp).replace('.', ','),
  tipo: l.tipo || 'usina_geradora', origem: l.origem || 'outro', descricao: l.descricao || '',
});

/** A FK lead.cnpj → empresa exige a linha de empresa; cria uma mínima quando o CNPJ é novo. */
async function garantirEmpresa(cnpj, razao) {
  if (cnpj && !(await get('empresa', cnpj))) await upsertEmpresa({ cnpj, razao_social: razao || undefined });
}

/** Edita TODOS os campos do lead (inclusive limpar). Devolve o lead atualizado, ou null. */
export async function editarLeadCompleto(lead) {
  const r = await formularioLead({ titulo: 'Editar lead', valores: valoresDoLead(lead), ok: 'Salvar' });
  if (!r) return null;
  const { patch } = r;
  try {
    if (patch.cnpj && patch.cnpj !== lead.cnpj) await garantirEmpresa(patch.cnpj, patch.razao_social);
    // se a distribuidora vem do cadastro, o texto bruto deixa de valer
    patch.concessionaria_raw = patch.concessionaria_codigo ? null : (lead.concessionaria_raw || null);
    await atualizarLeads([lead.id], patch);
  } catch (e) {
    toast(e.codigo === '23505' ? 'Já existe outro lead ativo com esse CNPJ.' : e.message, 'erro', 7000);
    return null;
  }
  toast('Lead atualizado.', 'ok');
  return { ...lead, ...patch };
}

/** "Novo lead": cadastro manual. O dono é o próprio usuário (o gestor pode escolher outro). */
export async function criarLeadManual({ perfil, ehGestor, perfis = [] }) {
  const listas = await listasDeImportacao();
  const extras = [];
  if (ehGestor) {
    extras.push({
      campo: 'owner_id', label: 'Dono do lead', tipo: 'select', valor: perfil.id,
      opcoes: perfis.filter((p) => p.ativo).map((p) => ({ v: p.id, label: p.nome })),
    });
  }
  if (listas.length) {
    extras.push({
      campo: 'lista', label: 'Adicionar a uma lista', tipo: 'select', valor: '',
      opcoes: [{ v: '', label: '— nenhuma —' }, ...listas.map((l) => ({ v: l.id, label: l.nome || l.arquivo || 'Lista sem nome' }))],
    });
  }
  let valores = { origem: 'outro', tipo: 'usina_geradora' };
  for (;;) {
    const r = await formularioLead({ titulo: 'Novo lead', ok: 'Criar lead', extras, valores });
    if (!r) return null;
    const { patch } = r;
    const dup = await acharDuplicado({ cnpj: patch.cnpj, telefone: patch.telefone, email: patch.email });
    if (dup) {
      toast(dup.alheio
        ? 'Já existe um lead com esse CNPJ, telefone ou e-mail na carteira de outro agente.'
        : `Já existe o lead "${dup.lead.razao_social || dup.lead.contato_nome || 'sem nome'}" (${statusLabel(dup.lead.status)}) com esse ${dup.por}.`,
      'erro', 7000);
      valores = r.bruto; // reabre o formulário com o que foi digitado, para corrigir sem perder nada
      continue;
    }
    try {
      await garantirEmpresa(patch.cnpj, patch.razao_social);
      const { tel_key: _t, email_key: _e, ...resto } = patch; // criarLead recalcula as chaves
      const novo = await criarLead({
        ...resto, origem_detalhe: 'Cadastro manual',
        owner_id: r.bruto.owner_id || perfil.id,
        import_lote_id: r.bruto.lista || null,
        concessionaria_raw: null,
      });
      toast('Lead criado.', 'ok');
      return novo;
    } catch (e) {
      toast(e.codigo === '23505' ? 'Já existe um lead ativo com esse CNPJ.' : e.message, 'erro', 7000);
      return null;
    }
  }
}
