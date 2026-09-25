import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Fala JSON-RPC com o mcp.js por stdio, uma mensagem por linha.
async function sessao(mensagens) {
  const filho = spawn(process.execPath, [new URL('../mcp.js', import.meta.url).pathname], {
    env: {
      ...process.env,
      SUITE_TIMESHEET_BASE: 'http://127.0.0.1:1', // serve em baixo de propósito
      SUITE_TIMESHEET_SEM_AUTOARRANQUE: '1', // este teste quer o ERR_SERVE_EM_BAIXO "seco", não o auto-arranque
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let saida = '';
  filho.stdout.on('data', (d) => { saida += d; });
  for (const m of mensagens) filho.stdin.write(`${JSON.stringify(m)}\n`);
  filho.stdin.end();
  await once(filho, 'close');
  return saida.split('\n').filter(Boolean).map((linha) => JSON.parse(linha));
}

test('mcp.js lista as seis tools e devolve um erro legível quando o serve está em baixo', async () => {
  const respostas = await sessao([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'teste', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'estado', arguments: {} } },
  ]);
  const lista = respostas.find((r) => r.id === 2);
  assert.deepEqual(lista.result.tools.map((t) => t.name), ['estado', 'projetos', 'ler_mes', 'propor', 'aplicar', 'resultado']);
  const chamada = respostas.find((r) => r.id === 3);
  assert.equal(chamada.result.isError, true);
  assert.match(chamada.result.content[0].text, /ERR_SERVE_EM_BAIXO/);
});
