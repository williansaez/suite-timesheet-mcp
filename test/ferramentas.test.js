import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FERRAMENTAS, executar } from '../lib/ferramentas.js';
import { criarCliente } from '../lib/cliente.js';

test('há seis tools, nesta ordem, todas com schema de objeto e descrição que avisa que nunca submete', () => {
  assert.deepEqual(FERRAMENTAS.map((f) => f.name), ['estado', 'projetos', 'ler_mes', 'propor', 'aplicar', 'resultado']);
  for (const f of FERRAMENTAS) {
    assert.equal(f.inputSchema.type, 'object');
    assert.equal(typeof f.description, 'string');
    assert.match(f.description, /nunca submete o mês, nunca muda o mês/i);
  }
  assert.match(FERRAMENTAS.find((f) => f.name === 'propor').description, /nunca submete/i);
  assert.deepEqual(FERRAMENTAS.find((f) => f.name === 'propor').inputSchema.required, ['linhas']);
});

test('aplicar: schema exige "id", avisa que não espera pelo clique e que precisa do OK do utilizador e da aprovação da tool', () => {
  const aplicar = FERRAMENTAS.find((f) => f.name === 'aplicar');
  assert.deepEqual(aplicar.inputSchema.required, ['id']);
  assert.match(aplicar.description, /sem esperar pelo clique/i);
  assert.match(aplicar.description, /OK explícito no chat/i);
  assert.match(aplicar.description, /trancad|bloquead/i);
});

// Cliente falso que grava o que lhe pedem e responde com um guião.
function clienteFalso(guiao) {
  const chamadas = [];
  return {
    chamadas,
    estado: async () => { chamadas.push(['estado']); return guiao.estado; },
    comando: async (corpo) => { chamadas.push(['comando', corpo]); return guiao.comando(corpo); },
    resultado: async (id, waitS, fase) => { chamadas.push(['resultado', id, waitS, fase]); return guiao.resultado(id); },
  };
}

test('estado junta o /mcp/estado com o comando estado quando a ponte está ligada', async () => {
  const c = clienteFalso({
    estado: { ponte: 'ligada', contexto: { ano: 2026, mes: 9, projetos: [{}, {}] }, ultimoMcp: '2026-09-24T17:00:00.000Z' },
    comando: () => ({ id: 'e1', estado: 'concluido', resultado: { ok: true, dados: { loteEmCurso: false } } }),
  });
  assert.deepEqual(await executar('estado', {}, c), {
    ponte: 'ligada', ano: 2026, mes: 9, projetos: 2, ultimo_mcp: '2026-09-24T17:00:00.000Z', lote_em_curso: false,
  });
  const semChrome = clienteFalso({ estado: { ponte: 'sem-chrome', contexto: null } });
  assert.deepEqual(await executar('estado', {}, semChrome), {
    ponte: 'sem-chrome', ano: null, mes: null, projetos: 0, ultimo_mcp: null, lote_em_curso: null,
  });
  assert.equal(semChrome.chamadas.length, 1);
});

test('estado nunca lança: ponte ligada sem contexto (serve reiniciado depois de a página carregar) dá aviso em vez de ERR_SEM_CONTEXTO', async () => {
  const c = clienteFalso({
    estado: { ponte: 'ligada', contexto: null },
    comando: () => { throw new Error('não devia chamar o comando "estado" sem contexto'); },
  });
  assert.deepEqual(await executar('estado', {}, c), {
    ponte: 'ligada', ano: null, mes: null, projetos: 0, ultimo_mcp: null, lote_em_curso: null, aviso: 'sem contexto: recarrega a Folha de Horas',
  });
  assert.equal(c.chamadas.length, 1);
});

// cliente cujo estado() lança sempre ERR_SERVE_EM_BAIXO, como quando o serve não responde.
function clienteEmBaixo() {
  return {
    estado: async () => { throw Object.assign(new Error('O serviço local não responde em http://x (x). Arranca-o com: node serve.js'), { code: 'ERR_SERVE_EM_BAIXO' }); },
    comando: async () => { throw new Error('não devia chamar comando com o serve em baixo'); },
    resultado: async () => { throw new Error('não devia chamar resultado com o serve em baixo'); },
  };
}

