import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarFila } from '../lib/fila.js';
import { criarContexto } from '../lib/contexto.js';
import { criarRotas } from '../lib/rotas.js';

const CTX = { ano: 2026, mes: 9, diasNoMes: 30, projetos: [{ option_id: 101, nome: 'Alfa', trancado: false }], lidoEm: 'x' };
const ids = () => { let n = 0; return () => `id-${++n}`; };

const VERSAO_TESTE = '9.9.9-teste';

function montar({ agora, versao = VERSAO_TESTE } = {}) {
  const fila = criarFila(agora ? { novoId: ids(), agora } : { novoId: ids() });
  const contexto = criarContexto();
  const despachar = criarRotas(agora ? { fila, contexto, log: () => {}, versao, agora } : { fila, contexto, log: () => {}, versao });
  const get = (caminho, query = {}) => despachar({ metodo: 'GET', caminho, query, corpo: null });
  const post = (caminho, corpo) => despachar({ metodo: 'POST', caminho, query: {}, corpo });
  return { fila, contexto, get, post };
}

// Worker falso: um poll que responde ao próximo comando com o que lhe derem.
async function workerResponde({ get, post }, responder) {
  const r = await get('/bridge/next', { wait: '1' });
  assert.equal(r.status, 200);
  await post(`/bridge/result/${r.corpo.id}`, responder(r.corpo));
  return r.corpo;
}

test('timesheet cumpre o contrato antigo', async () => {
  const { get, contexto } = montar();
  contexto.guardarProposta(2026, 9, [{ option_id: 101, date: '2026-09-02', hours: 0.5 }]);
  const r = await get('/timesheet', { year: '2026', month: '9' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.year, 2026);
  assert.equal(r.corpo.month, 9);
  assert.equal(r.corpo.rows.length, 1);
  assert.deepEqual((await get('/timesheet', { year: '2026', month: '8' })).corpo.rows, []);
});

test('health devolve identidade JSON: nome, versão injetada, ponte e ultimoMcp do último /mcp/*', async () => {
  let t = 1758727200000; // fixo: só a passagem do tempo entre chamadas importa
  const agora = () => t;
  const { get, post } = montar({ agora, versao: VERSAO_TESTE });

  const antes = await get('/health');
  assert.equal(antes.status, 200);
  assert.deepEqual(antes.corpo, { nome: 'suite-timesheet-serve', versao: VERSAO_TESTE, ultimoMcp: null, ponte: 'sem-chrome' });

  await post('/bridge/contexto', CTX);
  await get('/bridge/next', { wait: '0' }); // marca a ponte como viva, mas não é /mcp/*: ultimoMcp continua null
  assert.equal((await get('/health')).corpo.ultimoMcp, null);

  t += 1000;
  await get('/mcp/estado'); // primeiro /mcp/*: fixa ultimoMcp
  const depois = await get('/health');
  assert.deepEqual(depois.corpo, {
    nome: 'suite-timesheet-serve', versao: VERSAO_TESTE, ultimoMcp: new Date(t).toISOString(), ponte: 'ligada',
  });
});

test('rota desconhecida dá 404', async () => {
  const { get } = montar();
  assert.equal((await get('/nada')).status, 404);
});

test('bridge/contexto guarda o mês visível; bridge/next dá 204 sem comandos', async () => {
  const { get, post, contexto } = montar();
  assert.equal((await post('/bridge/contexto', CTX)).status, 204);
  assert.deepEqual(contexto.mesVisivel(), { ano: 2026, mes: 9 });
  assert.equal((await get('/bridge/next', { wait: '0' })).status, 204);
});

test('mcp/estado diz sem-chrome até haver poll recente, e leva ultimoMcp do próprio pedido', async () => {
  let t = 1758727200000; // fixo: só a passagem do tempo entre chamadas importa
  const agora = () => t;
  const { get, post } = montar({ agora });
  assert.deepEqual((await get('/mcp/estado')).corpo, { ponte: 'sem-chrome', contexto: null, ultimoMcp: new Date(t).toISOString() });
  await post('/bridge/contexto', CTX);
  await get('/bridge/next', { wait: '0' });
  t += 1000;
  const r = (await get('/mcp/estado')).corpo;
  assert.equal(r.ponte, 'ligada');
  assert.equal(r.contexto.ano, 2026);
  assert.equal(r.ultimoMcp, new Date(t).toISOString());
});

test('mcp/comando recusa sem contexto, sem ponte e com mês diferente', async () => {
  const { get, post } = montar();
  let r = await post('/mcp/comando', { tipo: 'ler' });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro.code, 'ERR_SEM_CHROME');
  await post('/bridge/contexto', CTX);
  r = await post('/mcp/comando', { tipo: 'ler' });
  assert.equal(r.corpo.erro.code, 'ERR_SEM_CHROME');
  await get('/bridge/next', { wait: '0' });
  r = await post('/mcp/comando', { tipo: 'ler', ano: 2026, mes: 8 });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro.code, 'ERR_MES_DIFERENTE');
  assert.match(r.corpo.erro.message, /2026-09/);
});

