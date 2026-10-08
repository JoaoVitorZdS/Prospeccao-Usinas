// leads-filtro.test.mjs — visões, filtros combináveis e ida e volta com a URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEWS, CONC_SEM_CODIGO, novosFiltros, lerParams, paraParams, temFiltro,
  passaNaView, filtrarLeads, contarViews, potenciaDe, precisaDeEmpresas,
} from '../js/leads-filtro.js';

const HOJE = '2026-10-07';
const EU = 'p-eu';
const OUTRO = 'p-outro';
const ctx = { perfilId: EU, hoje: HOJE };

const lead = (o) => ({
  id: o.id, owner_id: EU, status: 'a_abordar', tentativas: 0, deleted_at: null, opt_out: false,
  proxima_acao_em: HOJE, created_at: '2026-09-01T10:00:00Z', ...o,
});

const LEADS = [
  lead({ id: 'a', razao_social: 'Solar Vale', cnpj: '11111111000111', concessionaria_codigo: 'ENEL-SP', uf: 'SP', cidade: 'Campinas', telefone: '11999990001', potencia_kwp: 500 }),
  lead({ id: 'b', razao_social: 'Agro Sol', cnpj: '22222222000122', concessionaria_codigo: 'ENEL-SP', uf: 'SP', status: 'abordado', proxima_acao_em: '2026-10-05', tentativas: 2, email: 'x@agro.com' }),
  lead({ id: 'c', razao_social: 'Hotel Mar', concessionaria_codigo: null, concessionaria_raw: 'Cooperativa Zeta', uf: 'RJ', status: 'em_conversa', proxima_acao_em: '2026-10-20', origem: 'planilha_legada', import_lote_id: 'L1' }),
  lead({ id: 'd', razao_social: 'Clínica Vida', owner_id: OUTRO, concessionaria_codigo: 'LIGHT', uf: 'RJ', status: 'ganho', proxima_acao_em: null, opt_out: true }),
  lead({ id: 'e', razao_social: 'Frigorífico Azul', status: 'perdido', proxima_acao_em: null, ultimo_contato_em: '2026-09-15' }),
  lead({ id: 'f', razao_social: 'Devolvido SA', deleted_at: '2026-10-01T00:00:00Z', devolvido_em: '2026-10-01T00:00:00Z' }),
];
const ids = (r) => r.map((l) => l.id).sort().join('');
const f = (parcial = {}) => ({ ...novosFiltros(), ...parcial });
const buscar = (view, filtros = f(), texto = '', c = ctx) => ids(filtrarLeads(LEADS, { view, texto, filtros }, c));

test('visões — Hoje inclui o vencido; Atrasados só o que já passou; Novos, Aguardando', () => {
  assert.equal(buscar('hoje'), 'ab');       // a vence hoje, b está atrasado; c é futuro
  assert.equal(buscar('atrasados'), 'b');
  assert.equal(buscar('novos'), 'a');
  assert.equal(buscar('aguardando'), 'bc');
});

test('visões — Meus não traz lead de outro nem devolvido; Equipe traz todos os ativos', () => {
  assert.equal(buscar('meus'), 'abce');
  assert.equal(buscar('todos'), 'abcde');
});

test('visões — Concluídos e Devolvidos', () => {
  assert.equal(buscar('concluidos'), 'de');
  assert.equal(buscar('devolvidos'), 'f');
});

test('contarViews — uma passada, mesmos números das visões', () => {
  const c = contarViews(LEADS, ctx);
  assert.equal(c.hoje, 2);
  assert.equal(c.atrasados, 1);
  assert.equal(c.meus, 4);
  assert.equal(c.todos, 5);
  assert.equal(c.devolvidos, 1);
  assert.deepEqual(Object.keys(c), VIEWS.map((v) => v.v));
});

test('filtro de distribuidora — código, e "não reconhecida" para o que ficou só em concessionaria_raw', () => {
  assert.equal(buscar('todos', f({ conc: 'ENEL-SP' })), 'ab');
  assert.equal(buscar('todos', f({ conc: 'LIGHT' })), 'd');
  assert.equal(buscar('todos', f({ conc: CONC_SEM_CODIGO })), 'ce');
});

test('filtros combinam em E: UF + status + dono', () => {
  assert.equal(buscar('todos', f({ uf: 'RJ' })), 'cd');
  assert.equal(buscar('todos', f({ uf: 'RJ', status: ['em_conversa', 'ganho'] })), 'cd');
  assert.equal(buscar('todos', f({ uf: 'RJ', status: ['ganho'] })), 'd');
  assert.equal(buscar('todos', f({ dono: OUTRO })), 'd');
});

