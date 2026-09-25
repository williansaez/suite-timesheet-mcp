// Puro (relógio e ids injetáveis). Fila de comandos entre o MCP e o worker da extensão.
// Um comando de cada vez chega ao worker; um propor só entra quando o anterior tem final.

import { randomUUID } from 'node:crypto';

const erro = (message, extra) => Object.assign(new Error(message), extra);

const TIMEOUT_ENTREGA_DEFEITO_MS = 30 * 1000; // sem timeout_s no pedido, ver CONTRACT.md
const PRAZO_PREVIA_MS = 120 * 1000; // entregue ao worker mas sem previa a tempo: dá-se como perdido

export function criarFila({
  agora = () => Date.now(),
  ttlMs = 60 * 60 * 1000,
  ponteVivaMs = 40 * 1000,
  novoId = randomUUID,
} = {}) {
  const pendentes = [];              // comandos ainda não entregues
  const registos = new Map();        // id -> { cmd, criadoEm, entregueEm, previa, final, timeoutMs }
  const esperasWorker = [];          // { resolve, entregue, timer } à espera de comando
  const esperasResultado = new Map(); // id -> [{ fase, resolve }]
  let ultimoPoll = 0;

  const proporAberto = () => {
    for (const registo of registos.values()) {
      if (registo.cmd.tipo === 'propor' && !registo.final) return registo.cmd.id;
    }
    return null;
  };

  const resolverEsperas = (id, fases, corpo) => {
    const lista = esperasResultado.get(id) ?? [];
    esperasResultado.set(id, lista.filter((espera) => {
      if (!fases.includes(espera.fase)) return true;
      espera.resolve(corpo);
      return false;
    }));
  };

  function expirar(id, registo, message) {
    const final = { ok: false, erro: { code: 'ERR_EXPIRADO', message } };
    registo.final = final;
    if (!registo.previa) registo.previa = final;
    resolverEsperas(id, ['previa', 'final'], final);
  }

  // Comandos por atraso (nunca entregues, ou entregues mas sem previa) tornam-se finais aqui,
  // o que também liberta o próximo `propor` (proporAberto só olha a registos sem final). Depois
  // de expirar, tira o id de `pendentes`: um id evictado ou já expirado ali dentro faria
  // `proximo()` rebentar com TypeError ao tentar atualizar um registo que já não existe (ou que
  // já está fechado). Por fim, o TTL apaga o que sobrou de há muito e já está fechado.
  function limpar() {
    const agoraMs = agora();

    for (const [id, registo] of registos) {
      if (registo.final) continue;
      if (registo.entregueEm === null) {
        if (agoraMs - registo.criadoEm > registo.timeoutMs) {
          expirar(id, registo, `O comando ${id} não foi entregue à extensão a tempo (a ponte pode estar em baixo).`);
        }
      } else if (registo.cmd.tipo === 'propor' && !registo.previa && agoraMs - registo.entregueEm > PRAZO_PREVIA_MS) {
        expirar(id, registo, `A extensão recebeu o comando ${id} mas não devolveu a pré-visualização a tempo; a proposta foi perdida.`);
      }
    }

    for (let i = pendentes.length - 1; i >= 0; i--) {
      const registo = registos.get(pendentes[i].id);
      if (!registo || registo.final) pendentes.splice(i, 1);
    }

    const limite = agoraMs - ttlMs;
    for (const [id, registo] of registos) {
      const fechado = registo.final !== null || registo.cmd.tipo !== 'propor';
      if (registo.criadoEm < limite && fechado) {
        registos.delete(id);
        esperasResultado.delete(id);
      }
    }
  }

  function enfileirar(cmd, { timeoutMs = TIMEOUT_ENTREGA_DEFEITO_MS } = {}) {
    limpar();
    if (cmd.tipo === 'propor') {
      const aberto = proporAberto();
      if (aberto) {
        throw erro(`Já há uma proposta à espera de confirmação no painel (${aberto}).`, { code: 'ERR_OCUPADO', id: aberto });
      }
    }
    const id = cmd.id ?? novoId();
    const completo = { ...cmd, id };
    registos.set(id, { cmd: completo, criadoEm: agora(), entregueEm: null, previa: null, final: null, timeoutMs });
    const espera = esperasWorker.shift();
    if (espera) {
      clearTimeout(espera.timer);
      registos.get(id).entregueEm = agora();
      espera.entregue = completo;
      espera.resolve(completo);
    } else {
      pendentes.push(completo);
    }
    return { id };
  }

  // Devolve { promessa, cancelar } em vez de só a promise: quem faz o long-poll (serve.js) tem
  // de poder desistir se o socket do lado do worker fechar antes de a promise resolver. Se ainda
  // não tinha comando, cancelar() só tira a espera da fila. Se já tinha (a promise resolveu mas o
  // socket morreu antes de o serve conseguir escrever a resposta), cancelar() devolve o comando à
  // cabeça de `pendentes` para não se perder — e por isso é preciso chamar cancelar() antes de
  // outro `proximo()` reclamar o mesmo lugar, e só quando a resposta ainda não foi escrita.
  function proximo(waitMs) {
    limpar();
    ultimoPoll = agora();
    const espera = { resolve: null, entregue: null, timer: null };
    const promessa = new Promise((resolve) => {
      espera.resolve = resolve;
      const cmd = pendentes.shift();
      if (cmd) {
        registos.get(cmd.id).entregueEm = agora();
        espera.entregue = cmd;
        resolve(cmd);
        return;
      }
      esperasWorker.push(espera);
      espera.timer = setTimeout(() => {
        const i = esperasWorker.indexOf(espera);
        if (i >= 0) {
          esperasWorker.splice(i, 1);
          resolve(null);
        }
      }, waitMs);
      // Sem unref: no Node 20 o runner de testes termina com o event loop vazio e cancela
      // promessas à espera de um timer unref'd. Os timers são curtos e limpos na resolução.
    });
    const cancelar = () => {
      clearTimeout(espera.timer);
      const i = esperasWorker.indexOf(espera);
      if (i >= 0) {
        esperasWorker.splice(i, 1);
        return;
      }
      if (espera.entregue) {
        const registo = registos.get(espera.entregue.id);
        if (registo && !registo.final) {
          registo.entregueEm = null;
          pendentes.unshift(espera.entregue);
        }
        espera.entregue = null;
      }
    };
    return { promessa, cancelar };
  }

  function publicar(id, corpo) {
    const registo = registos.get(id);
    if (!registo) return false;
    const ehPrevia = corpo?.ok === true && corpo.dados?.fase === 'previa';
    if (ehPrevia) {
      registo.previa = corpo;
      resolverEsperas(id, ['previa'], corpo);
    } else {
      registo.final = corpo;
      // Um final sem previa (ex.: ERR_OCUPADO, ERR_SESSION) também liberta quem esperava pela previa.
      if (!registo.previa) registo.previa = corpo;
      resolverEsperas(id, ['previa', 'final'], corpo);
    }
    return true;
  }

  function resultado(id, waitMs, fase = 'final') {
    limpar();
    const registo = registos.get(id);
    if (!registo) {
      return Promise.reject(erro(`Comando ${id} desconhecido (o serve pode ter reiniciado).`, { code: 'ERR_COMANDO_DESCONHECIDO' }));
    }
    if (registo[fase]) return Promise.resolve(registo[fase]);
    return new Promise((resolve) => {
      const espera = { fase, resolve };
      esperasResultado.set(id, [...(esperasResultado.get(id) ?? []), espera]);
      const timer = setTimeout(() => {
        const lista = esperasResultado.get(id) ?? [];
        if (lista.includes(espera)) {
          esperasResultado.set(id, lista.filter((e) => e !== espera));
          resolve(null);
        }
      }, waitMs);
    });
  }

  const ponteViva = () => agora() - ultimoPoll < ponteVivaMs;

  const estado = () => ({ pendentes: pendentes.length, registos: registos.size, ultimoPoll, ponteViva: ponteViva() });

  return { enfileirar, proximo, publicar, resultado, ponteViva, limpar, estado };
}
