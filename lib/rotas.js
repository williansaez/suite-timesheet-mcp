// Puro (fila e contexto injetados). Um router sem http: recebe {metodo, caminho, query, corpo}
// e devolve {status, corpo}. serve.js é a cola HTTP à volta disto.

import { validarProposta } from './validar.js';

const TIPOS = ['estado', 'projetos', 'ler', 'propor', 'aplicar'];
// O Chrome mata um service worker MV3 cujo fetch demora mais de ~30 s: 25 é o wait que o
// CONTRACT.md promete (worker pede wait=25) e o máximo que este serve aceita.
const WAIT_BRIDGE_MAX_S = 25;
const WAIT_MCP_MAX_S = 290; // o fetch do Node corta cabeçalhos aos 300 s
const TIMEOUT_COMANDO_S = 30;
// aplicar escreve linha a linha no Suite: pode demorar bem mais do que um comando normal.
const TIMEOUT_APLICAR_DEFEITO_S = 120;

const erro = (status, code, message) => ({ status, corpo: { erro: { code, message } } });
const mesTexto = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`;
const inteiro = (v, defeito) => (Number.isFinite(Number(v)) ? Number(v) : defeito);
const limitar = (v, max) => Math.max(0, Math.min(inteiro(v, max), max));

export function criarRotas({ fila, contexto, log = () => {}, versao, agora = Date.now }) {
  // Timestamp ISO do último pedido a qualquer rota /mcp/*, ou null se ainda não houve nenhum
  // desde que este `serve` arrancou. É o que /health e /mcp/estado mostram como "ultimoMcp",
  // para a extensão (painel) saber se o Claude ainda está a falar com o serviço.
  let ultimoMcp = null;
  const marcarMcp = () => { ultimoMcp = new Date(agora()).toISOString(); };

  async function comando(corpo) {
    if (!corpo || !TIPOS.includes(corpo.tipo)) return erro(400, 'ERR_COMANDO', `tipo tem de ser um de ${TIPOS.join(', ')}.`);
    if (!fila.ponteViva()) {
      return erro(409, 'ERR_SEM_CHROME', 'Abre a Folha de Horas do Suite no Chrome e espera uns segundos.');
    }
    const visivel = contexto.mesVisivel();
    if (!visivel) {
      // A ponte está viva (o worker está a fazer long-poll), mas o serve reiniciou depois de a
      // página ter carregado: perdeu o contexto e ainda não houve recarregamento para o repor.
      return erro(409, 'ERR_SEM_CONTEXTO', 'A ponte está ligada mas ainda não recebi o mês da página. Recarrega a Folha de Horas no Chrome.');
    }
    const ano = inteiro(corpo.ano, visivel.ano);
    const mes = inteiro(corpo.mes, visivel.mes);
    if (ano !== visivel.ano || mes !== visivel.mes) {
      return erro(409, 'ERR_MES_DIFERENTE',
        `A página mostra ${mesTexto(visivel.ano, visivel.mes)} e pediste ${mesTexto(ano, mes)}. Muda o mês na página do Suite.`);
    }
    let cmd = { tipo: corpo.tipo, ano, mes };
    let proposta = null;
    if (corpo.tipo === 'propor') {
      try {
        proposta = validarProposta(corpo, visivel);
      } catch (e) {
        return erro(400, e.code ?? 'ERR_PROPOSTA', e.message);
      }
      cmd = { ...cmd, ...proposta };
    }
    if (corpo.tipo === 'aplicar') {
      // aplicar resolve um propor já enfileirado (pelo id da proposta), não cria um novo à
      // espera de confirmação — por isso não passa por validarProposta nem por proporAberto.
      if (typeof corpo.proposta !== 'string' || corpo.proposta.trim() === '') {
        return erro(400, 'ERR_COMANDO', 'proposta tem de ser o id de uma proposta pendente (devolvido por "propor").');
      }
      cmd = { ...cmd, proposta: corpo.proposta };
    }
    // Quanto tempo este pedido HTTP espera sincronamente pelo resultado (0 é válido: "não
    // bloqueies, dá-me pendente"). É distinto do prazo de entrega guardado na fila: um
    // timeout_s pequeno (ou 0) não pode fazer o comando expirar antes de chegar a um worker —
    // por isso o prazo de entrega tem sempre um mínimo de TIMEOUT_COMANDO_S. aplicar escreve
    // linha a linha, por isso o seu defeito (sem timeout_s no pedido) é maior que o dos outros.
    const defeitoTimeoutS = corpo.tipo === 'aplicar' ? TIMEOUT_APLICAR_DEFEITO_S : TIMEOUT_COMANDO_S;
    const waitResultadoMs = limitar(corpo.timeout_s ?? defeitoTimeoutS, WAIT_MCP_MAX_S) * 1000;
    const timeoutEntregaMs = Math.max(waitResultadoMs, TIMEOUT_COMANDO_S * 1000);
    let id;
    try {
      ({ id } = fila.enfileirar(cmd, { timeoutMs: timeoutEntregaMs }));
    } catch (e) {
      return erro(409, e.code ?? 'ERR_OCUPADO', e.message);
    }
    // Só grava a proposta depois do enfileirar aceitar: se der ERR_OCUPADO, a proposta
    // rejeitada não pode substituir a que já estava guardada para o /timesheet.
    if (proposta) contexto.guardarProposta(ano, mes, proposta.linhas);
    log(`comando ${id} ${cmd.tipo} ${mesTexto(ano, mes)}`);
    const fase = cmd.tipo === 'propor' ? 'previa' : 'final';
    const resultado = await fila.resultado(id, waitResultadoMs, fase);
    return { status: 200, corpo: { id, estado: resultado ? 'concluido' : 'pendente', resultado } };
  }

  return async function despachar({ metodo, caminho, query = {}, corpo = null, aoFechar = () => {} }) {
    if (metodo === 'GET' && caminho === '/health') {
      // JSON (não texto) desde sempre: a extensão usa "nome" para distinguir este serve de
      // qualquer outro programa na mesma porta — um corpo de texto passa a contar como isso.
      return {
        status: 200,
        corpo: { nome: 'suite-timesheet-serve', versao, ultimoMcp, ponte: fila.ponteViva() ? 'ligada' : 'sem-chrome' },
      };
    }

    if (metodo === 'GET' && caminho === '/timesheet') {
      const year = inteiro(query.year, 0);
      const month = inteiro(query.month, 0);
      return { status: 200, corpo: { year, month, generated_at: new Date().toISOString(), rows: contexto.proposta(year, month) } };
    }

    if (metodo === 'POST' && caminho === '/bridge/contexto') {
      if (!corpo || !Number.isInteger(corpo.ano) || !Number.isInteger(corpo.mes)) return erro(400, 'ERR_COMANDO', 'contexto sem ano/mes.');
      contexto.guardar(corpo);
      return { status: 204 };
    }

    if (metodo === 'GET' && caminho === '/bridge/next') {
      const { promessa, cancelar } = fila.proximo(limitar(query.wait ?? WAIT_BRIDGE_MAX_S, WAIT_BRIDGE_MAX_S) * 1000);
      // Dá ao serve.js uma forma de desistir se o socket do worker morrer antes desta promise
      // resolver, para o comando (se já lhe tiver sido atribuído) não se perder (ver fila.js).
      aoFechar(cancelar);
      const cmd = await promessa;
      return cmd ? { status: 200, corpo: cmd } : { status: 204 };
    }

    const resultadoDe = /^\/bridge\/result\/([^/]+)$/.exec(caminho);
    if (metodo === 'POST' && resultadoDe) {
      const id = decodeURIComponent(resultadoDe[1]);
      const aceite = fila.publicar(id, corpo);
      log(`resultado ${id} ${corpo?.ok ? 'ok' : corpo?.erro?.code ?? '?'}${corpo?.dados?.fase ? ` ${corpo.dados.fase}` : ''}`);
      return aceite ? { status: 204 } : erro(404, 'ERR_COMANDO_DESCONHECIDO', `Comando ${id} desconhecido.`);
    }

    if (metodo === 'GET' && caminho === '/mcp/estado') {
      marcarMcp();
      return { status: 200, corpo: { ponte: fila.ponteViva() ? 'ligada' : 'sem-chrome', contexto: contexto.atual(), ultimoMcp } };
    }

    if (metodo === 'POST' && caminho === '/mcp/comando') {
      marcarMcp();
      return comando(corpo);
    }

    const comandoDe = /^\/mcp\/comando\/([^/]+)$/.exec(caminho);
    if (metodo === 'GET' && comandoDe) {
      marcarMcp();
      const id = decodeURIComponent(comandoDe[1]);
      try {
        const resultado = await fila.resultado(id, limitar(query.wait ?? 0, WAIT_MCP_MAX_S) * 1000, query.fase === 'previa' ? 'previa' : 'final');
        return { status: 200, corpo: { id, estado: resultado ? 'concluido' : 'pendente', resultado } };
      } catch (e) {
        return erro(404, e.code ?? 'ERR_COMANDO_DESCONHECIDO', e.message);
      }
    }

    return erro(404, 'ERR_ROTA', `Não existe ${metodo} ${caminho}.`);
  };
}
