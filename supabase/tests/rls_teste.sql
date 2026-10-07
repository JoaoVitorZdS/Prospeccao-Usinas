-- rls_teste.sql — prova que o RLS de 0006_auth_rls.sql isola mesmo os agentes.
--
-- Como rodar: SQL Editor do Supabase → cole TUDO → Run. Roda numa transação e termina
-- em ROLLBACK, então não deixa nada no banco (cria usuários e leads de mentira).
-- Cada bloco imprime "ok: …" (aba Messages/Notices) ou aborta com "FALHOU: …".
-- Se terminar sem erro até a linha ROLLBACK, o isolamento está valendo.
--
-- Personagens: G = gestor · A e B = agentes ativos · P = conta pendente.
-- Cada um tem usuário em auth.users e perfil em public.profiles; A e B têm 2 leads cada.

begin;

/* ── massa de teste (como postgres) ── */
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'g@teste.local', now()),
  ('00000000-0000-0000-0000-0000000000a2', 'authenticated', 'authenticated', 'a@teste.local', now()),
  ('00000000-0000-0000-0000-0000000000a3', 'authenticated', 'authenticated', 'b@teste.local', now()),
  ('00000000-0000-0000-0000-0000000000a4', 'authenticated', 'authenticated', 'p@teste.local', now());

insert into public.profiles (id, nome, email, papel, ativo, auth_user_id) values
  ('00000000-0000-0000-0000-0000000000b1', 'G Gestor',  'g@teste.local', 'gestor', true,  '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000b2', 'A Agente',  'a@teste.local', 'agente', true,  '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000b3', 'B Agente',  'b@teste.local', 'agente', true,  '00000000-0000-0000-0000-0000000000a3'),
  ('00000000-0000-0000-0000-0000000000b4', 'P Pendente','p@teste.local', 'agente', false, '00000000-0000-0000-0000-0000000000a4');

insert into public.empresa (cnpj, razao_social) values
  ('90000000000001', 'Empresa A1'), ('90000000000002', 'Empresa A2'),
  ('90000000000003', 'Empresa B1'), ('90000000000004', 'Empresa B2');

insert into public.lead (id, cnpj, origem, status, owner_id, telefone, tel_key, email_key) values
  ('00000000-0000-0000-0000-0000000000c1', '90000000000001', 'outro', 'a_abordar', '00000000-0000-0000-0000-0000000000b2', '11911110001', '11110001', 'a1@x.com'),
  ('00000000-0000-0000-0000-0000000000c2', '90000000000002', 'outro', 'a_abordar', '00000000-0000-0000-0000-0000000000b2', '11911110002', '11110002', 'a2@x.com'),
  ('00000000-0000-0000-0000-0000000000c3', '90000000000003', 'outro', 'a_abordar', '00000000-0000-0000-0000-0000000000b3', '11911110003', '11110003', 'b1@x.com'),
  ('00000000-0000-0000-0000-0000000000c4', '90000000000004', 'outro', 'a_abordar', '00000000-0000-0000-0000-0000000000b3', '11911110004', '11110004', 'b2@x.com');

insert into public.interacao (lead_id, agente_id, canal, sentido) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b2', 'whatsapp', 'saida'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b3', 'whatsapp', 'saida');

