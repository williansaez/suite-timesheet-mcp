// Auto-arranque do serve: o mcp.js chama isto antes de se ligar por stdio, para o utilizador
// não ter de arrancar o `serve` à mão. Puro-ish: fetch, spawn e pausa são injetáveis (só
// `spawnServeReal`, usado como valor por defeito, toca em node:child_process a sério).

import { spawn as spawnReal } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORTA_POR_DEFEITO = 18765;

function portaDe(base) {
  try {
    const porta = new URL(base).port;
    return porta ? Number(porta) : PORTA_POR_DEFEITO;
  } catch {
    return PORTA_POR_DEFEITO;
  }
}

// Só isto identifica um "serve" desta package: nome fixo devolvido por GET /health
// (ver lib/rotas.js). Qualquer outra coisa na porta (outro programa, um proxy, etc.) não passa.
function ehIdentidade(json) {
  return Boolean(json) && typeof json === 'object' && json.nome === 'suite-timesheet-serve';
}

function pausaReal(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Arranca o serve.js real, desligado deste processo: detached (não morre com o mcp.js),
// stdio 'ignore' (não herda nem escreve no stdio que o protocolo MCP usa) e unref() (não
// impede o mcp.js de terminar enquanto o serve continua a correr).
function spawnServeReal(porta) {
  const caminhoServe = fileURLToPath(new URL('../serve.js', import.meta.url));
  const filho = spawnReal(process.execPath, [caminhoServe, String(porta)], {
    detached: true,
    stdio: 'ignore',
  });
  filho.unref();
  return filho;
}

// GET base/health, sem lançar: { ligou: false } se o fetch falhar (nada à escuta),
// { ligou: true, status, json } caso contrário (json pode ser null se o corpo não for JSON).
async function verHealth(base, fetchImpl) {
  let resposta;
  try {
    resposta = await fetchImpl(`${base}/health`);
  } catch {
    return { ligou: false };
  }
  const json = await resposta.json().catch(() => null);
  return { ligou: true, status: resposta.status, json };
}

/**
 * Garante que há um `serve` desta package a responder em `base`. Nunca lança: devolve sempre
 * { estado, detalhe }, com estado um de 'ja-corria' | 'arrancado' | 'porta-ocupada' | 'falhou'.
 */
export async function garantirServe({
  base,
  fetch: fetchImpl = globalThis.fetch,
  spawn: spawnImpl,
  pausa = pausaReal,
  tentativas = 15,
} = {}) {
  const porta = portaDe(base);
  const arrancar = spawnImpl ?? (() => spawnServeReal(porta));

  const primeira = await verHealth(base, fetchImpl);

  if (primeira.ligou) {
    if (primeira.status === 200 && ehIdentidade(primeira.json)) {
      return { estado: 'ja-corria', detalhe: `Já havia um serve a responder em ${base}.` };
    }
    // Responde, mas não é este serve: outro programa qualquer está nesta porta. Nunca arrancar
    // o serve por cima disso.
    return { estado: 'porta-ocupada', detalhe: `Na porta ${porta} responde outro programa.` };
  }

  // Nada à escuta: arrancar o serve e esperar que fique saudável.
  arrancar();
  for (let i = 0; i < tentativas; i += 1) {
    await pausa(200);
    const tentativa = await verHealth(base, fetchImpl);
    if (tentativa.ligou && tentativa.status === 200 && ehIdentidade(tentativa.json)) {
      return { estado: 'arrancado', detalhe: `Arranquei o serve em ${base}.` };
    }
  }
  return { estado: 'falhou', detalhe: `Não consegui arrancar o serve em ${base} (tenta "node serve.js").` };
}
