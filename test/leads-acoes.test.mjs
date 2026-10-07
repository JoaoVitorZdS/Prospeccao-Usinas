// leads-acoes.test.mjs — validação do formulário de lead e regra de "completar dados".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarFormularioLead, camposParaCompletar } from '../js/leads-acoes.js';

const base = { razao_social: 'Solar Vale Ltda', cnpj: '', email: '', uf: '', potencia_kwp: '', telefone: '' };

test('validarFormularioLead — aceita o mínimo e normaliza (nulls explícitos para poder limpar campos)', () => {
  const { patch, erro } = validarFormularioLead({ ...base, cnpj: '11.222.333/0001-81', uf: 'sp', potencia_kwp: '1.250,5', telefone: '(11) 98765-4321', email: 'Contato@Solar.com.br' });
  assert.equal(erro, undefined);
  assert.equal(patch.cnpj, '11222333000181');
  assert.equal(patch.uf, 'SP');
  assert.equal(patch.potencia_kwp, 1250.5);
  assert.equal(patch.email, 'contato@solar.com.br');
  assert.equal(patch.email_key, 'contato@solar.com.br');
  assert.ok(patch.tel_key && patch.tel_key.length === 8, 'chave de telefone com os 8 últimos dígitos');
  assert.equal(patch.telefone2, null);
  assert.equal(patch.contato_nome, null);
  assert.equal(patch.tipo, 'usina_geradora');
  assert.equal(patch.origem, 'outro');
});

test('validarFormularioLead — limpar um campo vira null (e não "mantém o antigo")', () => {
  const { patch } = validarFormularioLead({ ...base, telefone: '', email: '', cnpj: '' });
  assert.equal(patch.telefone, null);
  assert.equal(patch.email, null);
  assert.equal(patch.cnpj, null);
  assert.equal(patch.tel_key, null);
});

test('validarFormularioLead — recusa CNPJ, e-mail, UF, potência e LinkedIn inválidos', () => {
  assert.match(validarFormularioLead({ ...base, cnpj: '123' }).erro, /CNPJ inválido/);
  assert.match(validarFormularioLead({ ...base, email: 'sem-arroba' }).erro, /E-mail inválido/);
  assert.match(validarFormularioLead({ ...base, uf: 'XX' }).erro, /UF "XX"/);
  assert.match(validarFormularioLead({ ...base, potencia_kwp: 'muito' }).erro, /Potência inválida/);
  assert.match(validarFormularioLead({ ...base, potencia_kwp: '-5' }).erro, /Potência inválida/);
  assert.match(validarFormularioLead({ ...base, linkedin_url: 'javascript:alert(1)' }).erro, /http/);
});

test('validarFormularioLead — exige alguma identificação', () => {
  assert.match(validarFormularioLead({ razao_social: '', cnpj: '', telefone: '', email: '' }).erro, /ao menos/);
  assert.equal(validarFormularioLead({ razao_social: '', cnpj: '', telefone: '(11) 98765-4321', email: '' }).erro, undefined);
});

test('camposParaCompletar — preenche só o que está vazio, nunca sobrescreve', () => {
  const lead = { telefone: '11911112222', email: '', razao_social: 'Nome digitado pelo agente', cidade: null, uf: undefined };
  const empresa = {
    telefone1: '11999990000', telefone2: '1133334444', email: 'novo@empresa.com', razao_social: 'RAZAO DA RECEITA',
    municipio_principal: 'Campinas', uf_principal: 'SP', cep: '13000000',
  };
  const { patch, preenchidos } = camposParaCompletar(lead, empresa);
  assert.equal(patch.telefone, undefined, 'telefone já existia');
  assert.equal(patch.razao_social, undefined, 'nome digitado pelo agente é preservado');
  assert.equal(patch.email, 'novo@empresa.com');
  assert.equal(patch.email_key, 'novo@empresa.com');
  assert.equal(patch.telefone2, '1133334444');
  assert.equal(patch.cidade, 'Campinas');
  assert.equal(patch.uf, 'SP');
  assert.equal(patch.cep, '13000000');
  assert.deepEqual(preenchidos.sort(), ['CEP', 'UF', 'cidade', 'e-mail', 'telefone 2'].sort());
});

test('camposParaCompletar — empresa sem dados não gera patch', () => {
  assert.deepEqual(camposParaCompletar({ telefone: '', email: '' }, {}), { patch: {}, preenchidos: [] });
  assert.deepEqual(camposParaCompletar({ telefone: '' }, null), { patch: {}, preenchidos: [] });
});
