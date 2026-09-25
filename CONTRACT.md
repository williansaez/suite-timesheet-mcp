# Contrato

A fonte deste contrato é o `CONTRACT.md` do repo da extensão (`suite-timesheet-importer`). Esta
cópia existe para quem só clona este pacote. Se divergirem, manda o da extensão.

## Ponte (opcional): o serviço manda comandos à extensão

Um serviço que implemente estas três rotas passa a poder pedir leituras e propor lançamentos
à extensão. Quem só quer entregar um ficheiro de horas não precisa delas.

| método | rota | corpo / resposta |
|---|---|---|
| `POST` | `/bridge/contexto` | a extensão envia `{ano, mes, diasNoMes, projetos: [{option_id, nome, trancado}], lidoEm}` sempre que a Folha de Horas carrega ou muda de mês |
| `GET` | `/bridge/next?wait=25` | responde `204` sem corpo se não houver comando ao fim de `wait` segundos, ou `200` com um comando |
| `POST` | `/bridge/result/{id}` | a extensão publica o resultado do comando `id` |

Comando: `{"id": "texto", "tipo": "estado" | "projetos" | "ler" | "propor" | "aplicar", "ano": 2026, "mes": 9}`.
`propor` leva ainda `"linhas": [{option_id | project, date, hours}]`, `"espelho": false` e
`"nome": "texto"`. O mês tem de ser o que a página mostra; caso contrário a resposta é
`ERR_MES_DIFERENTE` e nada é lido nem escrito.

### `aplicar`: escreve uma proposta pendente sem o clique no painel

`aplicar` leva ainda `"proposta": "id"`, o `id` de um comando `propor` já entregue à extensão e
ainda sem `final` (ou seja, com o painel aberto à espera de decisão). Em vez de esperar que o
utilizador clique Aplicar, o cliente MCP (com a aprovação humana já dada no chat, e a aprovação
da própria chamada da tool) manda escrever essa proposta diretamente.

A extensão trata `aplicar` como um comando novo e independente (com o seu próprio `id`), que
resolve o `propor` referido em `proposta`:

- Escreve linha a linha, tal como faria depois do clique em Aplicar — mesmas validações (linhas
  trancadas recusadas, sessão expirada para tudo), mesmo `report`.
- Responde ao comando `aplicar` com `{"ok": true, "dados": {"estado": "aplicado" | "erro",
  "report"?, "stopped"?, "erro"?}}` (uma só fase, sem `previa`) ou `{"ok": false, "erro":
  {"code", "message"}}`.
- Publica também o `final` do `propor` original (mesmo `{"fase": "final", "estado": ...}` de
  sempre), para quem ainda estiver a chamar `resultado(<id do propor>)` continuar a funcionar.

`ERR_PROPOSTA_DESCONHECIDA`: não há nenhum `propor` pendente com o `id` indicado em `proposta`
(nunca existiu, já teve `final`, ou o `serve`/worker reiniciou e perdeu-o). `aplicar` nunca é
bloqueado por `ERR_OCUPADO` — não é um novo `propor` à espera de painel, é a resolução de um que
já existe.

Resultado: `{"ok": true, "dados": ...}` ou `{"ok": false, "erro": {"code", "message"}}`.
`propor` publica dois resultados com o mesmo `id`: primeiro `{"fase": "previa", "previa": {...}}`
com o plano calculado (o painel abre nesse momento), e depois, quando o utilizador decide,
`{"fase": "final", "estado": "aplicado" | "cancelado" | "erro", ...}`.

A extensão continua a ser a única coisa que escreve no Suite, sempre depois de o utilizador
clicar Aplicar no painel ou de aprovar a tool `aplicar` no cliente MCP (ver secção "aplicar"
abaixo). Nunca submete o mês, nunca muda o mês.

### Prazo de `/bridge/next`

O `serve` tem de responder a `GET /bridge/next?wait=25` dentro de, aproximadamente, 28 segundos
— mesmo sem comando (nesse caso, `204`). O worker pede `wait=25` (e este `serve` recusa um
`wait` maior que 25), mas o Chrome mata um service worker MV3 cujo `fetch` demora mais de 30 s a
resolver; um `serve` que ignore o `wait` ou que demore a responder além desse limite faz o
worker perder o ciclo (e reentrar só ao alarme de 30 s seguinte), mesmo que a resposta acabe por
chegar.

### Formato de `dados` por tipo de comando

Resultado com `"ok": true`, no campo `dados`:

| `tipo` | forma de `dados` |
|---|---|
| `estado` | `{ano, mes, projetos: N, loteEmCurso: boolean}` — `projetos` é a contagem, não a lista |
| `projetos` | `[{option_id, nome, trancado}]` |
| `ler` | `{ano, mes, linhas: [{option_id, nome, status, dias: {D: horas}, total}], totaisPorDia: {D: horas}}` |
| `propor`, fase `previa` | `{fase: 'previa', previa: {matriz, criar, atualizar, apagar, ignoradas, avisos, erros, bloqueio}}` — `criar`/`atualizar`/`apagar` são listas de `{option_id, projeto, dias}`; `bloqueio` é a mensagem em português ou `null` |
| `propor`, fase `final` | `{fase: 'final', estado: 'aplicado' \| 'cancelado' \| 'erro', report?, motivo?, erro?}` — `report` só em `aplicado` (`{results, stopped, reconciliacao, skipped}`), `motivo` só em `cancelado`, `erro` (`{code, message}`) só em `erro` |
| `aplicar` (uma só fase) | `{estado: 'aplicado' \| 'erro', report?, stopped?, erro?}` — sem `fase: 'previa'`; ver secção "aplicar" acima |