test('mcp/comando distingue sem ponte (ERR_SEM_CHROME) de ponte viva sem contexto (ERR_SEM_CONTEXTO)', async () => {
  const { get, post } = montar();
  // O worker já está a fazer long-poll (a ponte está viva), mas nunca chegou um
  // /bridge/contexto — como quando o serve reinicia depois de a página já ter carregado.
  await get('/bridge/next', { wait: '0' });
  const r = await post('/mcp/comando', { tipo: 'ler' });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro.code, 'ERR_SEM_CONTEXTO');
  assert.match(r.corpo.erro.message, /Recarrega a Folha de Horas/);
});

test('mcp/comando ler: enfileira com o mês visível, espera pelo worker e devolve o resultado', async () => {
  const api = montar();
  await api.post('/bridge/contexto', CTX);
  await api.get('/bridge/next', { wait: '0' });
  const pedido = api.post('/mcp/comando', { tipo: 'ler', timeout_s: 2 });
  const cmd = await workerResponde(api, () => ({ ok: true, dados: { linhas: [] } }));
  assert.deepEqual(cmd, { id: 'id-1', tipo: 'ler', ano: 2026, mes: 9 });
  const r = await pedido;
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo, { id: 'id-1', estado: 'concluido', resultado: { ok: true, dados: { linhas: [] } } });
});

test('mcp/comando devolve pendente se o worker não responder a tempo, e mcp/comando/{id} recupera depois', async () => {
  const api = montar();
  await api.post('/bridge/contexto', CTX);
  await api.get('/bridge/next', { wait: '0' });
  const r = await api.post('/mcp/comando', { tipo: 'ler', timeout_s: 0 });
  assert.equal(r.corpo.estado, 'pendente');
  await workerResponde(api, () => ({ ok: true, dados: { linhas: [] } }));
  const depois = await api.get(`/mcp/comando/${r.corpo.id}`, { wait: '1' });
  assert.equal(depois.corpo.estado, 'concluido');
  assert.equal((await api.get('/mcp/comando/nada', { wait: '0' })).status, 404);
});

test('mcp/comando propor: valida, guarda a proposta para o /timesheet, entrega ao worker e devolve a previa', async () => {
  const api = montar();
  await api.post('/bridge/contexto', CTX);
  await api.get('/bridge/next', { wait: '0' });
  const invalido = await api.post('/mcp/comando', { tipo: 'propor', linhas: [{ date: 'x', hours: 1 }] });
  assert.equal(invalido.status, 400);
  assert.equal(invalido.corpo.erro.code, 'ERR_PROPOSTA');

  const pedido = api.post('/mcp/comando', {
    tipo: 'propor', linhas: [{ option_id: 101, date: '2026-09-02', hours: 0.5 }], nome: 'sprint', timeout_s: 2,
  });
  const cmd = await workerResponde(api, () => ({ ok: true, dados: { fase: 'previa', previa: { criar: [] } } }));
  assert.equal(cmd.tipo, 'propor');
  assert.equal(cmd.espelho, false);
  assert.equal(cmd.nome, 'sprint');
  assert.deepEqual(cmd.linhas, [{ option_id: 101, project: '', date: '2026-09-02', hours: 0.5 }]);
  const r = await pedido;
  assert.equal(r.corpo.resultado.dados.fase, 'previa');
  assert.equal((await api.get('/timesheet', { year: '2026', month: '9' })).corpo.rows.length, 1);

  const ocupado = await api.post('/mcp/comando', { tipo: 'propor', linhas: [{ option_id: 101, date: '2026-09-02', hours: 0.5 }] });
  assert.equal(ocupado.status, 409);
  assert.equal(ocupado.corpo.erro.code, 'ERR_OCUPADO');

  await api.post(`/bridge/result/${r.corpo.id}`, { ok: true, dados: { fase: 'final', estado: 'aplicado' } });
  const final = await api.get(`/mcp/comando/${r.corpo.id}`, { wait: '1', fase: 'final' });
  assert.equal(final.corpo.resultado.dados.estado, 'aplicado');
});

