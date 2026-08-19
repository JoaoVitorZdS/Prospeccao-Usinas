// seed.js — vocabulário controlado e dados de referência.
// A lista de concessionárias espelha `hd_oferta_concessionaria` do titan-helpdesk
// (seção 12.2 do plano): mesmos `codigo`/`aliases`, para o join futuro ser trivial.
// Os aliases existem para casar o campo `NomAgente` da ANEEL com o código canônico.

export const CONCESSIONARIAS = [
  { codigo: 'CPFL-PAULISTA', nome: 'CPFL Paulista', uf: 'SP', aliases: ['CPFL', 'CPFL PAULISTA', 'COMPANHIA PAULISTA DE FORCA E LUZ'] },
  { codigo: 'CPFL-PIRATININGA', nome: 'CPFL Piratininga', uf: 'SP', aliases: ['CPFL PIRATININGA', 'COMPANHIA PIRATININGA DE FORCA E LUZ'] },
  { codigo: 'CPFL-SANTA-CRUZ', nome: 'CPFL Santa Cruz', uf: 'SP', aliases: ['CPFL SANTA CRUZ', 'COMPANHIA LUZ E FORCA SANTA CRUZ'] },
  { codigo: 'RGE', nome: 'RGE Sul', uf: 'RS', aliases: ['RGE', 'RGE SUL', 'RIO GRANDE ENERGIA'] },
  { codigo: 'CEMIG-D', nome: 'CEMIG Distribuição', uf: 'MG', aliases: ['CEMIG', 'CEMIG-D', 'CEMIG D', 'CEMIG DISTRIBUICAO'] },
  { codigo: 'COPEL-DIS', nome: 'Copel Distribuição', uf: 'PR', aliases: ['COPEL', 'COPEL-DIS', 'COPEL DIS', 'COPEL DISTRIBUICAO'] },
  { codigo: 'CELESC-DIS', nome: 'Celesc Distribuição', uf: 'SC', aliases: ['CELESC', 'CELESC-DIS', 'CELESC DIS', 'CELESC DISTRIBUICAO'] },
  { codigo: 'LIGHT', nome: 'Light SESA', uf: 'RJ', aliases: ['LIGHT', 'LIGHT SESA', 'LIGHT SERVICOS DE ELETRICIDADE'] },
  { codigo: 'ENEL-SP', nome: 'Enel Distribuição São Paulo', uf: 'SP', aliases: ['ENEL SP', 'ENEL-SP', 'ELETROPAULO', 'ENEL DISTRIBUICAO SAO PAULO'] },
  { codigo: 'ENEL-RJ', nome: 'Enel Distribuição Rio', uf: 'RJ', aliases: ['ENEL RJ', 'ENEL-RJ', 'AMPLA', 'ENEL DISTRIBUICAO RIO'] },
  { codigo: 'ENEL-CE', nome: 'Enel Distribuição Ceará', uf: 'CE', aliases: ['ENEL CE', 'ENEL-CE', 'COELCE', 'ENEL DISTRIBUICAO CEARA'] },
  { codigo: 'ENEL-GO', nome: 'Enel Distribuição Goiás', uf: 'GO', aliases: ['ENEL GO', 'ENEL-GO', 'CELG', 'CELG-D', 'ENEL DISTRIBUICAO GOIAS', 'EQUATORIAL GO'] },
  { codigo: 'ELEKTRO', nome: 'Neoenergia Elektro', uf: 'SP', aliases: ['ELEKTRO', 'NEOENERGIA ELEKTRO'] },
  { codigo: 'COELBA', nome: 'Neoenergia Coelba', uf: 'BA', aliases: ['COELBA', 'NEOENERGIA COELBA', 'NEOENERGIA BA'] },
  { codigo: 'CELPE', nome: 'Neoenergia Pernambuco', uf: 'PE', aliases: ['CELPE', 'NEOENERGIA PE', 'NEOENERGIA PERNAMBUCO'] },
  { codigo: 'COSERN', nome: 'Neoenergia Cosern', uf: 'RN', aliases: ['COSERN', 'NEOENERGIA RN', 'NEOENERGIA COSERN'] },
  { codigo: 'CEB-DIS', nome: 'Neoenergia Brasília', uf: 'DF', aliases: ['CEB', 'CEB-DIS', 'NEOENERGIA BRASILIA', 'NEOENERGIA DF'] },
  { codigo: 'EDP-SP', nome: 'EDP São Paulo', uf: 'SP', aliases: ['EDP SP', 'EDP-SP', 'BANDEIRANTE', 'EDP SAO PAULO'] },
  { codigo: 'EDP-ES', nome: 'EDP Espírito Santo', uf: 'ES', aliases: ['EDP ES', 'EDP-ES', 'ESCELSA', 'EDP ESPIRITO SANTO'] },
  { codigo: 'ENERGISA-MT', nome: 'Energisa Mato Grosso', uf: 'MT', aliases: ['ENERGISA MT', 'CEMAT', 'ENERGISA MATO GROSSO'] },
  { codigo: 'ENERGISA-MS', nome: 'Energisa Mato Grosso do Sul', uf: 'MS', aliases: ['ENERGISA MS', 'ENERSUL', 'ENERGISA MATO GROSSO DO SUL'] },
  { codigo: 'ENERGISA-PB', nome: 'Energisa Paraíba', uf: 'PB', aliases: ['ENERGISA PB', 'SAELPA', 'ENERGISA PARAIBA'] },
  { codigo: 'ENERGISA-SE', nome: 'Energisa Sergipe', uf: 'SE', aliases: ['ENERGISA SE', 'ENERGIPE', 'ENERGISA SERGIPE'] },
  { codigo: 'ENERGISA-MG', nome: 'Energisa Minas Gerais', uf: 'MG', aliases: ['ENERGISA MG', 'ENERGISA MINAS GERAIS'] },
  { codigo: 'ENERGISA-TO', nome: 'Energisa Tocantins', uf: 'TO', aliases: ['ENERGISA TO', 'CELTINS', 'ENERGISA TOCANTINS'] },
  { codigo: 'ENERGISA-SS', nome: 'Energisa Sul-Sudeste', uf: 'SP', aliases: ['ENERGISA SUL-SUDESTE', 'ENERGISA SUL SUDESTE', 'CAIUA'] },
  { codigo: 'ENERGISA-RO', nome: 'Energisa Rondônia', uf: 'RO', aliases: ['ENERGISA RO', 'CERON', 'ENERGISA RONDONIA'] },
  { codigo: 'ENERGISA-AC', nome: 'Energisa Acre', uf: 'AC', aliases: ['ENERGISA AC', 'ELETROACRE', 'ENERGISA ACRE'] },
  { codigo: 'ENERGISA-NF', nome: 'Energisa Nova Friburgo', uf: 'RJ', aliases: ['ENERGISA NOVA FRIBURGO', 'CENF'] },
  { codigo: 'EQUATORIAL-PA', nome: 'Equatorial Pará', uf: 'PA', aliases: ['EQUATORIAL PA', 'CELPA', 'EQUATORIAL PARA'] },
  { codigo: 'EQUATORIAL-MA', nome: 'Equatorial Maranhão', uf: 'MA', aliases: ['EQUATORIAL MA', 'CEMAR', 'EQUATORIAL MARANHAO'] },
  { codigo: 'EQUATORIAL-PI', nome: 'Equatorial Piauí', uf: 'PI', aliases: ['EQUATORIAL PI', 'CEPISA', 'EQUATORIAL PIAUI'] },
  { codigo: 'EQUATORIAL-AL', nome: 'Equatorial Alagoas', uf: 'AL', aliases: ['EQUATORIAL AL', 'CEAL', 'EQUATORIAL ALAGOAS'] },
  { codigo: 'EQUATORIAL-RS', nome: 'Equatorial CEEE', uf: 'RS', aliases: ['CEEE', 'CEEE-D', 'EQUATORIAL RS', 'EQUATORIAL CEEE'] },
  { codigo: 'EQUATORIAL-AP', nome: 'Equatorial Amapá', uf: 'AP', aliases: ['CEA', 'EQUATORIAL AP', 'EQUATORIAL AMAPA'] },
  { codigo: 'AME', nome: 'Amazonas Energia', uf: 'AM', aliases: ['AMAZONAS ENERGIA', 'AME', 'CEAM'] },
  { codigo: 'RORAIMA', nome: 'Roraima Energia', uf: 'RR', aliases: ['RORAIMA ENERGIA', 'BOA VISTA ENERGIA'] },
  { codigo: 'SULGIPE', nome: 'Sulgipe', uf: 'SE', aliases: ['SULGIPE', 'CIA SUL SERGIPANA DE ELETRICIDADE'] },
  { codigo: 'COCEL', nome: 'Cocel', uf: 'PR', aliases: ['COCEL', 'COMPANHIA CAMPOLARGUENSE DE ENERGIA'] },
  { codigo: 'FORCEL', nome: 'Forcel', uf: 'PR', aliases: ['FORCEL', 'FORCA E LUZ CORONEL VIVIDA'] },
  { codigo: 'DMED', nome: 'DMED', uf: 'MG', aliases: ['DMED', 'DME DISTRIBUICAO'] },
  { codigo: 'MUX', nome: 'MUX Energia', uf: 'RS', aliases: ['MUX', 'MUX ENERGIA', 'MUXFELDT MARIN'] },
  { codigo: 'EFLUL', nome: 'EFLUL', uf: 'SC', aliases: ['EFLUL', 'EMPRESA FORCA E LUZ URUSSANGA'] },
  { codigo: 'HIDROPAN', nome: 'Hidropan', uf: 'RS', aliases: ['HIDROPAN'] },
  { codigo: 'CERR', nome: 'CERR', uf: 'RR', aliases: ['CERR'] },
  { codigo: 'OUTRA', nome: 'Outra / não identificada', uf: null, aliases: [] },
];