test('estado: com o serve em baixo e sem estadoServe (4º argumento omitido), continua a lançar ERR_SERVE_EM_BAIXO', async () => {
  await assert.rejects(executar('estado', {}, clienteEmBaixo()), { code: 'ERR_SERVE_EM_BAIXO' });
});

test('estado: com o serve em baixo mas o auto-arranque a correr bem (undefined/ja-corria/arrancado), continua a lançar', async () => {
  await assert.rejects(executar('estado', {}, clienteEmBaixo(), {}), { code: 'ERR_SERVE_EM_BAIXO' });
  await assert.rejects(executar('estado', {}, clienteEmBaixo(), { estadoServe: { estado: 'ja-corria' } }), { code: 'ERR_SERVE_EM_BAIXO' });
  await assert.rejects(executar('estado', {}, clienteEmBaixo(), { estadoServe: { estado: 'arrancado' } }), { code: 'ERR_SERVE_EM_BAIXO' });
});

test('estado: com o serve em baixo e o auto-arranque a dizer "porta-ocupada" ou "falhou", não lança — devolve ponte "sem-serve"', async () => {
  const ocupada = { estado: 'porta-ocupada', detalhe: 'Na porta 18765 responde outro programa.' };
  assert.deepEqual(await executar('estado', {}, clienteEmBaixo(), { estadoServe: ocupada }), {
    ponte: 'sem-serve', serve: 'porta-ocupada', detalhe: ocupada.detalhe,
  });
  const falhou = { estado: 'falhou', detalhe: 'Não consegui arrancar o serve em http://127.0.0.1:18765.' };
  assert.deepEqual(await executar('estado', {}, clienteEmBaixo(), { estadoServe: falhou }), {
    ponte: 'sem-serve', serve: 'falhou', detalhe: falhou.detalhe,
  });
});

test('projetos e ler_mes desembrulham os dados e propagam o erro do worker', async () => {
  const c = clienteFalso({ comando: ({ tipo }) => ({ id: 'x', estado: 'concluido', resultado: { ok: true, dados: { tipo } } }) });
  assert.deepEqual(await executar('projetos', {}, c), { tipo: 'projetos' });
  assert.deepEqual(await executar('ler_mes', {}, c), { tipo: 'ler' });
  const falha = clienteFalso({ comando: () => ({ id: 'x', estado: 'concluido', resultado: { ok: false, erro: { code: 'ERR_SESSION', message: 'sessão' } } }) });
  await assert.rejects(executar('ler_mes', {}, falha), { code: 'ERR_SESSION' });
  const pendente = clienteFalso({ comando: () => ({ id: 'x', estado: 'pendente', resultado: null }) });
  await assert.rejects(executar('ler_mes', {}, pendente), { code: 'ERR_PENDENTE' });
});

test('propor valida localmente, envia e devolve id, previa e bloqueio', async () => {
  const c = clienteFalso({
    comando: () => ({ id: 'p1', estado: 'concluido', resultado: { ok: true, dados: { fase: 'previa', previa: { criar: [], bloqueio: null } } } }),
  });
  await assert.rejects(executar('propor', { linhas: [{ date: 'x', hours: 1 }] }, c), { code: 'ERR_PROPOSTA' });
  assert.equal(c.chamadas.length, 0);
  const r = await executar('propor', { linhas: [{ option_id: 101, date: '2026-09-02', hours: 0.5 }], nome: 's' }, c);
  assert.deepEqual(r, { id: 'p1', estado: 'previa', previa: { criar: [], bloqueio: null }, bloqueio: null });
  assert.equal(c.chamadas[0][1].tipo, 'propor');
  assert.equal(c.chamadas[0][1].nome, 's');
  const pendente = clienteFalso({ comando: () => ({ id: 'p2', estado: 'pendente', resultado: null }) });
  assert.deepEqual(await executar('propor', { linhas: [{ option_id: 101, date: '2026-09-02', hours: 0.5 }] }, pendente), { id: 'p2', estado: 'pendente' });
});