/* ── A (agente) ── */
do $$
declare n int; achou boolean;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into n from public.lead;
  if n <> 2 then raise exception 'FALHOU: A deveria ver 2 leads, viu %', n; end if;
  raise notice 'ok: A vê só os 2 leads dele';

  select count(*) into n from public.interacao;
  if n <> 1 then raise exception 'FALHOU: A deveria ver 1 conversa, viu %', n; end if;
  raise notice 'ok: A vê só a conversa do lead dele';

  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FALHOU: A deveria ver 1 perfil, viu %', n; end if;
  raise notice 'ok: A vê só o próprio perfil';

  update public.lead set status = 'perdido' where id = '00000000-0000-0000-0000-0000000000c3';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALHOU: A alterou lead do B (% linha)', n; end if;
  raise notice 'ok: A não altera lead do B';

  begin
    insert into public.lead (cnpj, origem, owner_id) values (null, 'outro', '00000000-0000-0000-0000-0000000000b3');
    raise exception 'FALHOU: A criou lead com dono B';
  exception when insufficient_privilege or check_violation then
    raise notice 'ok: A não cria lead em nome do B';
  end;

  begin
    update public.lead set owner_id = '00000000-0000-0000-0000-0000000000b3' where id = '00000000-0000-0000-0000-0000000000c1';
    raise exception 'FALHOU: A transferiu lead para o B';
  exception when insufficient_privilege or check_violation then
    raise notice 'ok: A não transfere lead (só gestor redistribui)';
  end;

  begin
    update public.profiles set papel = 'gestor' where auth_user_id = '00000000-0000-0000-0000-0000000000a2';
    raise exception 'FALHOU: A virou gestor por UPDATE direto';
  exception when insufficient_privilege then
    raise notice 'ok: A não muda o próprio papel';
  end;

  begin
    perform public.alterar_papel('00000000-0000-0000-0000-0000000000b3', 'gestor');
    raise exception 'FALHOU: A chamou alterar_papel';
  exception when insufficient_privilege then
    raise notice 'ok: A não chama alterar_papel';
  end;

  begin
    insert into public.usina_aneel (cod_empreendimento, fonte) values ('TESTE-RLS', 'teste');
    raise exception 'FALHOU: A gravou em usina_aneel';
  exception when insufficient_privilege then
    raise notice 'ok: A não grava na base ANEEL';
  end;

  select count(*) into n from public.empresa;
  if n < 4 then raise exception 'FALHOU: A deveria ler empresa (viu %)', n; end if;
  raise notice 'ok: A lê a base de empresas';

  -- dedup entre agentes sem revelar o lead alheio
  select meu into achou from public.checar_duplicados(array['90000000000003'], '{}', '{}') limit 1;
  if achou is distinct from false then raise exception 'FALHOU: dedup deveria dizer "existe, não é meu" para o CNPJ do B (veio %)', achou; end if;
  select meu into achou from public.checar_duplicados(array['90000000000001'], '{}', '{}') limit 1;
  if achou is distinct from true then raise exception 'FALHOU: dedup deveria dizer "existe, é meu" para o CNPJ do A'; end if;
  raise notice 'ok: checar_duplicados separa lead meu de lead alheio';

  select count(*) into n from public.cnpjs_com_lead();
  if n <> 4 then raise exception 'FALHOU: cnpjs_com_lead deveria listar os 4 CNPJs, listou %', n; end if;
  raise notice 'ok: cnpjs_com_lead enxerga a carteira inteira (só CNPJ)';

  update public.lead set deleted_at = now(), devolvido_em = now(), devolvido_motivo = 'teste' where id = '00000000-0000-0000-0000-0000000000c1';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALHOU: A não conseguiu devolver o próprio lead à base'; end if;
  raise notice 'ok: A devolve o próprio lead à base';

  reset role;
end $$;

/* ── B (outro agente) não vê nada do A ── */
do $$
declare n int;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.lead where owner_id = '00000000-0000-0000-0000-0000000000b2';
  if n <> 0 then raise exception 'FALHOU: B viu % lead(s) do A', n; end if;
  select count(*) into n from public.interacao where lead_id in ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c2');
  if n <> 0 then raise exception 'FALHOU: B viu conversa do A'; end if;
  raise notice 'ok: B não vê leads nem conversas do A';
  reset role;
end $$;

/* ── P (conta pendente) não vê nada de negócio ── */
do $$
declare n int;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}', true);
  set local role authenticated;
  select count(*) into n from public.lead;
  if n <> 0 then raise exception 'FALHOU: pendente viu % leads', n; end if;
  select count(*) into n from public.empresa;
  if n <> 0 then raise exception 'FALHOU: pendente viu % empresas', n; end if;
  select count(*) into n from public.concessionaria;
  if n <> 0 then raise exception 'FALHOU: pendente viu % distribuidoras', n; end if;
  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'FALHOU: pendente deveria ver só o próprio perfil (viu %)', n; end if;
  raise notice 'ok: conta pendente não vê dados de negócio (só o próprio perfil)';
  reset role;
