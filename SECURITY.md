# Segurança

Para quem precisa de decidir se pode correr este pacote numa máquina da empresa. Descreve o que
ele faz, o que nunca faz, e como verificar cada afirmação.

## Em uma frase

Um processo local (`serve.js`) que guarda em memória uma fila de comandos entre o Claude e a
extensão Suite Timesheet Importer, e um servidor MCP por stdio (`mcp.js`) que expõe seis tools ao
Claude. Este pacote **nunca fala com o Suite**: quem lê e escreve no Suite é a extensão, dentro do
browser, com a sessão do utilizador, e só depois de o utilizador clicar Aplicar no painel ou de
aprovar a tool `aplicar` no cliente MCP (ver a tabela abaixo).

## O que nunca faz (verificado pelo CI)

| regra | como é garantida |
|---|---|
| Nunca contacta o Suite nem qualquer host externo | o código não contém nenhum URL além de `127.0.0.1` (guard no CI); o único `listen` é em `127.0.0.1`; o `mcp.js` só chama o `serve` local |
| Nunca escreve no Suite, nem submete meses | não tem sessão, cookies nem endpoints do Suite; o endpoint de submissão não existe no código (guard no CI) |
| Nunca provoca uma escrita sem confirmação humana | a tool `propor` só enfileira; a escrita só acontece com o clique em Aplicar no painel **ou** com a aprovação da tool `aplicar` no cliente MCP (ex.: Claude Code a pedir confirmação antes de correr a tool) — uma das duas é sempre exigida |
| Nunca guarda dados em disco | fila, contexto e propostas vivem em memória; reiniciar o `serve` esquece tudo |
| Nunca aceita pedidos de páginas web | recusa `Origin` que não seja `chrome-extension://`, `Host` que não seja `127.0.0.1`/`localhost`, e POST sem `application/json` |
| Nunca contém dados reais | testes e exemplos só com projetos, ids e horas fictícios (guard de nomes de cliente no CI) |

## Superfície de rede

Só um socket: `127.0.0.1:18765` (porta configurável). Rotas:

- `/bridge/*`: usadas pela extensão (long-poll, contexto da página, resultados).
- `/mcp/*`: usadas pelo `mcp.js` na mesma máquina.
- `/health`, `/timesheet`: contrato antigo do serviço local, só leitura. `/health` devolve a
  identidade do serve (`nome`, `versao`) mais `ultimoMcp` (a hora do último pedido a `/mcp/*`,
  ou `null`) e `ponte`; não expõe nada além disso — nem contexto, nem propostas.

Corpo dos pedidos limitado a 1 MB. Ligações abortadas, URLs malformados e erros internos
respondem com erro e nunca derrubam o processo.

O `mcp.js` pode arrancar o `serve.js` (mesmo pacote, mesmo utilizador, só loopback) quando liga e
não encontra nada a responder em `/health`; nunca arranca nem chama nenhum outro programa
(`SUITE_TIMESHEET_SEM_AUTOARRANQUE=1` desliga isto).

## Dados

Em memória: o mês visível e a lista de projetos que a extensão publica, as propostas enviadas
pelo Claude, e os resultados que a extensão devolve (prévia e resultado final). Resultados expiram
ao fim de 1 h; comandos sem resposta expiram com `ERR_EXPIRADO`. Nada é registado além de uma
linha por comando em `stderr` (tipo e mês, sem horas).

## Dependências

Uma, declarada e fixada em `package-lock.json`: `@modelcontextprotocol/sdk` (só importada por
`mcp.js`). O `serve.js` usa apenas `node:http`. `npm audit` faz parte da verificação abaixo.

## Limitações conhecidas

- **Sem autenticação local.** Qualquer processo a correr com o teu utilizador consegue falar com
  o `serve` (enfileirar um `propor`, ler o contexto). Páginas web não conseguem (ver acima). Um
  `propor` malicioso ainda assim só chega ao Suite se clicares Aplicar no painel ou aprovares a
  chamada da tool `aplicar` no cliente MCP.
- **Sem TLS.** Loopback apenas; nada sai da máquina.
- **Sem persistência.** Um reinício perde a fila; o MCP recebe `ERR_COMANDO_DESCONHECIDO` e repete.

## Como a tua equipa pode verificar

```bash
npm ci
node --test                       # 73 testes, sem rede além de loopback
npm audit --omit=dev              # dependências conhecidas
grep -rnoE "https?://[a-zA-Z0-9.-]+" --include='*.js' --exclude-dir=node_modules --exclude-dir=test .   # esperado: só 127.0.0.1
grep -rniE "submitaction" --include='*.js' . --exclude-dir=node_modules | grep -v '/test/'      # esperado: vazio
grep -rn "listen(" serve.js       # esperado: só 127.0.0.1
```

## Reportar um problema

Encontraste uma forma de este pacote contactar algo fora da máquina, de aceitar pedidos de uma
página web, ou de provocar uma escrita no Suite sem o clique em Aplicar nem a aprovação da tool
`aplicar`? Abre um issue privado
neste repositório com o rótulo `segurança` ou contacta o dono do repositório. Sem cookies, tokens
nem dados reais no relatório.
