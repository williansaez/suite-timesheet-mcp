#!/usr/bin/env node
// Servidor MCP por stdio: cliente fino do serve. Nunca fala com o Suite.

import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { FERRAMENTAS, executar } from './lib/ferramentas.js';
import { criarCliente } from './lib/cliente.js';
import { garantirServe } from './lib/autoarranque.js';

const base = process.env.SUITE_TIMESHEET_BASE ?? 'http://127.0.0.1:18765';
// Caminho absoluto do serve.js (irmão deste ficheiro): a mensagem de ERR_SERVE_EM_BAIXO diz
// exatamente o que correr, sem o utilizador ter de adivinhar onde este pacote está instalado.
const comandoArranque = `node ${fileURLToPath(new URL('./serve.js', import.meta.url))}`;
const cliente = criarCliente({ base, comandoArranque });

// Arranca o serve sozinho, salvo pedido em contrário (SUITE_TIMESHEET_SEM_AUTOARRANQUE=1):
// no máximo ~3 s (garantirServe faz 15 tentativas de 200 ms) antes da ligação por stdio, para
// nunca deixar o handshake do MCP pendurado à espera disto. Guarda-se o resultado para a tool
// "estado" poder explicar um "porta-ocupada"/"falhou" em vez de só lançar ERR_SERVE_EM_BAIXO
// (ver lib/ferramentas.js).
let estadoServe;
if (process.env.SUITE_TIMESHEET_SEM_AUTOARRANQUE !== '1') {
  estadoServe = await garantirServe({ base });
  console.error(`[suite-timesheet] serve: ${estadoServe.estado} em ${base}`);
}

const server = new Server(
  { name: 'suite-timesheet', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FERRAMENTAS }));

server.setRequestHandler(CallToolRequestSchema, async (pedido) => {
  try {
    const r = await executar(pedido.params.name, pedido.params.arguments ?? {}, cliente, { estadoServe });
    return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `${e.code ?? 'ERR'}: ${e.message}` }] };
  }
});

await server.connect(new StdioServerTransport());