test('filtros — origem, lista, cidade (sem acento), tentativas', () => {
  assert.equal(buscar('todos', f({ origem: 'planilha_legada' })), 'c');
  assert.equal(buscar('todos', f({ lista: 'L1' })), 'c');
  assert.equal(buscar('todos', f({ lista: '__sem' })), 'abde');
  assert.equal(buscar('todos', f({ cidade: 'campínas' })), 'a');
  assert.equal(buscar('todos', f({ tentMin: '2' })), 'b');
  assert.equal(buscar('todos', f({ tentMax: '0' })), 'acde');
});

test('filtros — contato (telefone, e-mail, opt-out) e faixas de data', () => {
  assert.equal(buscar('todos', f({ comTel: true })), 'a');
  assert.equal(buscar('todos', f({ comEmail: true })), 'b');
  assert.equal(buscar('todos', f({ optOut: true })), 'd');
  assert.equal(buscar('todos', f({ paDe: '2026-10-06' })), 'ac');
  assert.equal(buscar('todos', f({ paAte: '2026-10-05' })), 'b');
  assert.equal(buscar('todos', f({ ucDe: '2026-09-01', ucAte: '2026-09-30' })), 'e');
  assert.equal(buscar('todos', f({ crDe: '2026-09-02' })), '');
});

test('potência — usa a do lead e cai para a da empresa; sem nenhuma, não passa no filtro', () => {
  const empresas = new Map([['22222222000122', { potencia_total_kw: 1200 }]]);
  assert.equal(potenciaDe(LEADS[0], empresas), 500);
  assert.equal(potenciaDe(LEADS[1], empresas), 1200);
  assert.equal(potenciaDe(LEADS[2], empresas), null);
  const c = { ...ctx, empresas };
  assert.equal(buscar('todos', f({ potMin: '1000' }), '', c), 'b');
  assert.equal(buscar('todos', f({ potMin: '100', potMax: '600' }), '', c), 'a');
  assert.equal(precisaDeEmpresas(f({ potMin: '1' })), true);
  assert.equal(precisaDeEmpresas(f({ uf: 'SP' })), false);
});

test('busca de texto — nome sem acento, CNPJ e telefone por dígitos', () => {
  assert.equal(buscar('todos', f(), 'clinica'), 'd');
  assert.equal(buscar('todos', f(), '11.111.111/0001-11'), 'a');
  assert.equal(buscar('todos', f(), '99999-0001'), 'a');
  assert.equal(buscar('todos', f(), 'zzz'), '');
});

test('URL — ida e volta preserva o estado e omite o vazio', () => {
  const estado = {
    view: 'todos', texto: 'solar',
    filtros: f({ conc: 'ENEL-SP', uf: 'SP', status: ['abordado', 'em_conversa'], comTel: true, paDe: '2026-10-01', potMin: '100' }),
  };
  const params = paraParams(estado);
  assert.deepEqual(params, {
    f: 'todos', q: 'solar', conc: 'ENEL-SP', uf: 'SP', pmin: '100', tel: '1',
    pa_de: '2026-10-01', status: 'abordado,em_conversa',
  });
  const volta = lerParams(params);
  assert.equal(volta.view, 'todos');
  assert.equal(volta.texto, 'solar');
  assert.deepEqual(volta.filtros, estado.filtros);
  assert.deepEqual(paraParams({ view: 'hoje', texto: '', filtros: novosFiltros() }), {});
});

test('URL — link do Backlog (?conc=) abre em "Todos os meus", não em "Hoje" (que esconderia o resultado)', () => {
  const { view, filtros } = lerParams({ conc: 'ENEL-SP' });
  assert.equal(view, 'meus');
  assert.equal(filtros.conc, 'ENEL-SP');
  assert.equal(lerParams({}).view, 'hoje');
  assert.equal(lerParams({ q: 'abc' }).view, 'meus');
  assert.equal(lerParams({ f: 'invalida' }).view, 'hoje');
});

test('temFiltro — detecta qualquer filtro ativo, inclusive lista de status', () => {
  assert.equal(temFiltro(novosFiltros()), false);
  assert.equal(temFiltro(f({ status: ['a_abordar'] })), true);
  assert.equal(temFiltro(f({ optOut: true })), true);
  assert.equal(temFiltro(f({ uf: 'SP' })), true);
});

test('passaNaView — visão desconhecida cai em "meus"', () => {
  assert.equal(passaNaView('qualquer', LEADS[0], ctx), true);
  assert.equal(passaNaView('qualquer', LEADS[3], ctx), false);
});