### Códigos de erro

`{"ok": false, "erro": {"code", "message"}}`. Códigos que o worker pode devolver:

| código | motivo |
|---|---|
| `ERR_COMANDO` | corpo do comando malformado (id/tipo/ano/mes/linhas inválidos) |
| `ERR_MES_DIFERENTE` | o comando pede um mês diferente do que a página do Suite tem aberto |
| `ERR_SEM_CONTEXTO` | a Folha de Horas do Suite ainda não foi aberta nesta sessão |
| `ERR_SEM_ABA` | não há nenhuma aba do Suite aberta (só em `propor`; sem aba o painel não abre) |
| `ERR_OCUPADO` | já há uma proposta do MCP à espera de confirmação no painel, ou (no APPLY) uma proposta a ser calculada |
| `ERR_LOTE_A_CORRER` | já está um lote a escrever no Suite (Aplicar), ou (no `propor`) já está um propor a ser calculado |
| `ERR_SESSION` | o Suite devolveu HTML de login: a sessão expirou |
| `ERR_MONTH_MISMATCH` | o read do Suite não cobre os projetos visíveis na página |
| `ERR_PROPOSTA_DESCONHECIDA` | `aplicar` referiu, em `proposta`, um `id` sem `propor` pendente (só em `aplicar`) |
| `ERR_DESCONHECIDO` | qualquer outro erro não classificado |

Este `serve` acrescenta o seu próprio `ERR_EXPIRADO` (ver secção seguinte) e usa
`ERR_SEM_CHROME`/`ERR_SEM_CONTEXTO` nas suas próprias rotas `/mcp/*` (ver "Rotas deste serve").

### Um comando sem resposta nunca é respondido

Se o service worker morrer (o Chrome pode matá-lo a qualquer momento fora de um fetch pendente)
depois de o `serve` entregar um comando em `/bridge/next` mas antes de ele publicar o resultado
em `/bridge/result/{id}`, esse comando fica sem resposta — o worker que reentra ao alarme
seguinte não retoma comandos a meio, só pede o próximo.

Este `serve` dá um timeout a cada comando pendente: expira com
`{"ok": false, "erro": {"code": "ERR_EXPIRADO", ...}}` se nunca chega a ser entregue dentro do
`timeout_s` do pedido que o enfileirou (defeito 30 s), ou se é um `propor` entregue mas que não
devolveu a previa em 120 s. Um comando expirado torna-se final, o que também liberta o próximo
`propor` bloqueado.

## CORS

A extensão chama o serviço a partir do service worker com `host_permissions` para
`http://127.0.0.1/*`; **não** é preciso enviar cabeçalhos CORS.

## Rotas deste `serve`

### `/mcp/*` — só o `mcp.js` chama

| método | rota | efeito |
|---|---|---|
| `GET` | `/mcp/estado` | contexto conhecido + `ponte: 'ligada' \| 'sem-chrome'` (ligada = long-poll ativo há menos de 40 s) + `ultimoMcp` (ISO do último pedido a `/mcp/*`, incluindo este) |
| `POST` | `/mcp/comando` | enfileira, espera até `timeout_s` s pelo resultado (defeito 30, máximo 290; `aplicar` tem defeito 120 — escreve linha a linha), devolve `{id, estado, resultado?}` |
| `GET` | `/mcp/comando/{id}?wait=N&fase=previa\|final` | espera pelo resultado de um comando já enfileirado; `fase` (defeito `final`) escolhe entre a pré-visualização ou o estado final de um `propor` |

`ERR_SEM_CHROME`: sem long-poll recente (o worker não está a correr, ou a extensão não tem a
permissão de `http://127.0.0.1/*`). `ERR_SEM_CONTEXTO`: a ponte está viva (o worker continua a
fazer long-poll) mas o `serve` reiniciou depois de a página já ter carregado — falta um novo
`POST /bridge/contexto`, que só volta a chegar quando a Folha de Horas recarregar.

### Contrato antigo (ficheiro/serviço simples, sem MCP)

Estas duas rotas são o mesmo contrato "serviço local" que o `CONTRACT.md` da extensão descreve
para quem não precisa da ponte nem do MCP — só entregar horas por HTTP.

| método | rota | efeito |
|---|---|---|
| `GET` | `/health` | `200 application/json` com `{nome: 'suite-timesheet-serve', versao, ultimoMcp, ponte}`; `ultimoMcp` é o ISO do último pedido a `/mcp/*` (ou `null` se nenhum desde o arranque) e `ponte` é o mesmo valor que `/mcp/estado`. A extensão usa `nome` para confirmar que é este serve (e não outro programa) a responder na porta — um corpo que não seja este JSON conta como "outro programa na porta". |
| `GET` | `/timesheet?year=YYYY&month=M` | `200 application/json` com `{year, month, generated_at, rows}`; `rows` vem da última proposta aceite (por `propor`) para esse mês, ou `[]` |

## O que este `serve` NÃO faz

Não escreve no Suite, não fala com o Suite. Toda a escrita é feita pela extensão, dentro do
browser, com a sessão do utilizador — sempre depois de o utilizador clicar Aplicar no painel ou
de aprovar a tool `aplicar` no cliente MCP.