/* ══ Estágios (seção 5.3) ══
   "Desenvolveu" é resultado, não estado de trabalho. Estes são o mínimo para existir fila.
   `fila` = aparece na fila de trabalho.  `desenvolveu` = vira "Sim" na coluna do export. */
export const STATUS = [
  { v: 'a_abordar', label: 'A abordar', cor: 'azul', fila: true, desenvolveu: false, ordem: 1 },
  { v: 'abordado', label: 'Abordado', cor: 'roxo', fila: true, desenvolveu: false, ordem: 2 },
  { v: 'em_conversa', label: 'Em conversa', cor: 'ciano', fila: true, desenvolveu: false, ordem: 3 },
  { v: 'qualificado', label: 'Qualificado', cor: 'verde', fila: true, desenvolveu: true, ordem: 4 },
  { v: 'proposta', label: 'Proposta', cor: 'ambar', fila: true, desenvolveu: true, ordem: 5 },
  { v: 'ganho', label: 'Ganho', cor: 'verde-forte', fila: false, desenvolveu: true, ordem: 6 },
  { v: 'perdido', label: 'Perdido', cor: 'vermelho', fila: false, desenvolveu: false, ordem: 7 },
  { v: 'sem_contato', label: 'Sem contato', cor: 'cinza', fila: false, desenvolveu: false, ordem: 8 },
  { v: 'descartado', label: 'Descartado', cor: 'cinza', fila: false, desenvolveu: false, ordem: 9 },
];
export const STATUS_MAP = Object.fromEntries(STATUS.map((s) => [s.v, s]));
export const statusLabel = (v) => STATUS_MAP[v]?.label || v || '—';
export const STATUS_FILA = STATUS.filter((s) => s.fila).map((s) => s.v);

