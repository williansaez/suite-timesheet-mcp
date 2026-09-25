import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrancarServe } from '../serve.js';
import { criarCliente } from '../lib/cliente.js';
import { executar } from '../lib/ferramentas.js';

const CTX = {
  ano: 2026, mes: 9, diasNoMes: 30,
  projetos: [{ option_id: 101, nome: 'Alfa - Manutenção SAP', trancado: false }],
  lidoEm: '2026-09-09T10:00:00.000Z',
};

// Espera a ponte ficar viva por /mcp/estado, em vez de um sleep de duração fixa: o worker
// falso só marca a ponte como viva depois do primeiro /bridge/next, e quanto tempo isso demora
// não é garantido (event loop, CI mais lento, etc.).
async function esperarLigada(base, limiteMs = 2000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    const r = await (await fetch(`${base}/mcp/estado`)).json();
    if (r.ponte === 'ligada') return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`a ponte não ficou "ligada" em ${limiteMs} ms`);
}

// Worker falso: faz o mesmo long-poll que o sw.js da extensão e responde a cada tipo.
// autoFinal: false desliga o final automático de "propor" (para testes que confirmam pela
// tool "aplicar" em vez de simular o clique no painel).
function workerFalso(base, { finalApos = 50, autoFinal = true } = {}) {
  let parar = false;
  const publicar = (id, corpo) => fetch(`${base}/bridge/result/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
  const ciclo = (async () => {
    await fetch(`${base}/bridge/contexto`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CTX) });
    while (!parar) {
      const r = await fetch(`${base}/bridge/next?wait=1`);
      if (r.status !== 200) continue;
      const cmd = await r.json();
      if (cmd.tipo === 'estado') await publicar(cmd.id, { ok: true, dados: { ano: 2026, mes: 9, projetos: 1, loteEmCurso: false } });
      if (cmd.tipo === 'ler') await publicar(cmd.id, { ok: true, dados: { ano: 2026, mes: 9, linhas: [{ option_id: 101, nome: 'Alfa - Manutenção SAP', status: 1, dias: { 2: 0.5 }, total: 0.5 }], totaisPorDia: { 2: 0.5 } } });
      if (cmd.tipo === 'propor') {
        await publicar(cmd.id, { ok: true, dados: { fase: 'previa', previa: { atualizar: [{ option_id: 101, projeto: 'Alfa - Manutenção SAP', dias: { 3: 1 } }], bloqueio: null } } });
        if (autoFinal) setTimeout(() => publicar(cmd.id, { ok: true, dados: { fase: 'final', estado: 'aplicado', report: { results: [{ ok: true }] } } }), finalApos);
      }
      if (cmd.tipo === 'aplicar') {
        // A extensão responde ao comando "aplicar" (o seu próprio id) e publica também o
        // final do propor que ele resolveu (cmd.proposta), como o CONTRACT.md descreve.
        await publicar(cmd.id, { ok: true, dados: { estado: 'aplicado', report: { results: [{ ok: true }] } } });
        await publicar(cmd.proposta, { ok: true, dados: { fase: 'final', estado: 'aplicado', report: { results: [{ ok: true }] } } });
      }
    }
  })();
  return { parar: async () => { parar = true; await ciclo; } };
}

test('ponta-a-ponta: aplicar escreve sem esperar pelo clique no painel, e resultado(id) continua a funcionar', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  const cliente = criarCliente({ base });
  const worker = workerFalso(base, { autoFinal: false });
  try {
    await esperarLigada(base);

    const proposta = await executar('propor', { linhas: [{ option_id: 101, date: '2026-09-03', hours: 1 }], nome: 'e2e-aplicar' }, cliente);
    assert.equal(proposta.estado, 'previa');

    // Sem o autoFinal, o propor fica parado em "previa" até "aplicar" ser chamado — confirma
    // que não há um final à espera, ou seja, a escrita só aconteceu por causa do aplicar.
    const aplicado = await executar('aplicar', { id: proposta.id, timeout_s: 5 }, cliente);
    assert.equal(aplicado.id, proposta.id);
    assert.equal(aplicado.estado, 'aplicado');
    assert.equal(aplicado.report.results.length, 1);

    // O final do propor original também foi publicado: resultado(id) continua a funcionar.
    const final = await executar('resultado', { id: proposta.id, timeout_s: 5 }, cliente);
    assert.equal(final.estado, 'aplicado');
    assert.equal(final.report.results.length, 1);
  } finally {
    await worker.parar();
    await close();
  }
});

test('ponta-a-ponta: estado, ler_mes, propor e resultado através de um serve real', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  const cliente = criarCliente({ base });
  try {
    assert.equal((await executar('estado', {}, cliente)).ponte, 'sem-chrome');
    await assert.rejects(executar('ler_mes', {}, cliente), { code: 'ERR_SEM_CHROME' });

    const worker = workerFalso(base);
    await esperarLigada(base);
    try {
      const estado = await executar('estado', {}, cliente);
      assert.equal(estado.ponte, 'ligada');
      assert.equal(estado.ano, 2026);
      assert.equal(estado.mes, 9);
      assert.equal(estado.projetos, 1);
      assert.equal(estado.lote_em_curso, false);
      // O comando 'estado' já passou por /mcp/comando, que marca ultimoMcp.
      assert.equal(typeof estado.ultimo_mcp, 'string');

      const mes = await executar('ler_mes', {}, cliente);
      assert.deepEqual(mes.totaisPorDia, { 2: 0.5 });

      const proposta = await executar('propor', { linhas: [{ option_id: 101, date: '2026-09-03', hours: 1 }], nome: 'e2e' }, cliente);
      assert.equal(proposta.estado, 'previa');
      assert.equal(proposta.previa.atualizar[0].option_id, 101);

      const final = await executar('resultado', { id: proposta.id, timeout_s: 5 }, cliente);
      assert.equal(final.estado, 'aplicado');
      assert.equal(final.report.results.length, 1);

      const timesheet = await (await fetch(`${base}/timesheet?year=2026&month=9`)).json();
      assert.deepEqual(timesheet.rows, [{ option_id: 101, project: '', date: '2026-09-03', hours: 1 }]);

      // Depois de as tools terem corrido, /health já reporta ultimoMcp (não null) e a
      // identidade do serve, para o painel da extensão mostrar "Claude ligado há N s".
      const health = await (await fetch(`${base}/health`)).json();
      assert.equal(health.nome, 'suite-timesheet-serve');
      assert.equal(typeof health.ultimoMcp, 'string');
      assert.equal(health.ponte, 'ligada');
    } finally {
      await worker.parar();
    }
  } finally {
    await close();
  }
});
