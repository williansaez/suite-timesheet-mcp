// Puro (cliente injetado). As seis tools do MCP e a sua execução.

import { validarProposta } from './validar.js';

const AVISO = 'Opera só no mês que a Folha de Horas mostra no Chrome. Nunca submete o mês, nunca muda o mês.';
const WAIT_MAX_S = 290;
// O cliente por defeito do SDK do MCP corta a chamada aos 60 s; 50 dá margem para a
// tool responder antes disso. timeout_s continua a poder ser pedido até WAIT_MAX_S (o
// Claude Code permite subir o timeout do cliente MCP quando isso for preciso).
const TIMEOUT_TOOL_S = 50;
// aplicar escreve linha a linha no Suite: pode demorar bem mais do que as outras tools.
const TIMEOUT_APLICAR_S = 120;

export const FERRAMENTAS = [
  {
    name: 'estado',
    description: `Estado da ponte com o Chrome: se a Folha de Horas está aberta, que mês mostra, quantos projetos tem e se há um lote a correr. ${AVISO}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'projetos',
    description: `Projetos do dropdown da Folha de Horas, com option_id, nome e se a linha está trancada (aprovada). ${AVISO}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ler_mes',
    description: `Lê as horas já lançadas no mês visível: uma linha por projeto com os dias preenchidos, o status e os totais por dia. ${AVISO}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'propor',
    description: `Propõe lançamentos para o mês visível. A extensão calcula o plano (criar/atualizar/apagar), abre o painel com a pré-visualização e devolve-a aqui; nada é escrito até o utilizador clicar Aplicar no painel. Depois chama "resultado" com o id. Com espelho: true, as linhas do Suite que não vierem na proposta são apagadas. ${AVISO}`,
    inputSchema: {
      type: 'object',
      required: ['linhas'],
      additionalProperties: false,
      properties: {
        linhas: {
          type: 'array',
          description: 'Uma entrada por projeto e dia. Várias entradas do mesmo projeto no mesmo dia são somadas.',
          items: {
            type: 'object',
            required: ['date', 'hours'],
            additionalProperties: false,
            properties: {
              option_id: { type: 'integer', description: 'id do projeto no dropdown (usa "projetos"). Exclusivo com project.' },
              project: { type: 'string', description: 'nome do projeto como aparece no dropdown. Exclusivo com option_id.' },
              date: { type: 'string', description: 'YYYY-MM-DD, dentro do mês visível' },
              hours: { type: 'number', description: 'de 0,5 a 23,5 em passo de 0,5' },
            },
          },
        },
        espelho: { type: 'boolean', description: 'apaga do Suite o que não vier nas linhas (defeito: false)' },
        nome: { type: 'string', description: 'rótulo que aparece no painel (ex.: "sprint 12")' },
      },
    },
  },
  {
    name: 'aplicar',
    description: `Escreve a proposta "id" no Suite através da extensão, sem esperar pelo clique em Aplicar no painel. Só chama esta tool depois de mostrares a pré-visualização ao utilizador e ele dar OK explícito no chat: essa aprovação, mais a aprovação desta tool no cliente MCP, é que substitui o clique no painel. Linhas trancadas e propostas bloqueadas são recusadas. ${AVISO}`,
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'id devolvido por "propor"' },
        timeout_s: {
          type: 'integer',
          minimum: 1,
          maximum: WAIT_MAX_S,
          description: `segundos a esperar (defeito ${TIMEOUT_APLICAR_S}, máximo ${WAIT_MAX_S}); a escrita é linha a linha e pode ser lenta`,
        },
      },
    },
  },
  {
    name: 'resultado',
    description: `Espera pela decisão do utilizador no painel para uma proposta: aplicado (com o relatório), cancelado (com o motivo), erro, ou pendente se o tempo esgotar (podes voltar a chamar). ${AVISO}`,
    inputSchema: {
      type: 'object',
      required: ['id'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'id devolvido por "propor"' },
        timeout_s: { type: 'integer', minimum: 1, maximum: WAIT_MAX_S, description: `segundos a esperar (defeito ${TIMEOUT_TOOL_S}, máximo ${WAIT_MAX_S})` },
        fase: {
          type: 'string',
          enum: ['previa', 'final'],
          description: 'que fase esperar (defeito "final"). Usa "previa" para recuperar a pré-visualização de um "propor" que ficou pendente.',
        },
      },
    },
  },
];

const erro = (code, message) => Object.assign(new Error(message), { code });

// Um comando síncrono do ponto de vista da tool: ou há dados, ou é erro.
async function dadosDe(cliente, corpo) {
  const r = await cliente.comando(corpo);
  if (!r.resultado) throw erro('ERR_PENDENTE', `O Chrome não respondeu a tempo ao comando ${r.id}. Confirma que a Folha de Horas está aberta e tenta de novo.`);
  if (!r.resultado.ok) throw erro(r.resultado.erro.code, r.resultado.erro.message);
  return { id: r.id, dados: r.resultado.dados };
}

// Forma de um resultado final (dados.fase === 'final'), partilhada por "propor" (quando a
// previa se perdeu e o que chega já é o final) e por "resultado".
const finalDe = (id, dados) => {
  const { estado, report, motivo, erro: erroFinal } = dados;
  if (estado === 'erro') return { id, estado: 'erro', erro: erroFinal };
  return { id, estado, report, motivo };
};

export async function executar(nome, args = {}, cliente, { estadoServe } = {}) {
  switch (nome) {
    case 'estado': {
      let e;
      try {
        e = await cliente.estado();
      } catch (err) {
        // O auto-arranque do mcp.js (ver lib/autoarranque.js) já tentou pôr o serve a
        // responder antes disto. Se não conseguiu, por a porta estar ocupada por outro
        // programa ou por o arranque ter falhado, esta tool não deve lançar: devolve o
        // porquê para o Claude poder explicar ao utilizador em vez de um erro seco.
        if (err.code === 'ERR_SERVE_EM_BAIXO' && (estadoServe?.estado === 'porta-ocupada' || estadoServe?.estado === 'falhou')) {
          return { ponte: 'sem-serve', serve: estadoServe.estado, detalhe: estadoServe.detalhe };
        }
        throw err;
      }
      const base = {
        ponte: e.ponte,
        ano: e.contexto?.ano ?? null,
        mes: e.contexto?.mes ?? null,
        projetos: e.contexto?.projetos?.length ?? 0,
        ultimo_mcp: e.ultimoMcp ?? null,
      };
      if (e.ponte !== 'ligada') return { ...base, lote_em_curso: null };
      if (!e.contexto) {
        // O serve reiniciou depois de a página ter carregado: a ponte está viva (o worker
        // continua a fazer long-poll) mas perdeu o contexto. Um comando 'estado' ia dar
        // ERR_SEM_CONTEXTO — não vale a pena tentar, e esta tool nunca deve lançar por isto.
        return { ...base, lote_em_curso: null, aviso: 'sem contexto: recarrega a Folha de Horas' };
      }
      const { dados } = await dadosDe(cliente, { tipo: 'estado', timeout_s: 10 });
      return { ...base, lote_em_curso: dados.loteEmCurso ?? null };
    }
    case 'projetos': return (await dadosDe(cliente, { tipo: 'projetos', timeout_s: 30 })).dados;
    case 'ler_mes': return (await dadosDe(cliente, { tipo: 'ler', timeout_s: TIMEOUT_TOOL_S })).dados;
    case 'propor': {
      const proposta = validarProposta(args); // erro imediato e legível; o serve valida com o mês
      const r = await cliente.comando({ tipo: 'propor', ...proposta, timeout_s: TIMEOUT_TOOL_S });
      if (!r.resultado) return { id: r.id, estado: 'pendente' };
      if (!r.resultado.ok) throw erro(r.resultado.erro.code, r.resultado.erro.message);
      const { dados } = r.resultado;
      // Normalmente chega logo a previa; se a previa se perdeu (ex.: o worker publicou logo o
      // final) dados.fase já vem 'final' — devolve o estado final em vez de fingir "previa".
      if (dados.fase !== 'previa') return finalDe(r.id, dados);
      const { previa } = dados;
      return { id: r.id, estado: 'previa', previa, bloqueio: previa?.bloqueio ?? null };
    }
    case 'aplicar': {
      const id = String(args.id);
      const timeoutS = Math.min(Number(args.timeout_s) || TIMEOUT_APLICAR_S, WAIT_MAX_S);
      const r = await cliente.comando({ tipo: 'aplicar', proposta: id, timeout_s: timeoutS });
      // "id" devolvido é sempre o da proposta (args.id), não o do comando aplicar em si: quem
      // chamou não conhece nem precisa de conhecer o id interno deste comando de escrita.
      if (!r.resultado) return { id, estado: 'pendente' };
      if (!r.resultado.ok) throw erro(r.resultado.erro.code, r.resultado.erro.message);
      const { dados } = r.resultado;
      if (dados.estado === 'erro') return { id, estado: 'erro', erro: dados.erro };
      return { id, estado: dados.estado, report: dados.report };
    }
    case 'resultado': {
      const waitS = Math.min(Number(args.timeout_s) || TIMEOUT_TOOL_S, WAIT_MAX_S);
      const fase = args.fase === 'previa' ? 'previa' : 'final';
      const r = await cliente.resultado(String(args.id), waitS, fase);
      if (!r.resultado) return { id: r.id, estado: 'pendente' };
      if (!r.resultado.ok) return { id: r.id, estado: 'erro', erro: r.resultado.erro };
      const { dados } = r.resultado;
      if (fase === 'previa' && dados.fase === 'previa') {
        return { id: r.id, estado: 'previa', previa: dados.previa, bloqueio: dados.previa?.bloqueio ?? null };
      }
      return finalDe(r.id, dados);
    }
    default:
      throw erro('ERR_TOOL', `Tool desconhecida: ${nome}.`);
  }
}