export const MOTIVOS_PERDA = [
  'Já tem parceiro/contrato',
  'Sem interesse',
  'Usina vendida / desativada',
  'Potência fora do perfil',
  'Preço / condição comercial',
  'Não é o decisor e não repassou',
  'Sem retorno após N tentativas',
  'Outro',
];

export const ORIGENS = [
  { v: 'aneel', label: 'ANEEL' },
  { v: 'casa_dos_dados', label: 'Casa dos Dados' },
  { v: 'cnpj_biz', label: 'CNPJ Biz' },
  { v: 'linkedin', label: 'LinkedIn' },
  { v: 'whatsapp', label: 'WhatsApp' },
  { v: 'grupo_whatsapp', label: 'Grupo de WhatsApp' },
  { v: 'facebook', label: 'Facebook' },
  { v: 'google', label: 'Google' },
  { v: 'telegram', label: 'Telegram' },
  { v: 'indicacao', label: 'Indicação' },
  { v: 'evento', label: 'Evento' },
  { v: 'planilha_legada', label: 'Planilha legada' },
  { v: 'outro', label: 'Outro' },
];
export const origemLabel = (v) => ORIGENS.find((o) => o.v === v)?.label || v || '—';

/* Canais — a ordem define o atalho de teclado 1..8 no cockpit. */
export const CANAIS = [
  { v: 'whatsapp', label: 'WhatsApp', icone: '💬' },
  { v: 'linkedin', label: 'LinkedIn', icone: '💼' },
  { v: 'telefone', label: 'Telefone', icone: '📞' },
  { v: 'email', label: 'E-mail', icone: '✉️' },
  { v: 'telegram', label: 'Telegram', icone: '✈️' },
  { v: 'facebook', label: 'Facebook', icone: '📘' },
  { v: 'presencial', label: 'Presencial', icone: '🤝' },
  { v: 'outro', label: 'Outro', icone: '•' },
];