test('propor: se a previa se perde e o worker publica logo o final, devolve o estado final em vez de fingir previa', async () => {
  const semPrevia = clienteFalso({
    comando: () => ({ id: 'p3', estado: 'concluido', resultado: { ok: true, dados: { fase: 'final', estado: 'aplicado', report: { results: [{ ok: true }] } } } }),
  });
  const r = await executar('propor', { linhas: [{ option_id: 101, date: '2026-09-02', hours: 0.5 }] }, semPrevia);
  assert.deepEqual(r, { id: 'p3', estado: 'aplicado', report: { results: [{ ok: true }] }, motivo: undefined });
});

test('aplicar: devolve aplicado com o relatório, usa o id da proposta (não o do comando) e limita o timeout', async () => {
  const c = clienteFalso({
    comando: () => ({ id: 'cmd-interno', estado: 'concluido', resultado: { ok: true, dados: { estado: 'aplicado', report: { results: [{ ok: true }] } } } }),
  });
  assert.deepEqual(await executar('aplicar', { id: 'p1', timeout_s: 9999 }, c), { id: 'p1', estado: 'aplicado', report: { results: [{ ok: true }] } });
  assert.equal(c.chamadas[0][0], 'comando');
  assert.deepEqual(c.chamadas[0][1], { tipo: 'aplicar', proposta: 'p1', timeout_s: 290 });
});

test('aplicar: sem timeout_s usa o defeito de 120 s', async () => {
  const c = clienteFalso({
    comando: () => ({ id: 'cmd-interno', estado: 'concluido', resultado: { ok: true, dados: { estado: 'aplicado', report: {} } } }),
  });
  await executar('aplicar', { id: 'p1' }, c);
  assert.equal(c.chamadas[0][1].timeout_s, 120);
});

test('aplicar: dados.estado "erro" devolve o erro sem lançar', async () => {
  const c = clienteFalso({
    comando: () => ({ id: 'cmd-interno', estado: 'concluido', resultado: { ok: true, dados: { estado: 'erro', erro: { code: 'ERR_SESSION', message: 'sessão' } } } }),
  });
  assert.deepEqual(await executar('aplicar', { id: 'p1' }, c), { id: 'p1', estado: 'erro', erro: { code: 'ERR_SESSION', message: 'sessão' } });
});

test('aplicar: pendente quando o worker não responde a tempo', async () => {
  const c = clienteFalso({ comando: () => ({ id: 'cmd-interno', estado: 'pendente', resultado: null }) });
  assert.deepEqual(await executar('aplicar', { id: 'p1' }, c), { id: 'p1', estado: 'pendente' });
});

test('aplicar: propaga o código de erro quando o serve/worker recusa (ex.: ERR_BLOQUEADO, ERR_PROPOSTA_DESCONHECIDA)', async () => {
  const bloqueado = clienteFalso({ comando: () => ({ id: 'x', estado: 'concluido', resultado: { ok: false, erro: { code: 'ERR_BLOQUEADO', message: 'linha trancada' } } }) });
  await assert.rejects(executar('aplicar', { id: 'p1' }, bloqueado), { code: 'ERR_BLOQUEADO' });
  const desconhecida = clienteFalso({ comando: () => ({ id: 'x', estado: 'concluido', resultado: { ok: false, erro: { code: 'ERR_PROPOSTA_DESCONHECIDA', message: 'sem proposta' } } }) });
  await assert.rejects(executar('aplicar', { id: 'p1' }, desconhecida), { code: 'ERR_PROPOSTA_DESCONHECIDA' });
});

