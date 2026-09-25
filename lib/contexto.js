// Puro. O último contexto que a extensão publicou e a última proposta por mês.

export function criarContexto({ agora = () => Date.now() } = {}) {
  let atual = null;
  const propostas = new Map();
  const chave = (ano, mes) => `${ano}-${mes}`;
  return {
    guardar(ctx) { atual = { ...ctx, recebidoEm: agora() }; },
    atual: () => atual,
    mesVisivel: () => (atual ? { ano: atual.ano, mes: atual.mes } : null),
    guardarProposta(ano, mes, linhas) { propostas.set(chave(ano, mes), linhas); },
    proposta: (ano, mes) => propostas.get(chave(ano, mes)) ?? [],
  };
}