/* Resultado do toque → status sugerido e próxima ação (seção 7.C).
   É isso que faz o registro caber em 2 cliques. */
export const RESULTADOS = [
  { v: 'sem_resposta', label: 'Sem resposta', status: 'abordado', adiar: 3 },
  { v: 'respondeu', label: 'Respondeu', status: 'em_conversa', adiar: 2 },
  { v: 'agendou', label: 'Agendou', status: 'qualificado', adiar: 1 },
  { v: 'pediu_retorno', label: 'Pediu retorno', status: 'em_conversa', adiar: 7 },
  { v: 'recusou', label: 'Recusou', status: 'perdido', adiar: null, exigeMotivo: true },
  { v: 'numero_errado', label: 'Número errado', status: 'abordado', adiar: 1 },
  { v: 'sem_perfil', label: 'Sem perfil', status: 'descartado', adiar: null, exigeMotivo: true },
];
export const RESULTADO_MAP = Object.fromEntries(RESULTADOS.map((r) => [r.v, r]));

export const TIPOS_GERACAO = {
  UFV: 'Solar (UFV)', EOL: 'Eólica (EOL)', UTE: 'Térmica (UTE)',
  CGH: 'Hidráulica (CGH)', PCH: 'PCH', CGU: 'Undi-elétrica',
};

export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
  'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];

/* Script padrão. Placeholder sem valor vira "_____", nunca "undefined" (seção 7.C). */
export const SCRIPT_PADRAO = `Olá {{contato_nome}}, tudo bem?

Sou {{agente}}, da Alexandria. Trabalhamos com gestão de usinas de geração distribuída e vi que a {{razao_social}} tem geração própria em {{cidade}}, na área da {{concessionaria}} ({{potencia}}).

Faço uma pergunta rápida: hoje a energia excedente dessa usina já está sendo comercializada, ou os créditos ficam parados na distribuidora?

Se fizer sentido, te mando em 2 minutos como funciona — sem compromisso.`;

export const PLACEHOLDERS = [
  ['{{contato_nome}}', 'Nome do contato'],
  ['{{razao_social}}', 'Razão social da empresa'],
  ['{{cidade}}', 'Cidade'],
  ['{{uf}}', 'UF'],
  ['{{concessionaria}}', 'Distribuidora'],
  ['{{potencia}}', 'Potência somada das usinas'],
  ['{{qtd_usinas}}', 'Quantidade de usinas'],
  ['{{cnpj}}', 'CNPJ com máscara'],
  ['{{agente}}', 'Seu nome'],
];

/** Resolve o template. Placeholder vazio vira "_____" — nunca "undefined". */
export function renderScript(tpl, ctx) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = ctx[k];
    return v == null || v === '' ? '_____' : String(v);
  });
}

/* Colunas 1–10 na ordem exata da planilha atual (seção 7.F).
   Não mudar a ordem: é o hábito de quem recebe. */
export const COLUNAS_PLANILHA = [
  'Origem da prospecção', 'Nome', 'Telefone', 'E-mail', 'Desenvolveu',
  'Data do contato', 'Autor do contato', 'Concessionária', 'CEP', 'Descrição do contato',
];
export const COLUNAS_EXTRAS = [
  'Razão social', 'CNPJ', 'Tipo', 'Status', 'Cidade', 'UF', 'Potência (kW)',
  'Nº de usinas', 'Tentativas', 'Primeiro contato', 'Próxima ação', 'ID do lead',
];
