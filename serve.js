#!/usr/bin/env node
// Cola HTTP: só escuta em 127.0.0.1. Nunca fala com o Suite.

import http from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { criarFila } from './lib/fila.js';
import { criarContexto } from './lib/contexto.js';
import { criarRotas } from './lib/rotas.js';

// Lida uma vez à boca do processo (não a cada pedido): é só a versão deste pacote, para
// /health a extensão poder ver se está a falar com um "serve" mais velho ou mais novo.
function lerVersao() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? 'desconhecida';
  } catch {
    return 'desconhecida'; // package.json em falta ou corrompido não pode impedir o serve de arrancar
  }
}
const VERSAO = lerVersao();

export const PORTA_POR_DEFEITO = 18765;
const LIMITE_CORPO_BYTES = 1024 * 1024; // 1 MB
const HOST_PERMITIDO = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

// Só a extensão (chrome-extension://…) pode chamar este serviço; uma página qualquer que
// tentasse falar com 127.0.0.1 a partir do browser manda Origin, então "sem Origin" (curl, a
// própria extensão sem CORS quando aplicável, ferramentas locais) continua a passar.
const origemPermitida = (origem) => !origem || origem.startsWith('chrome-extension://');
// DNS rebinding: um domínio público a resolver para 127.0.0.1 ainda manda Host com o nome dele,
// não com "127.0.0.1" — rejeitar tudo o que não seja isto fecha essa porta.
const hostPermitido = (host) => HOST_PERMITIDO.test(host ?? '');

// Lê o corpo por eventos (não por `for await`): assim um erro de rede (aborted/ECONNRESET)
// ou um corpo grande de mais rejeita a promise em vez de escapar como unhandled rejection.
function lerCorpo(req, limite) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let terminado = false;
    const falhar = (e) => {
      if (terminado) return;
      terminado = true;
      reject(e);
    };
    req.on('data', (parte) => {
      if (terminado) return;
      total += parte.length;
      if (total > limite) {
        falhar(Object.assign(new Error('O corpo do pedido excede o limite.'), { code: 'ERR_CORPO_GRANDE' }));
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => {
      if (terminado) return;
      terminado = true;
      resolve(Buffer.concat(partes).toString('utf8'));
    });
    req.on('error', falhar);
    // 'aborted' dispara quando o cliente fecha a ligação a meio do corpo.
    req.on('aborted', () => falhar(Object.assign(new Error('A ligação foi abaixo a meio do corpo.'), { code: 'ERR_ABORTADO' })));
  });
}

export function arrancarServe({
  porta = PORTA_POR_DEFEITO,
  host = '127.0.0.1',
  log = (linha) => console.error(linha),
  despachar: despacharInjetado, // só para testes: substitui o router real (ver test/serve.test.js)
} = {}) {
  const fila = criarFila();
  const contexto = criarContexto();
  const despachar = despacharInjetado ?? criarRotas({ fila, contexto, log, versao: VERSAO });

  const server = http.createServer(async (req, res) => {
    const erroJson = (status, code, message) => {
      escrita = true;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ erro: { code, message } }));
    };

    // Um comando pode ser atribuído a este long-poll (fila.proximo) e o socket morrer antes de
    // conseguirmos escrever a resposta. 'close' num res ainda não escrito é esse caso: chama o
    // cancelar() que a rota /bridge/next registou, para o comando voltar para a fila em vez de
    // se perder (ver lib/fila.js). Depois de a resposta ser escrita, 'close' é só o fim normal
    // da ligação e não faz nada.
    let escrita = false;
    let cancelarEspera = null;
    res.on('close', () => { if (!escrita) cancelarEspera?.(); });

    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      // Linha de pedido malformada (ex.: URL com IPv6 sem fechar "]"): new URL() rejeita e,
      // fora de um try/catch, isso vira unhandled rejection e derruba este serve.
      erroJson(400, 'ERR_COMANDO', 'O pedido tem um URL inválido.');
      return;
    }

    if (!hostPermitido(req.headers.host)) {
      erroJson(421, 'ERR_HOST', 'Este serviço só aceita pedidos para 127.0.0.1 ou localhost.');
      return;
    }
    if (!origemPermitida(req.headers.origin)) {
      erroJson(403, 'ERR_ORIGEM', 'Só a extensão pode chamar este serviço.');
      return;
    }

    let corpo = null;
    if (req.method === 'POST') {
      const tipoCorpo = req.headers['content-type'] ?? '';
      if (!tipoCorpo.toLowerCase().startsWith('application/json')) {
        erroJson(415, 'ERR_CONTENT_TYPE', 'O corpo do pedido tem de ser application/json.');
        return;
      }
      let texto;
      try {
        texto = await lerCorpo(req, LIMITE_CORPO_BYTES);
      } catch (e) {
        if (e.code === 'ERR_CORPO_GRANDE') {
          // Connection: close obriga o Node a fechar o socket depois de a resposta sair. Só com
          // req.destroy() o Node 20 mantinha o socket vivo para keep-alive e o cliente ficava
          // pendurado até ao keepAliveTimeout.
          res.setHeader('Connection', 'close');
          erroJson(413, 'ERR_CORPO_GRANDE', 'O corpo do pedido excede 1 MB.');
          req.destroy();
        }
        // ERR_ABORTADO (ou outro erro de rede): o cliente já desligou, não há a quem responder.
        return;
      }
      try {
        corpo = texto ? JSON.parse(texto) : null;
      } catch {
        erroJson(400, 'ERR_COMANDO', 'O corpo não é JSON válido.');
        return;
      }
    }
    let r;
    try {
      r = await despachar({
        metodo: req.method,
        caminho: url.pathname,
        query: Object.fromEntries(url.searchParams),
        corpo,
        aoFechar: (cancelar) => { cancelarEspera = cancelar; },
      });
    } catch (e) {
      // Um throw inesperado no router não pode virar unhandled rejection e derrubar
      // este servidor local de longa duração.
      log(`erro interno em ${req.method} ${url.pathname}: ${e.stack ?? e.message}`);
      erroJson(500, 'ERR_INTERNO', e.message);
      return;
    }
    escrita = true;
    if (r.status === 204) { res.writeHead(204); res.end(); return; }
    const texto = typeof r.corpo === 'string';
    res.writeHead(r.status, { 'content-type': texto ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' });
    res.end(texto ? r.corpo : JSON.stringify(r.corpo));
  });
  server.keepAliveTimeout = 65_000; // acima do wait máximo do long-poll
  server.headersTimeout = 70_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(porta, host, () => {
      resolve({
        base: `http://${host}:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

const ehMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (ehMain) {
  const porta = Number(process.argv[2] ?? PORTA_POR_DEFEITO);
  arrancarServe({ porta })
    .then(({ base }) => console.error(`suite-timesheet-serve em ${base} (Ctrl+C para parar)`))
    .catch((e) => { console.error(`Não consegui escutar na porta ${porta}: ${e.message}`); process.exit(1); });
}
