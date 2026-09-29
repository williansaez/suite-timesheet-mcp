import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarProposta } from '../lib/validar.js';

const ok = { linhas: [{ option_id: 101, date: '2026-09-02', hours: 0.5 }] };

test('aceita uma proposta válida e normaliza espelho e nome', () => {
  assert.deepEqual(validarProposta(ok), {
    linhas: [{ option_id: 101, project: '', date: '2026-09-02', hours: 0.5 }],
    modo: 'normal',
    espelho: false,
    nome: 'proposta do Claude',
  });
  assert.deepEqual(validarProposta({ ...ok, espelho: true, nome: '  sprint 12 ' }).nome, 'sprint 12');
  assert.equal(validarProposta({ linhas: [{ project: 'Alfa', date: '2026-09-02', hours: 8 }] }).linhas[0].project, 'Alfa');
});

test('recusa sem linhas, exceto em espelho (limpar o mês)', () => {
  assert.throws(() => validarProposta({ linhas: [] }), { code: 'ERR_PROPOSTA' });
  assert.throws(() => validarProposta({}), { code: 'ERR_PROPOSTA' });
  assert.deepEqual(validarProposta({ linhas: [], espelho: true }).linhas, []);
});

test('lista todos os problemas, com o número da linha', () => {
  const erro = (() => {
    try {
      validarProposta({
        linhas: [
          { date: '2026-09-02', hours: 1 },
          { option_id: 101, project: 'Alfa', date: '2026-09-02', hours: 1 },
          { option_id: 101, date: '02/09/2026', hours: 1 },
          { option_id: 101, date: '2026-09-31', hours: 1 },
          { option_id: 101, date: '2026-09-02', hours: 0.25 },
          { option_id: 101, date: '2026-09-02', hours: 24 },
          { option_id: 101, date: '2026-09-02', hours: 0 },
          { option_id: 'abc', date: '2026-09-02', hours: 1 },
        ],
      });
    } catch (e) { return e; }
    return null;
  })();
  assert.equal(erro.code, 'ERR_PROPOSTA');
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.match(erro.message, new RegExp(`linha ${n}:`));
  assert.match(erro.message, /passo de 0,5/);
});

test('com o mês visível recusa datas fora dele', () => {
  assert.throws(
    () => validarProposta({ linhas: [{ option_id: 101, date: '2026-08-30', hours: 1 }] }, { ano: 2026, mes: 9 }),
    /fora do mês visível 2026-09/,
  );
  assert.doesNotThrow(() => validarProposta(ok, { ano: 2026, mes: 9 }));
});

test('comment é opcional: passa aparado quando vem, fica de fora quando vazio', () => {
  const [com] = validarProposta({ linhas: [{ option_id: 101, date: '2026-09-02', hours: 1, comment: '  Arranque ' }] }).linhas;
  assert.equal(com.comment, 'Arranque');
  const [vazio] = validarProposta({ linhas: [{ option_id: 101, date: '2026-09-02', hours: 1, comment: '  ' }] }).linhas;
  assert.equal('comment' in vazio, false);
});

test('comment que não é texto é recusado com o número da linha', () => {
  assert.throws(
    () => validarProposta({ linhas: [{ option_id: 101, date: '2026-09-02', hours: 1, comment: 42 }] }),
    (e) => e.code === 'ERR_PROPOSTA' && /linha 1: comment tem de ser texto/.test(e.message),
  );
});

test('comment com "<" seguido de letra ou "&#" é recusado (o Suite ignora-o em silêncio)', () => {
  for (const texto of ['<b>x</b>', 'a <!x', '&#65;']) {
    assert.throws(
      () => validarProposta({ linhas: [{ option_id: 101, date: '2026-09-02', hours: 1, comment: texto }] }),
      (e) => e.code === 'ERR_PROPOSTA' && /linha 1: comment/.test(e.message),
      texto,
    );
  }
  assert.doesNotThrow(() => validarProposta({ linhas: [{ option_id: 101, date: '2026-09-02', hours: 1, comment: 'a < b & c; "ok"' }] }));
});

test('modo: normal por defeito, somar/sobregravar aceites, espelho: true vale como sobregravar', () => {
  assert.equal(validarProposta(ok).modo, 'normal');
  assert.equal(validarProposta({ ...ok, modo: 'somar' }).modo, 'somar');
  const sob = validarProposta({ ...ok, modo: 'sobregravar' });
  assert.deepEqual([sob.modo, sob.espelho], ['sobregravar', true]);
  assert.deepEqual([validarProposta({ ...ok, espelho: true }).modo], ['sobregravar']);
  assert.throws(() => validarProposta({ ...ok, modo: 'apagar' }), { code: 'ERR_PROPOSTA' });
});

test('somar aceita horas negativas (múltiplos de 0,5, não 0); os outros modos não', () => {
  const neg = { linhas: [{ option_id: 101, date: '2026-09-02', hours: -1.5 }] };
  assert.equal(validarProposta({ ...neg, modo: 'somar' }).linhas[0].hours, -1.5);
  assert.throws(() => validarProposta(neg), { code: 'ERR_PROPOSTA' });
  assert.throws(() => validarProposta({ linhas: [{ option_id: 101, date: '2026-09-02', hours: 0 }], modo: 'somar' }), { code: 'ERR_PROPOSTA' });
});

test('sem linhas só em sobregravar (limpar o mês)', () => {
  assert.deepEqual(validarProposta({ linhas: [], modo: 'sobregravar' }).linhas, []);
  assert.throws(() => validarProposta({ linhas: [], modo: 'somar' }), { code: 'ERR_PROPOSTA' });
});