end $$;

/* ── anon sem acesso nenhum ── */
do $$
begin
  set local role anon;
  begin
    perform count(*) from public.lead;
    raise exception 'FALHOU: anon leu a tabela lead';
  exception when insufficient_privilege then
    raise notice 'ok: anon não lê lead';
  end;
  begin
    perform count(*) from public.profiles;
    raise exception 'FALHOU: anon leu profiles';
  exception when insufficient_privilege then
    raise notice 'ok: anon não lê profiles';
  end;
  reset role;
end $$;

/* ── G (gestor) ── */
do $$
declare n int; r public.profiles;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  set local role authenticated;

  select count(*) into n from public.lead;
  if n <> 4 then raise exception 'FALHOU: gestor deveria ver 4 leads, viu %', n; end if;
  select count(*) into n from public.profiles;
  if n <> 4 then raise exception 'FALHOU: gestor deveria ver 4 perfis, viu %', n; end if;
  raise notice 'ok: gestor vê todos os leads e perfis';

  -- aprova a conta pendente e muda o papel pelas RPCs
  r := public.definir_ativo('00000000-0000-0000-0000-0000000000b4', true);
  if not r.ativo then raise exception 'FALHOU: definir_ativo não ativou'; end if;
  r := public.alterar_papel('00000000-0000-0000-0000-0000000000b2', 'gestor');
  if r.papel <> 'gestor' then raise exception 'FALHOU: alterar_papel não promoveu'; end if;
  select count(*) into n from public.perfil_auditoria;
  if n <> 2 then raise exception 'FALHOU: auditoria deveria ter 2 registros, tem %', n; end if;
  raise notice 'ok: gestor aprova conta e muda papel, com auditoria';

  -- UPDATE direto de papel é barrado até para gestor (só pelas RPCs)
  begin
    update public.profiles set papel = 'agente' where id = '00000000-0000-0000-0000-0000000000b2';
    raise exception 'FALHOU: gestor mudou papel por UPDATE direto';
  exception when insufficient_privilege then
    raise notice 'ok: papel só muda pela RPC auditada';
  end;

  -- rebaixa o A de volta e depois tenta rebaixar o último gestor
  perform public.alterar_papel('00000000-0000-0000-0000-0000000000b2', 'agente');
  begin
    perform public.alterar_papel('00000000-0000-0000-0000-0000000000b1', 'agente');
    raise exception 'FALHOU: rebaixou o último gestor';
  exception when others then
    if sqlerrm not like '%último gestor%' then raise; end if;
    raise notice 'ok: o último gestor ativo não pode ser rebaixado';
  end;
  begin
    perform public.definir_ativo('00000000-0000-0000-0000-0000000000b1', false);
    raise exception 'FALHOU: desativou o último gestor';
  exception when others then
    if sqlerrm not like '%último gestor%' then raise; end if;
    raise notice 'ok: o último gestor ativo não pode ser desativado';
  end;

  -- redistribui lead de um agente para o outro
  update public.lead set owner_id = '00000000-0000-0000-0000-0000000000b3' where id = '00000000-0000-0000-0000-0000000000c2';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALHOU: gestor não redistribuiu lead'; end if;
  raise notice 'ok: gestor redistribui leads';

  reset role;
end $$;

/* ── A: edita o próprio nome; opt-out atinge leads dos colegas ── */
do $$
declare n int; nome_novo text;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  set local role authenticated;

  update public.profiles set nome = 'A Renomeado' where auth_user_id = '00000000-0000-0000-0000-0000000000a2';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALHOU: A não conseguiu editar o próprio nome'; end if;
  raise notice 'ok: A edita o próprio nome';

  -- A registra opt-out de um telefone que pertence a lead do B
  insert into public.supressao (telefone, motivo) values ('11110003', 'pediu descadastro');
  reset role;

  select count(*) into n from public.lead where id = '00000000-0000-0000-0000-0000000000c3' and opt_out and status = 'descartado';
  if n <> 1 then raise exception 'FALHOU: opt-out registrado por A não marcou o lead do B'; end if;
  raise notice 'ok: opt-out vale para a carteira inteira, não só para os leads de quem registrou';