test('resultado devolve aplicado/cancelado/erro/pendente e limita o timeout', async () => {
  const c = clienteFalso({ resultado: () => ({ id: 'p1', estado: 'concluido', resultado: { ok: true, dados: { fase: 'final', estado: 'aplicado', report: { results: [] } } } }) });
  assert.deepEqual(await executar('resultado', { id: 'p1', timeout_s: 9999 }, c), { id: 'p1', estado: 'aplicado', report: { results: [] }, motivo: undefined });
  assert.equal(c.chamadas[0][2], 290);
  const cancel = clienteFalso({ resultado: () => ({ id: 'p1', estado: 'concluido', resultado: { ok: true, dados: { fase: 'final', estado: 'cancelado', motivo: 'm' } } }) });
  assert.equal((await executar('resultado', { id: 'p1' }, cancel)).motivo, 'm');
  const pend = clienteFalso({ resultado: () => ({ id: 'p1', estado: 'pendente', resultado: null }) });
  assert.deepEqual(await executar('resultado', { id: 'p1' }, pend), { id: 'p1', estado: 'pendente' });
  const err = clienteFalso({ resultado: () => ({ id: 'p1', estado: 'concluido', resultado: { ok: false, erro: { code: 'ERR_X', message: 'x' } } }) });
  assert.deepEqual(await executar('resultado', { id: 'p1' }, err), { id: 'p1', estado: 'erro', erro: { code: 'ERR_X', message: 'x' } });
});

test('resultado com fase: "previa" pede a previa em vez do final, e passa a fase ao cliente', async () => {
  const c = clienteFalso({ resultado: () => ({ id: 'p1', estado: 'concluido', resultado: { ok: true, dados: { fase: 'previa', previa: { criar: [], bloqueio: 'x' } } } }) });
  assert.deepEqual(
    await executar('resultado', { id: 'p1', fase: 'previa' }, c),
    { id: 'p1', estado: 'previa', previa: { criar: [], bloqueio: 'x' }, bloqueio: 'x' },
  );
  assert.equal(c.chamadas[0][3], 'previa');
  // fase omitida continua a pedir 'final', como sempre:
  const semFase = clienteFalso({ resultado: () => ({ id: 'p1', estado: 'concluido', resultado: { ok: true, dados: { fase: 'final', estado: 'aplicado' } } }) });
  await executar('resultado', { id: 'p1' }, semFase);
  assert.equal(semFase.chamadas[0][3], 'final');
});

test('tool desconhecida lança ERR_TOOL', async () => {
  await assert.rejects(executar('apagar_tudo', {}, clienteFalso({})), { code: 'ERR_TOOL' });
});

test('o cliente real traduz rede em ERR_SERVE_EM_BAIXO e HTTP em erro com o code do corpo', async () => {
  const emBaixo = criarCliente({ base: 'http://127.0.0.1:1', fetch: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(emBaixo.estado(), { code: 'ERR_SERVE_EM_BAIXO', message: /node serve\.js/ });
  // A mensagem inclui o comando de arranque que lhe passarem (o mcp.js passa o caminho
  // absoluto do serve.js irmão dele), em vez do genérico "node serve.js" por defeito.
  const emBaixoComCaminho = criarCliente({
    base: 'http://127.0.0.1:1',
    fetch: async () => { throw new Error('ECONNREFUSED'); },
    comandoArranque: 'node /caminho/absoluto/serve.js',
  });
  await assert.rejects(emBaixoComCaminho.estado(), { code: 'ERR_SERVE_EM_BAIXO', message: /\/caminho\/absoluto\/serve\.js/ });
  const conflito = criarCliente({
    base: 'http://x',
    fetch: async () => ({ ok: false, status: 409, json: async () => ({ erro: { code: 'ERR_OCUPADO', message: 'ocupado' } }) }),
  });
  await assert.rejects(conflito.comando({ tipo: 'ler' }), { code: 'ERR_OCUPADO', message: 'ocupado' });
  const pedidos = [];
  const ok = criarCliente({ base: 'http://x', fetch: async (url, opts) => { pedidos.push([url, opts]); return { ok: true, status: 200, json: async () => ({ id: 'a' }) }; } });
  await ok.resultado('a b', 5, 'previa');
  assert.equal(pedidos[0][0], 'http://x/mcp/comando/a%20b?wait=5&fase=previa');
});