test('mcp/comando propor: ERR_OCUPADO não substitui a proposta guardada para o /timesheet', async () => {
  const api = montar();
  await api.post('/bridge/contexto', CTX);
  await api.get('/bridge/next', { wait: '0' });

  const primeiro = api.post('/mcp/comando', {
    tipo: 'propor', linhas: [{ option_id: 101, date: '2026-09-02', hours: 0.5 }], nome: 'primeira', timeout_s: 2,
  });
  await workerResponde(api, () => ({ ok: true, dados: { fase: 'previa', previa: { criar: [] } } }));
  await primeiro;
  const antes = (await api.get('/timesheet', { year: '2026', month: '9' })).corpo.rows;
  assert.deepEqual(antes, [{ option_id: 101, project: '', date: '2026-09-02', hours: 0.5 }]);

  // A primeira proposta ainda está por confirmar (sem final), por isso esta segunda,
  // com linhas diferentes, tem de ser recusada — e não pode ter tocado no /timesheet.
  const ocupado = await api.post('/mcp/comando', {
    tipo: 'propor', linhas: [{ option_id: 101, date: '2026-09-03', hours: 1 }], nome: 'segunda',
  });
  assert.equal(ocupado.status, 409);
  assert.equal(ocupado.corpo.erro.code, 'ERR_OCUPADO');

  const depois = (await api.get('/timesheet', { year: '2026', month: '9' })).corpo.rows;
  assert.deepEqual(depois, antes);
});

test('mcp/comando aplicar: exige proposta não vazia, entrega {tipo, ano, mes, proposta} e a fase é final', async () => {
  const api = montar();
  await api.post('/bridge/contexto', CTX);
  await api.get('/bridge/next', { wait: '0' });

  const semProposta = await api.post('/mcp/comando', { tipo: 'aplicar' });
  assert.equal(semProposta.status, 400);
  assert.equal(semProposta.corpo.erro.code, 'ERR_COMANDO');

  const propostaVazia = await api.post('/mcp/comando', { tipo: 'aplicar', proposta: '   ' });
  assert.equal(propostaVazia.status, 400);
  assert.equal(propostaVazia.corpo.erro.code, 'ERR_COMANDO');

  const pedido = api.post('/mcp/comando', { tipo: 'aplicar', proposta: 'proposta-123', timeout_s: 2 });
  const cmd = await workerResponde(api, () => ({ ok: true, dados: { estado: 'aplicado', report: { results: [{ ok: true }] } } }));
  assert.deepEqual(cmd, { id: 'id-1', tipo: 'aplicar', ano: 2026, mes: 9, proposta: 'proposta-123' });
  const r = await pedido;
  assert.equal(r.status, 200);
  assert.equal(r.corpo.estado, 'concluido');
  assert.deepEqual(r.corpo.resultado, { ok: true, dados: { estado: 'aplicado', report: { results: [{ ok: true }] } } });
});

test('mcp/comando aplicar não é bloqueado por um propor aberto: resolve-o, não é um novo propor', async () => {
  const api = montar();
  await api.post('/bridge/contexto', CTX);
  await api.get('/bridge/next', { wait: '0' });

  const pedidoPropor = api.post('/mcp/comando', {
    tipo: 'propor', linhas: [{ option_id: 101, date: '2026-09-02', hours: 0.5 }], timeout_s: 2,
  });
  await workerResponde(api, () => ({ ok: true, dados: { fase: 'previa', previa: { criar: [] } } }));
  const propor = await pedidoPropor;
  const proporId = propor.corpo.id;

  // Um segundo propor seria ERR_OCUPADO (o primeiro ainda não tem final) — aplicar não é.
  const aindaOcupado = await api.post('/mcp/comando', { tipo: 'propor', linhas: [{ option_id: 101, date: '2026-09-03', hours: 1 }] });
  assert.equal(aindaOcupado.corpo.erro.code, 'ERR_OCUPADO');

  const pedidoAplicar = api.post('/mcp/comando', { tipo: 'aplicar', proposta: proporId, timeout_s: 2 });
  const cmdAplicar = await workerResponde(api, () => ({ ok: true, dados: { estado: 'aplicado', report: { results: [{ ok: true }] } } }));
  assert.equal(cmdAplicar.tipo, 'aplicar');
  assert.equal(cmdAplicar.proposta, proporId);
  const aplicar = await pedidoAplicar;
  assert.equal(aplicar.status, 200);
  assert.equal(aplicar.corpo.estado, 'concluido');
  assert.equal(aplicar.corpo.resultado.dados.estado, 'aplicado');
});

test('bridge/result num id desconhecido dá 404', async () => {
  const { post } = montar();
  assert.equal((await post('/bridge/result/nada', { ok: true })).status, 404);
});
