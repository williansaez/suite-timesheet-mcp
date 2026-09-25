import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarFila } from '../lib/fila.js';

function relogio(inicio = 1_000_000) {
  let t = inicio;
  return { agora: () => t, avancar: (ms) => { t += ms; } };
}

const ids = () => { let n = 0; return () => `id-${++n}`; };

// proximo() devolve { promessa, cancelar }; a maioria dos testes só quer o comando (ou null).
const proximoCmd = (fila, waitMs) => fila.proximo(waitMs).promessa;

test('enfileirar entrega ao worker pela ordem e proximo devolve null ao fim do wait', async () => {
  const fila = criarFila({ novoId: ids() });
  fila.enfileirar({ tipo: 'estado', ano: 2026, mes: 9 });
  fila.enfileirar({ tipo: 'ler', ano: 2026, mes: 9 });
  assert.deepEqual(await proximoCmd(fila, 10), { id: 'id-1', tipo: 'estado', ano: 2026, mes: 9 });
  assert.deepEqual(await proximoCmd(fila, 10), { id: 'id-2', tipo: 'ler', ano: 2026, mes: 9 });
  assert.equal(await proximoCmd(fila, 10), null);
});

test('um worker à espera recebe o comando assim que ele entra', async () => {
  const fila = criarFila({ novoId: ids() });
  const espera = proximoCmd(fila, 500);
  fila.enfileirar({ tipo: 'estado', ano: 2026, mes: 9 });
  assert.equal((await espera).id, 'id-1');
});

test('publicar resolve quem espera pelo resultado; resultado devolve null ao fim do wait', async () => {
  const fila = criarFila({ novoId: ids() });
  const { id } = fila.enfileirar({ tipo: 'ler', ano: 2026, mes: 9 });
  await proximoCmd(fila, 10);
  assert.equal(await fila.resultado(id, 10), null);
  const espera = fila.resultado(id, 500);
  assert.equal(fila.publicar(id, { ok: true, dados: { linhas: [] } }), true);
  assert.deepEqual(await espera, { ok: true, dados: { linhas: [] } });
  assert.deepEqual(await fila.resultado(id, 10), { ok: true, dados: { linhas: [] } });
});

test('publicar num id desconhecido devolve false e resultado rejeita', async () => {
  const fila = criarFila();
  assert.equal(fila.publicar('nada', { ok: true }), false);
  await assert.rejects(fila.resultado('nada', 10), { code: 'ERR_COMANDO_DESCONHECIDO' });
});

test('propor tem duas fases: previa e final, e bloqueia um segundo propor até ao final', async () => {
  const fila = criarFila({ novoId: ids() });
  const { id } = fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] });
  assert.throws(() => fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] }), (e) => e.code === 'ERR_OCUPADO' && e.id === id);
  fila.enfileirar({ tipo: 'ler', ano: 2026, mes: 9 }); // outros tipos passam
  await proximoCmd(fila, 10);
  fila.publicar(id, { ok: true, dados: { fase: 'previa', previa: {} } });
  assert.deepEqual((await fila.resultado(id, 10, 'previa')).dados.fase, 'previa');
  assert.equal(await fila.resultado(id, 10, 'final'), null);
  fila.publicar(id, { ok: true, dados: { fase: 'final', estado: 'aplicado' } });
  assert.equal((await fila.resultado(id, 10)).dados.estado, 'aplicado');
  assert.doesNotThrow(() => fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] }));
});

test('um propor recusado pelo worker (ok: false) conta como final e liberta quem espera pela previa', async () => {
  const fila = criarFila({ novoId: ids() });
  const { id } = fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] });
  await proximoCmd(fila, 10);
  const previa = fila.resultado(id, 500, 'previa');
  fila.publicar(id, { ok: false, erro: { code: 'ERR_SESSION', message: 'sessão' } });
  assert.equal((await previa).ok, false);
  assert.doesNotThrow(() => fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] }));
});

test('ponteViva depende do último poll e os resultados expiram ao fim do ttl', async () => {
  const r = relogio();
  const fila = criarFila({ agora: r.agora, ttlMs: 1000, ponteVivaMs: 40_000, novoId: ids() });
  assert.equal(fila.ponteViva(), false);
  await proximoCmd(fila, 1);
  assert.equal(fila.ponteViva(), true);
  r.avancar(39_000);
  assert.equal(fila.ponteViva(), true);
  r.avancar(2_000);
  assert.equal(fila.ponteViva(), false);

  const { id } = fila.enfileirar({ tipo: 'ler', ano: 2026, mes: 9 });
  await proximoCmd(fila, 1);
  fila.publicar(id, { ok: true, dados: {} });
  r.avancar(2_000);
  fila.limpar();
  await assert.rejects(fila.resultado(id, 1), { code: 'ERR_COMANDO_DESCONHECIDO' });
});

