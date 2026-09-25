import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { arrancarServe } from '../serve.js';

// Abre um socket TCP em bruto para a porta do serve, escreve `pedido` (a linha de pedido e
// cabeçalhos completos, com \r\n) e devolve { socket } já ligado, para o teste escrever o
// corpo (ou não) e fechar quando quiser.
function socketPara(base) {
  const porta = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    const socket = net.connect(porta, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('o serve responde por HTTP em 127.0.0.1 e faz o long-poll de /bridge/next', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  try {
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('content-type'), 'application/json; charset=utf-8');
    const corpoHealth = await health.json();
    assert.equal(corpoHealth.nome, 'suite-timesheet-serve');
    assert.equal(typeof corpoHealth.versao, 'string');
    assert.equal(corpoHealth.ultimoMcp, null);
    assert.equal(corpoHealth.ponte, 'sem-chrome');
    const inicio = Date.now();
    const next = await fetch(`${base}/bridge/next?wait=1`);
    assert.equal(next.status, 204);
    // Margem larga (só 800 de 1000 ms): numa máquina lenta ou sob carga (CI, disco a
    // girar, etc.) o event loop pode atrasar-se uns dezenas de ms antes do setTimeout
    // do long-poll disparar; isto continua a provar que esperámos, sem ficar flaky.
    assert.equal(Date.now() - inicio >= 800, true);
    const mau = await fetch(`${base}/bridge/contexto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{não é json',
    });
    assert.equal(mau.status, 400);
  } finally {
    await close();
  }
});

test('um router que rebenta dá HTTP 500 com ERR_INTERNO, e o servidor continua a responder depois', async () => {
  const logs = [];
  const despachar = async ({ caminho }) => {
    if (caminho === '/boom') throw new Error('explodiu no router');
    if (caminho === '/health') return { status: 200, corpo: 'ok' };
    return { status: 404, corpo: { erro: { code: 'ERR_ROTA', message: 'nada' } } };
  };
  const { base, close } = await arrancarServe({ porta: 0, log: (linha) => logs.push(linha), despachar });
  try {
    const boom = await fetch(`${base}/boom`);
    assert.equal(boom.status, 500);
    const corpo = await boom.json();
    assert.equal(corpo.erro.code, 'ERR_INTERNO');
    assert.equal(logs.some((l) => l.includes('erro interno')), true);

    // O throw não pode ter derrubado o servidor: /health continua a responder normalmente.
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');
  } finally {
    await close();
  }
});

test('um POST abortado a meio do corpo não derruba o serve (aborted/ECONNRESET)', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  try {
    await new Promise((resolve, reject) => {
      socketPara(base).then((socket) => {
        socket.on('error', () => {}); // ECONNRESET deste lado é esperado ao fechar a meio
        socket.on('close', resolve);
        socket.setTimeout(2000, () => reject(new Error('timeout à espera do close')));
        socket.write(
          'POST /bridge/contexto HTTP/1.1\r\n'
          + 'Host: 127.0.0.1\r\n'
          + 'Content-Type: application/json\r\n'
          + 'Content-Length: 100\r\n'
          + '\r\n'
          + '{"ano":2026', // Content-Length promete 100 bytes; só mandamos um pedaço e fechamos.
        );
        setTimeout(() => socket.destroy(), 50);
      }, reject);
    });
    // O serve não pode ter caído com um unhandled rejection: /health continua a responder.
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

test('um corpo maior que 1 MB corta a ligação (ERR_CORPO_GRANDE), e o serve continua a responder', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  try {
    // Socket em bruto: um corpo de 2 MB nunca chega a ser todo lido para memória. O que o
    // cliente vê a seguir (RST, EPIPE, a resposta 413, ou nada durante uns segundos) depende do
    // sistema operativo: no Linux do CI o socket pode ficar aberto até o kernel drenar o que o
    // cliente já tinha enviado. O invariante que interessa é o de baixo: o serve continua vivo.
    // Aqui só esperamos, com limite, por um sinal de reação, e fechamos nós o socket se não vier.
    await new Promise((resolve) => {
      socketPara(base).then((socket) => {
        const fim = () => { socket.destroy(); resolve(); };
        socket.on('error', fim); // ECONNRESET/EPIPE esperados: o serve corta a ligação
        socket.on('close', () => resolve());
        socket.on('data', (d) => { if (String(d).includes(' 413 ')) fim(); });
        socket.setTimeout(2000, fim);
        const corpo = 'x'.repeat(2 * 1024 * 1024); // 2 MB > limite de 1 MB
        socket.write(
          'POST /bridge/contexto HTTP/1.1\r\n'
          + 'Host: 127.0.0.1\r\n'
          + 'Content-Type: application/json\r\n'
          + `Content-Length: ${corpo.length}\r\n`
          + '\r\n',
        );
        socket.write(corpo);
      }, () => resolve());
    });
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

test('um comando entregue a um long-poll cujo socket já morreu volta para a fila; outro worker recebe-o', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  try {
    await fetch(`${base}/bridge/contexto`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ano: 2026, mes: 9, diasNoMes: 30, projetos: [], lidoEm: 'x' }),
    });

    // Worker 1: abre o long-poll (isto já marca a ponte como viva) e desliga antes de
    // qualquer comando chegar — como um service worker MV3 que o Chrome mata a meio do fetch.
    const socket1 = await socketPara(base);
    socket1.write('GET /bridge/next?wait=5 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    await new Promise((r) => setTimeout(r, 50)); // dá tempo ao serve para registar a espera
    await new Promise((resolve) => { socket1.once('close', resolve); socket1.destroy(); });
    await new Promise((r) => setTimeout(r, 50)); // dá tempo ao 'close' do lado do serve correr

    // Um comando enfileirado agora não pode ir para o worker 1 (morto): fica em pendentes.
    const resposta = await fetch(`${base}/mcp/comando`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tipo: 'ler', timeout_s: 0 }),
    });
    assert.equal((await resposta.json()).estado, 'pendente');

    // Worker 2: chega depois e recebe o comando que o worker 1 nunca podia ter recebido.
    const next = await fetch(`${base}/bridge/next?wait=1`);
    assert.equal(next.status, 200);
    assert.equal((await next.json()).tipo, 'ler');
  } finally {
    await close();
  }
});

test('um Host que não seja 127.0.0.1 nem localhost dá 421 ERR_HOST', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  try {
    const resposta = await new Promise((resolve, reject) => {
      socketPara(base).then((socket) => {
        let dados = '';
        socket.on('data', (d) => { dados += d.toString('utf8'); });
        socket.on('end', () => resolve(dados));
        socket.on('error', reject);
        socket.setTimeout(2000, () => reject(new Error('timeout à espera da resposta')));
        // Um domínio público a apontar para 127.0.0.1 (DNS rebinding) manda Host com o nome dele.
        socket.write('GET /health HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
      }, reject);
    });
    assert.match(resposta, /^HTTP\/1\.1 421/);
    assert.match(resposta, /ERR_HOST/);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

test('uma Origin que não seja chrome-extension:// dá 403 ERR_ORIGEM, mas chrome-extension:// passa', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  try {
    const recusada = await new Promise((resolve, reject) => {
      socketPara(base).then((socket) => {
        let dados = '';
        socket.on('data', (d) => { dados += d.toString('utf8'); });
        socket.on('end', () => resolve(dados));
        socket.on('error', reject);
        socket.setTimeout(2000, () => reject(new Error('timeout à espera da resposta')));
        socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://evil.example\r\nConnection: close\r\n\r\n');
      }, reject);
    });
    assert.match(recusada, /^HTTP\/1\.1 403/);
    assert.match(recusada, /ERR_ORIGEM/);

    const aceite = await new Promise((resolve, reject) => {
      socketPara(base).then((socket) => {
        let dados = '';
        socket.on('data', (d) => { dados += d.toString('utf8'); });
        socket.on('end', () => resolve(dados));
        socket.on('error', reject);
        socket.setTimeout(2000, () => reject(new Error('timeout à espera da resposta')));
        socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: chrome-extension://abcdefghijklmnop\r\nConnection: close\r\n\r\n');
      }, reject);
    });
    assert.match(aceite, /^HTTP\/1\.1 200/);
  } finally {
    await close();
  }
});

test('um POST sem content-type application/json dá 415 ERR_CONTENT_TYPE', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  try {
    // Sem content-type explícito, o fetch põe "text/plain;charset=UTF-8" por defeito.
    const resposta = await fetch(`${base}/bridge/contexto`, { method: 'POST', body: JSON.stringify({ ano: 2026, mes: 9 }) });
    assert.equal(resposta.status, 415);
    assert.equal((await resposta.json()).erro.code, 'ERR_CONTENT_TYPE');
  } finally {
    await close();
  }
});

test('uma linha de pedido malformada dá 400 ERR_COMANDO, e o serve continua a responder', async () => {
  const { base, close } = await arrancarServe({ porta: 0, log: () => {} });
  try {
    const resposta = await new Promise((resolve, reject) => {
      socketPara(base).then((socket) => {
        let dados = '';
        socket.on('data', (d) => { dados += d.toString('utf8'); });
        socket.on('end', () => resolve(dados));
        socket.on('error', reject);
        socket.setTimeout(2000, () => reject(new Error('timeout à espera da resposta')));
        // "[::1" sem fechar "]": new URL(req.url, ...) rejeita com ERR_INVALID_URL.
        socket.write('GET http://[::1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      }, reject);
    });
    assert.match(resposta, /^HTTP\/1\.1 400/);
    assert.match(resposta, /ERR_COMANDO/);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});
