import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package.json declara os dois binários e só uma dependência', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.bin, { 'suite-timesheet-serve': 'serve.js', 'suite-timesheet-mcp': 'mcp.js' });
  assert.deepEqual(Object.keys(pkg.dependencies), ['@modelcontextprotocol/sdk']);
});

test('o SDK do MCP está instalado e exporta o Server', async () => {
  const mod = await import('@modelcontextprotocol/sdk/server/index.js');
  assert.equal(typeof mod.Server, 'function');
});