test('estado resume a fila', async () => {
  const fila = criarFila({ novoId: ids() });
  fila.enfileirar({ tipo: 'ler', ano: 2026, mes: 9 });
  const e = fila.estado();
  assert.equal(e.pendentes, 1);
  assert.equal(e.ponteViva, false);
});

test('cancelar antes de haver comando só tira a espera; um comando entregue a uma espera cancelada volta para pendentes', async () => {
  const fila = criarFila({ novoId: ids() });

  // Ainda sem comando: cancelar() só remove a espera. Um enfileirar() a seguir não lhe chega
  // nada (a fila já não a conhece) — vai para pendentes à espera de outro worker.
  const { promessa: p1, cancelar: cancelar1 } = fila.proximo(500);
  cancelar1();
  fila.enfileirar({ tipo: 'ler', ano: 2026, mes: 9 });
  assert.equal(fila.estado().pendentes, 1);
  assert.equal(await Promise.race([p1, new Promise((r) => setTimeout(() => r('nunca-resolveu'), 20))]), 'nunca-resolveu');

  // Já COM comando entregue: cancelar() (chamado depois de a promise resolver, como faz o
  // serve.js quando o socket já morreu) devolve-o à cabeça de pendentes em vez de o perder.
  const { promessa: p2, cancelar: cancelar2 } = fila.proximo(500);
  const entregue = await p2;
  assert.equal(entregue.tipo, 'ler');
  cancelar2();
  assert.equal(fila.estado().pendentes, 1);
  assert.equal(await proximoCmd(fila, 10), entregue); // outro worker recebe o mesmo comando
});

test('um comando nunca entregue expira ao fim do seu timeoutMs com ERR_EXPIRADO, e liberta o próximo propor', async () => {
  const r = relogio();
  const fila = criarFila({ agora: r.agora, novoId: ids() });
  const { id } = fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] }, { timeoutMs: 1000 });
  assert.throws(() => fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] }), { code: 'ERR_OCUPADO' });

  r.avancar(1_001);
  fila.limpar(); // simula o próximo enfileirar/proximo/resultado a chamar limpar()
  const final = await fila.resultado(id, 10);
  assert.equal(final.ok, false);
  assert.equal(final.erro.code, 'ERR_EXPIRADO');
  // a previa também fica resolvida (com o mesmo final), para quem estava à espera dela:
  assert.equal((await fila.resultado(id, 10, 'previa')).erro.code, 'ERR_EXPIRADO');
  // e o próximo propor já não está bloqueado:
  assert.doesNotThrow(() => fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] }));
});

test('um propor entregue sem previa em 120s expira e liberta o próximo propor', async () => {
  const r = relogio();
  const fila = criarFila({ agora: r.agora, novoId: ids() });
  const { id } = fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] });
  await proximoCmd(fila, 10); // entregue ao worker, mas nunca chega a previa
  assert.throws(() => fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] }), { code: 'ERR_OCUPADO' });

  r.avancar(120_001);
  fila.limpar();
  const previa = await fila.resultado(id, 10, 'previa');
  assert.equal(previa.ok, false);
  assert.equal(previa.erro.code, 'ERR_EXPIRADO');
  assert.doesNotThrow(() => fila.enfileirar({ tipo: 'propor', ano: 2026, mes: 9, linhas: [] }));
});

test('limpar tira de pendentes os ids evictados ou já expirados, evitando o TypeError de proximo()', async () => {
  const r = relogio();
  const fila = criarFila({ agora: r.agora, ttlMs: 1000, novoId: ids() });

  // id-1: fica pendente e o registo é evictado pelo TTL sem nunca ter sido entregue.
  fila.enfileirar({ tipo: 'ler', ano: 2026, mes: 9 });
  r.avancar(2_000);
  fila.limpar(); // evicta id-1 do map `registos`; sem a limpeza de pendentes, ficava lá um id fantasma
  assert.equal(fila.estado().registos, 0);

  // id-2: fica pendente e expira sozinho (timeoutMs curtinho) antes de qualquer worker chegar.
  fila.enfileirar({ tipo: 'ler', ano: 2026, mes: 9 }, { timeoutMs: 5 });
  r.avancar(10);
  fila.limpar();

  // Sem a limpeza de pendentes em limpar(), este proximo() ia dar TypeError ao tentar
  // atualizar `entregueEm` de um registo já removido (id-1) ou já fechado (id-2).
  assert.equal(fila.estado().pendentes, 0);
  assert.equal(await proximoCmd(fila, 10), null);
});