end $$;

/* ── G (gestor): pré-cadastra e-mail; aprovação preenche aprovado_em ── */
do $$
declare r public.profiles; n int;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  set local role authenticated;
  insert into public.profiles (nome, email, papel, ativo, aprovado_em)
    values ('Pré Cadastrado', 'pre@teste.local', 'agente', true, now());
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FALHOU: gestor não conseguiu pré-cadastrar'; end if;
  reset role;
  raise notice 'ok: gestor pré-cadastra um e-mail (a pessoa assume ao criar a conta)';

  select * into r from public.profiles where lower(email) = 'g@teste.local';
  if r.aprovado_em is null then raise exception 'FALHOU: gestor existente deveria ter aprovado_em (backfill)'; end if;
end $$;

/* ── reivindicar_perfil: assumir por e-mail confirmado, pendente, e-mail não confirmado ── */
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a5', 'authenticated', 'authenticated', 'legado@teste.local', now()),
  ('00000000-0000-0000-0000-0000000000a6', 'authenticated', 'authenticated', 'novo@teste.local', now()),
  ('00000000-0000-0000-0000-0000000000a7', 'authenticated', 'authenticated', 'naoconfirmado@teste.local', null);
-- perfil antigo (como nas fases 1–5): já tem carteira, ainda sem conta no Auth
insert into public.profiles (id, nome, email, papel, ativo) values
  ('00000000-0000-0000-0000-0000000000b5', 'Legado', 'Legado@Teste.Local', 'agente', true);

do $$
declare r public.profiles;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a5","role":"authenticated"}', true);
  set local role authenticated;
  r := public.reivindicar_perfil();
  reset role;
  if r.id <> '00000000-0000-0000-0000-0000000000b5' or not r.ativo then
    raise exception 'FALHOU: perfil antigo deveria ser assumido pelo e-mail (id %, ativo %)', r.id, r.ativo;
  end if;
  raise notice 'ok: perfil antigo é assumido pelo e-mail confirmado (mantém id e situação)';

  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a6","role":"authenticated"}', true);
  set local role authenticated;
  r := public.reivindicar_perfil();
  reset role;
  if r.ativo or r.papel <> 'agente' then raise exception 'FALHOU: conta nova deveria entrar pendente como agente'; end if;
  raise notice 'ok: conta nova entra pendente';

  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a7","role":"authenticated"}', true);
  set local role authenticated;
  begin
    r := public.reivindicar_perfil();
    raise exception 'FALHOU: e-mail não confirmado conseguiu perfil';
  exception when insufficient_privilege then
    raise notice 'ok: e-mail não confirmado não assume perfil';
  end;
  reset role;
end $$;

/* ── bootstrap: instalação sem nenhum gestor → a primeira conta confirmada vira gestor ── */
select set_config('request.jwt.claims', '', true);   -- volta a ser o SQL Editor (sem usuário logado)
update public.profiles set papel = 'agente';          -- zera os gestores
insert into auth.users (id, aud, role, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a8', 'authenticated', 'authenticated', 'primeiro@teste.local', now());
do $$
declare r public.profiles;
begin
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a8","role":"authenticated"}', true);
  set local role authenticated;
  r := public.reivindicar_perfil();
  reset role;
  if r.papel <> 'gestor' or not r.ativo then
    raise exception 'FALHOU: sem nenhum gestor, a primeira conta deveria virar gestor ativo (veio % / %)', r.papel, r.ativo;
  end if;
  raise notice 'ok: bootstrap — primeira conta de uma instalação sem gestor vira gestor';
end $$;

rollback;  -- nada disto fica no banco
