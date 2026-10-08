// crm-calculos.test.mjs — tarefas, quadro de negócios e resumo do início.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ETAPAS_QUADRO, ENCERRAMENTOS, agruparTarefas, colunasDoQuadro, contarEncerrados, resumoInicio, funil, atividadeRecente,
} from '../js/crm-calculos.js';

const HOJE = '2026-10-07';
const l = (id, status, extra = {}) => ({ id, status, tentativas: 0, deleted_at: null, potencia_kwp: 100, proxima_acao_em: null, ...extra });

test('agruparTarefas — atrasadas, hoje, próximos 7 dias, depois e sem data; só leads em trabalho', () => {
  const leads = [
    l('a', 'a_abordar', { proxima_acao_em: '2026-10-01' }),
    l('b', 'abordado', { proxima_acao_em: '2026-10-07' }),
    l('c', 'em_conversa', { proxima_acao_em: '2026-10-10' }),
    l('d', 'proposta', { proxima_acao_em: '2026-10-14' }),   // limite (hoje + 7)
    l('e', 'qualificado', { proxima_acao_em: '2026-10-15' }), // depois
    l('f', 'a_abordar'),                                      // sem data
    l('g', 'ganho', { proxima_acao_em: '2026-10-01' }),       // concluído: não é tarefa
    l('h', 'perdido', { proxima_acao_em: '2026-10-07' }),
    l('i', 'a_abordar', { proxima_acao_em: '2026-10-01', deleted_at: '2026-10-02' }), // devolvido
  ];
  const g = agruparTarefas(leads, HOJE);
  const ids = (x) => x.map((t) => t.id).join('');
  assert.equal(ids(g.atrasadas), 'a');
  assert.equal(ids(g.hoje), 'b');
  assert.equal(ids(g.proximos), 'cd');
  assert.equal(ids(g.depois), 'e');
  assert.equal(ids(g.semData), 'f');
});

test('agruparTarefas — dentro do grupo, mais antigo primeiro e menos tentativas desempata', () => {
  const g = agruparTarefas([
    l('x', 'a_abordar', { proxima_acao_em: '2026-10-03', tentativas: 3 }),
    l('y', 'a_abordar', { proxima_acao_em: '2026-10-03', tentativas: 1 }),
    l('z', 'a_abordar', { proxima_acao_em: '2026-10-01' }),
  ], HOJE);
  assert.deepEqual(g.atrasadas.map((t) => t.id), ['z', 'y', 'x']);
});

test('colunasDoQuadro — uma coluna por etapa, com contagem e kW; devolvidos ficam de fora', () => {
  const cols = colunasDoQuadro([
    l('a', 'a_abordar', { potencia_kwp: 200 }), l('b', 'a_abordar', { potencia_kwp: 300 }),
    l('c', 'ganho', { potencia_kwp: 50 }), l('d', 'perdido'), l('e', 'abordado', { deleted_at: '2026-10-01' }),
  ]);
  assert.deepEqual(cols.map((c) => c.etapa), ETAPAS_QUADRO);
  assert.equal(cols[0].total, 2);
  assert.equal(cols[0].potencia, 500);
  assert.equal(cols.find((c) => c.etapa === 'ganho').potencia, 50);
  assert.equal(cols.find((c) => c.etapa === 'abordado').total, 0);
  assert.equal(cols.reduce((s, c) => s + c.total, 0), 3, 'perdido não aparece nas colunas');
});

test('colunasDoQuadro — usa a função de potência recebida (fallback para a empresa)', () => {
  const cols = colunasDoQuadro([l('a', 'proposta', { potencia_kwp: null, cnpj: '1' })], (x) => (x.cnpj === '1' ? 750 : 0));
  assert.equal(cols.find((c) => c.etapa === 'proposta').potencia, 750);
});

test('contarEncerrados — perdido, sem contato e descartado', () => {
  const c = contarEncerrados([l('a', 'perdido'), l('b', 'perdido'), l('c', 'descartado'), l('d', 'sem_contato', { deleted_at: 'x' }), l('e', 'ganho')]);
  assert.deepEqual(c, { perdido: 2, sem_contato: 0, descartado: 1 });
  assert.deepEqual(ENCERRAMENTOS, ['perdido', 'sem_contato', 'descartado']);
});

test('resumoInicio — tarefas, pipeline, ganhos, semana e taxa de ganho', () => {
  const leads = [
    l('a', 'a_abordar', { proxima_acao_em: HOJE, potencia_kwp: 100 }),
    l('b', 'abordado', { proxima_acao_em: '2026-10-01', potencia_kwp: 200 }),
    l('c', 'ganho', { potencia_kwp: 400 }),
    l('d', 'perdido', { potencia_kwp: 999 }),
    l('e', 'proposta', { proxima_acao_em: '2026-10-20', potencia_kwp: 300 }),
  ];
  const interacoes = [
    { lead_id: 'a', ocorrido_em: '2026-10-06T12:00:00Z' }, { lead_id: 'a', ocorrido_em: '2026-10-05T12:00:00Z' },
    { lead_id: 'b', ocorrido_em: '2026-10-02T12:00:00Z' }, { lead_id: 'c', ocorrido_em: '2026-09-01T12:00:00Z' },
  ];
  const r = resumoInicio({ leads, interacoes, hoje: HOJE });
  assert.equal(r.tarefasHoje, 1);
  assert.equal(r.atrasadas, 1);
  assert.equal(r.emPipeline, 3);
  assert.equal(r.potenciaPipeline, 600);
  assert.equal(r.ganhos, 1);
  assert.equal(r.potenciaGanha, 400);
  assert.equal(r.contatosSemana, 3);
  assert.equal(r.leadsTocadosSemana, 2);
  assert.equal(r.taxaGanho, 1 / 4, '1 ganho entre os 4 que saíram de "a abordar"');
  assert.equal(r.total, 5);
  assert.equal(resumoInicio({ leads: [], interacoes: [], hoje: HOJE }).taxaGanho, 0);
});

test('funil — só os status com leads, com kW', () => {
  const f = funil([l('a', 'a_abordar', { potencia_kwp: 10 }), l('b', 'a_abordar', { potencia_kwp: 5 }), l('c', 'ganho', { potencia_kwp: 7 })]);
  assert.deepEqual(f.map((x) => [x.status, x.total, x.potencia]), [['a_abordar', 2, 15], ['ganho', 1, 7]]);
});

test('atividadeRecente — mais recentes primeiro, só de leads conhecidos, com limite', () => {
  const mapa = new Map([['a', { id: 'a' }], ['b', { id: 'b' }]]);
  const r = atividadeRecente([
    { id: 1, lead_id: 'a', ocorrido_em: '2026-10-01T10:00:00Z' }, { id: 2, lead_id: 'b', ocorrido_em: '2026-10-05T10:00:00Z' },
    { id: 3, lead_id: 'x', ocorrido_em: '2026-10-06T10:00:00Z' }, { id: 4, lead_id: 'a', ocorrido_em: '2026-10-03T10:00:00Z' },
  ], mapa, 2);
  assert.deepEqual(r.map((i) => i.id), [2, 4]);
  assert.equal(r[0].lead.id, 'b');
});
