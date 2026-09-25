import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarContexto } from '../lib/contexto.js';

const CTX = { ano: 2026, mes: 9, diasNoMes: 30, projetos: [{ option_id: 101, nome: 'Alfa', trancado: false }], lidoEm: 'x' };

test('sem contexto não há mês visível', () => {
  const c = criarContexto();
  assert.equal(c.atual(), null);
  assert.equal(c.mesVisivel(), null);
});

test('guardar fixa o mês visível e marca quando foi recebido', () => {
  const c = criarContexto({ agora: () => 42 });
  c.guardar(CTX);
  assert.deepEqual(c.mesVisivel(), { ano: 2026, mes: 9 });
  assert.equal(c.atual().recebidoEm, 42);
  assert.equal(c.atual().projetos.length, 1);
});

test('a última proposta de cada mês fica disponível para o /timesheet', () => {
  const c = criarContexto();
  assert.deepEqual(c.proposta(2026, 9), []);
  c.guardarProposta(2026, 9, [{ option_id: 101, date: '2026-09-02', hours: 0.5 }]);
  c.guardarProposta(2026, 9, [{ option_id: 101, date: '2026-09-03', hours: 1 }]);
  assert.deepEqual(c.proposta(2026, 9), [{ option_id: 101, date: '2026-09-03', hours: 1 }]);
  assert.deepEqual(c.proposta(2026, 8), []);
});
