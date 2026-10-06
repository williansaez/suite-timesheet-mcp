import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { FERRAMENTAS } from '../lib/ferramentas.js';

// O site (docs/index.html) é escrito à mão: estes testes impedem que fique para trás do código.
const raiz = new URL('../docs/', import.meta.url);
const html = await readFile(new URL('index.html', raiz), 'utf8');

test('a versão do site é a do package.json', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const marcas = [...html.matchAll(/data-version="([^"]+)"[^>]*>([^<]*)</g)];
  assert.ok(marcas.length > 0, 'falta data-version no site');
  for (const [, versao, texto] of marcas) {
    assert.equal(versao, pkg.version);
    assert.match(texto, new RegExp(`^v?${pkg.version.replaceAll('.', '\\.')}$`));
  }
});

test('o site lista exatamente as tools do servidor', () => {
  const noSite = [...html.matchAll(/data-tool="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(noSite).size, noSite.length, 'tool repetida no site');
  assert.deepEqual(noSite.toSorted(), FERRAMENTAS.map((f) => f.name).toSorted());
});

test('a contagem de tools no site é a do servidor', () => {
  const contagens = [...html.matchAll(/data-tool-count[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.ok(contagens.length > 0, 'falta data-tool-count no site');
  for (const c of contagens) assert.equal(Number(c), FERRAMENTAS.length);
});

test('os caminhos locais são relativos e existem', async () => {
  const caminhos = [...html.matchAll(/\b(?:src|href|poster)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => !/^(https?:|#|mailto:|data:)/.test(p));
  assert.ok(caminhos.length > 0);
  for (const p of caminhos) {
    assert.ok(!p.startsWith('/'), `caminho absoluto parte no Pages: ${p}`);
    await access(new URL(p, raiz)).catch(() => assert.fail(`não existe: docs/${p}`));
  }
});

test('sem JS, os separadores de instalação ficam todos visíveis', () => {
  const paineis = [...html.matchAll(/<[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0]);
  assert.ok(paineis.length >= 4, 'faltam os painéis de instalação');
  for (const p of paineis) assert.ok(!/\shidden\b/.test(p), `painel escondido no HTML: ${p}`);
});
