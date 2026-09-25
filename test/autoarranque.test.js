import { test } from 'node:test';
import assert from 'node:assert/strict';
import { garantirServe } from '../lib/autoarranque.js';

const BASE = 'http://127.0.0.1:18765';

function respostaOk(corpo) {
  return { status: 200, json: async () => corpo };
}
function respostaEstranha(status, corpo) {
  return { status, json: async () => corpo };
}

// fetch falso: devolve a sequência dada, uma resposta por chamada; a última repete-se para
// chamadas extra. 'falha' faz o fetch rejeitar (nada à escuta).
function fetchDeSequencia(sequencia) {
  let i = 0;
  return async () => {
    const proxima = sequencia[Math.min(i, sequencia.length - 1)];
    i += 1;
    if (proxima === 'falha') throw new Error('ECONNREFUSED');
    return proxima;
  };
}

function contadorDeSpawn() {
  let chamadas = 0;
  const spawn = () => { chamadas += 1; };
  return { spawn, get chamadas() { return chamadas; } };
}

test('ja-corria: /health já identifica este serve, nunca chama spawn', async () => {
  const contador = contadorDeSpawn();
  const r = await garantirServe({
    base: BASE,
    fetch: fetchDeSequencia([respostaOk({ nome: 'suite-timesheet-serve', versao: '1.0.0' })]),
    spawn: contador.spawn,
    pausa: async () => {},
  });
  assert.equal(r.estado, 'ja-corria');
  assert.equal(contador.chamadas, 0);
});

test('porta-ocupada: /health responde 200 mas com outro corpo, nunca chama spawn', async () => {
  const contador = contadorDeSpawn();
  const r = await garantirServe({
    base: BASE,
    fetch: fetchDeSequencia([respostaOk({ outra: 'coisa' })]),
    spawn: contador.spawn,
    pausa: async () => {},
  });
  assert.equal(r.estado, 'porta-ocupada');
  assert.match(r.detalhe, /18765/);
  assert.equal(contador.chamadas, 0);
});

test('porta-ocupada: qualquer status diferente de 200 também não chama spawn', async () => {
  const contador = contadorDeSpawn();
  const r = await garantirServe({
    base: BASE,
    fetch: fetchDeSequencia([respostaEstranha(404, {})]),
    spawn: contador.spawn,
    pausa: async () => {},
  });
  assert.equal(r.estado, 'porta-ocupada');
  assert.equal(contador.chamadas, 0);
});

test('arrancado: nada à escuta à primeira, spawn uma vez, identificado depois de vários polls', async () => {
  const contador = contadorDeSpawn();
  const r = await garantirServe({
    base: BASE,
    fetch: fetchDeSequencia(['falha', 'falha', 'falha', respostaOk({ nome: 'suite-timesheet-serve' })]),
    spawn: contador.spawn,
    pausa: async () => {},
    tentativas: 15,
  });
  assert.equal(r.estado, 'arrancado');
  assert.equal(contador.chamadas, 1);
});

test('falhou: spawn uma vez mas nunca fica saudável dentro das tentativas', async () => {
  const contador = contadorDeSpawn();
  const r = await garantirServe({
    base: BASE,
    fetch: fetchDeSequencia(['falha']),
    spawn: contador.spawn,
    pausa: async () => {},
    tentativas: 5,
  });
  assert.equal(r.estado, 'falhou');
  assert.equal(contador.chamadas, 1);
});

test('falhou: identidade errada em todos os polls também não conta como saudável', async () => {
  const contador = contadorDeSpawn();
  const r = await garantirServe({
    base: BASE,
    fetch: fetchDeSequencia(['falha', respostaOk({ nome: 'outro-programa' })]),
    spawn: contador.spawn,
    pausa: async () => {},
    tentativas: 3,
  });
  assert.equal(r.estado, 'falhou');
  assert.equal(contador.chamadas, 1);
});
