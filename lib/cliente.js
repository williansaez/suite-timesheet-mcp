// Cliente HTTP do serve, usado pelo mcp.js. fetch injetável para os testes.

export function criarCliente({ base, fetch: fetchImpl = globalThis.fetch, comandoArranque = 'node serve.js' }) {
  async function pedir(metodo, caminho, corpo) {
    let resposta;
    try {
      resposta = await fetchImpl(`${base}${caminho}`, {
        method: metodo,
        headers: corpo ? { 'content-type': 'application/json' } : {},
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
    } catch (e) {
      throw Object.assign(
        new Error(`O serviço local não responde em ${base} (${e.message}). Arranca-o com: ${comandoArranque}`),
        { code: 'ERR_SERVE_EM_BAIXO' },
      );
    }
    const json = await resposta.json().catch(() => null);
    if (!resposta.ok) {
      const erro = json?.erro ?? { code: 'ERR_SERVE', message: `O serviço local devolveu HTTP ${resposta.status}.` };
      throw Object.assign(new Error(erro.message), { code: erro.code });
    }
    return json;
  }
  return {
    estado: () => pedir('GET', '/mcp/estado'),
    comando: (corpo) => pedir('POST', '/mcp/comando', corpo),
    resultado: (id, waitS, fase = 'final') => pedir('GET', `/mcp/comando/${encodeURIComponent(id)}?wait=${waitS}&fase=${fase}`),
  };
}
