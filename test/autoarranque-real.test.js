import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';

// Integração a sério (sem fetch/spawn injetados): confirma que mcp.js, ligado a uma porta sem
// nada à escuta, arranca ele próprio o serve.js antes de responder à tool "estado".

// Pede uma porta livre ao SO: liga um servidor TCP à porta 0, lê a porta escolhida, fecha.
async function portaLivre() {
  return new Promise((resolve, reject) => {
    const servidor = net.createServer();
    servidor.on('error', reject);
    servidor.listen(0, '127.0.0.1', () => {
      const { port } = servidor.address();
      servidor.close(() => resolve(port));
    });
  });
}

// O serve fica detached e sem stdio ligado ao mcp.js (ver lib/autoarranque.js): a forma mais
// simples de o encontrar depois, em macOS e em Ubuntu, é perguntar ao SO quem está à escuta
// naquela porta. -sTCP:LISTEN é essencial, não cosmética: sem isto, "lsof -ti tcp:<porta>"
// também apanha ligações cliente a essa porta — como o próprio fetch(base/health) deste
// teste — e mata o próprio processo do teste em vez de só o serve.
function matarNaPorta(porta) {
  try {
    const saida = execSync(`lsof -ti tcp:${porta} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (!saida) return;
    for (const linha of saida.split('\n')) {
      const pid = Number(linha.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* já tinha morrido */ }
      }
    }
  } catch {
    // lsof sai com código != 0 quando não há nada à escuta na porta; não há nada para matar.
  }
}

test('mcp.js arranca o serve sozinho quando liga a uma porta sem nada à escuta', async (t) => {
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;

  const filho = spawn(process.execPath, [new URL('../mcp.js', import.meta.url).pathname], {
    env: { ...process.env, SUITE_TIMESHEET_BASE: base },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(() => matarNaPorta(porta));

  let saida = '';
  filho.stdout.on('data', (d) => { saida += d; });
  let erroPadrao = '';
  filho.stderr.on('data', (d) => { erroPadrao += d; });

  const mensagens = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'teste', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'estado', arguments: {} } },
  ];
  for (const m of mensagens) filho.stdin.write(`${JSON.stringify(m)}\n`);
  filho.stdin.end();

  await once(filho, 'close');

  assert.match(erroPadrao, /\[suite-timesheet\] serve: arrancado em/);

  const respostas = saida.split('\n').filter(Boolean).map((linha) => JSON.parse(linha));
  const chamada = respostas.find((r) => r.id === 2);
  assert.ok(chamada, 'devia haver uma resposta à chamada da tool "estado"');
  const texto = chamada.result?.content?.[0]?.text ?? '';
  assert.doesNotMatch(texto, /ERR_SERVE_EM_BAIXO/);

  // O serve que o mcp.js arrancou continua vivo (detached) e responde por si: confirma a
  // identidade em /health directamente, sem passar pelo mcp.js.
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const corpoHealth = await health.json();
  assert.equal(corpoHealth.nome, 'suite-timesheet-serve');
});
