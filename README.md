# suite-timesheet-mcp

Servidor MCP que deixa um assistente (Claude, GitHub Copilot, ou outro cliente MCP) **ler e
propor horas** na Folha de Horas do Suite, através da extensão **Suite Timesheet Importer**.

- **Nunca fala com o Suite.** Quem lê e escreve é a extensão, no teu browser, com a tua sessão.
- **Nunca escreve sem ti.** Cada lançamento é uma proposta; só é escrito quando clicas Aplicar
  no painel ou aprovas a tool `aplicar` no teu cliente MCP.
- **Nunca submete meses** nem muda o mês aberto na página.
- **Só local.** Escuta apenas em `127.0.0.1`, guarda tudo em memória, não tem telemetria.

Detalhes e forma de verificar cada afirmação: [SECURITY.md](SECURITY.md).

## Requisitos

- Node.js ≥ 20 (`node -v`).
- Chrome ou Edge com a extensão Suite Timesheet Importer instalada.
- A Folha de Horas do Suite aberta, com sessão válida.

## Instalação

### 1. Ligar a ponte na extensão

Nas **Opções** da extensão, liga **Ligação ao servidor local (ponte MCP)**, clica em
**Guardar** e aceita a permissão para `http://127.0.0.1/*`. Depois recarrega a Folha de Horas.

Este passo é manual e feito uma vez: sem ele a extensão nunca toca na rede local.

### 2. Registar o servidor no teu cliente MCP

Não é preciso clonar nada: o `npx` descarrega e corre a versão indicada. A primeira execução
demora alguns segundos (instala a dependência); as seguintes usam a cache.

**Claude Code**

```bash
claude mcp add --scope user suite-timesheet -- npx -y github:williansaez/suite-timesheet-mcp#v1.0.0
```

**GitHub Copilot (VS Code)**

```bash
code --add-mcp '{"name":"suite-timesheet","command":"npx","args":["-y","github:williansaez/suite-timesheet-mcp#v1.0.0"]}'
```

Depois recarrega a janela; as tools aparecem no modo **Agent** do Copilot.

**Claude Desktop (inclui Cowork)**

Em Definições → Programador → Editar configuração
(`~/Library/Application Support/Claude/claude_desktop_config.json` no macOS,
`%APPDATA%\Claude\claude_desktop_config.json` no Windows):

```json
{
  "mcpServers": {
    "suite-timesheet": {
      "command": "npx",
      "args": ["-y", "github:williansaez/suite-timesheet-mcp#v1.0.0"]
    }
  }
}
```

Reinicia o Claude Desktop.

**Outros clientes**

O mesmo comando: `npx -y github:williansaez/suite-timesheet-mcp#v1.0.0`, por stdio. Atenção à
chave do ficheiro de configuração: o VS Code usa `servers`, a maioria dos outros usa
`mcpServers`.

> Se o cliente não encontrar o `npx` (comum em apps abertas pelo Dock, que não herdam o PATH
> do terminal), usa o caminho absoluto dado por `which npx`. No Windows, usa
> `"command": "cmd"` com `"args": ["/c", "npx", "-y", "…"]`.

### 3. Verificar

Pede ao assistente: *"consulta o estado da ponte do Suite Timesheet"*. A tool `estado` deve
responder com a ponte ligada e o mês visível na página. As Opções da extensão passam a mostrar
"Claude ligado há N s" (o texto é o mesmo para qualquer cliente).

## Instalação feita por um agente

Se estás a pedir a um agente para instalar isto, ele deve seguir esta ordem e parar no primeiro
passo que falhe:

1. Confirmar `node -v` ≥ 20.
2. Correr o comando do passo 2 correspondente ao cliente em uso.
3. Pedir ao utilizador para fazer o passo 1 (Opções da extensão). O agente não o consegue fazer.
4. Pedir ao utilizador para recarregar o cliente MCP, se o cliente o exigir.
5. Chamar a tool `estado`. Sucesso = ponte ligada e mês visível. Qualquer `ERR_*`: ver
   [Erros](#erros).

O agente **não** deve pôr a tool `aplicar` em aprovação automática.

## Usar

Exemplos de pedidos:

- *"Quantas horas tenho lançadas este mês no Suite?"* → `ler_mes`
- *"Que projetos tenho disponíveis?"* → `projetos`
- *"Lança 8 h no projeto X de segunda a sexta desta semana."* → `propor`, depois `aplicar`

Lançar horas tem sempre duas fases:

1. **`propor`** calcula o plano, abre o painel da extensão com a pré-visualização e devolve-a ao
   assistente. Nada é escrito.
2. **Confirmação**, de uma de duas formas:
   - clicas **Aplicar** no painel, ou
   - dizes OK no chat e aprovas a chamada da tool **`aplicar`** no cliente MCP.

Por isso: **mantém a aprovação manual da tool `aplicar`**. Com ela em aprovação automática,
qualquer proposta é escrita sem mais nenhuma confirmação. Linhas trancadas e propostas
bloqueadas são sempre recusadas pela extensão.

## Tools

| tool | faz |
|---|---|
| `estado` | ponte ligada?, mês visível, nº de projetos, lote a correr |
| `projetos` | projetos do dropdown da página: `option_id`, nome, trancado |
| `ler_mes` | horas já lançadas no mês visível |
| `propor` | calcula o plano, abre o painel, devolve a pré-visualização e um `id` |
| `aplicar` | escreve a proposta `id` no Suite através da extensão |
| `resultado` | espera pela decisão (painel ou `aplicar`): aplicado, cancelado, erro ou pendente |

## Erros

| erro | o que fazer |
|---|---|
| `ERR_SERVE_EM_BAIXO` | o serviço local não responde; reinicia o cliente MCP (ele arranca-o sozinho) |
| `ERR_SEM_CHROME` | abre a Folha de Horas e confirma que a ponte está ligada nas Opções |
| `ERR_SEM_CONTEXTO` | recarrega a Folha de Horas (o serviço reiniciou depois de a página carregar) |
| `ERR_MES_DIFERENTE` | muda o mês na página; o MCP nunca o muda por ti |
| `ERR_OCUPADO` | há uma proposta à espera no painel; aplica-a ou cancela-a primeiro |
| `ERR_PROPOSTA_DESCONHECIDA` | o `id` passado a `aplicar` não corresponde a nenhuma proposta pendente |

## Como funciona

```
cliente MCP ──stdio──▶ mcp.js ──HTTP──▶ serve.js ◀──long-poll── extensão ──▶ Suite
                                        127.0.0.1                    │
                                                              painel: Aplicar
```

1. O cliente MCP arranca o `mcp.js`. Se o serviço local (`serve.js`) não estiver a correr, o
   `mcp.js` arranca-o em segundo plano, em `127.0.0.1:18765`.
2. A extensão, com a Folha de Horas aberta, faz long-poll ao serviço e publica o mês visível.
3. Cada tool enfileira um comando; a extensão executa-o no browser e devolve o resultado.

O protocolo entre o serviço e a extensão está em [CONTRACT.md](CONTRACT.md).

## Configuração avançada

Variáveis de ambiente, no bloco `env` da configuração do cliente MCP:

| variável | efeito |
|---|---|
| `SUITE_TIMESHEET_BASE` | outro endereço local, ex. `http://127.0.0.1:18770`; põe o mesmo nas Opções da extensão |
| `SUITE_TIMESHEET_SEM_AUTOARRANQUE=1` | o `mcp.js` não arranca o serviço; corres tu `node serve.js [porta]` |

Com o serviço gerido à mão, arranca-o **antes** de abrir a Folha de Horas, ou recarrega a página
depois: a extensão só publica o contexto quando a página carrega ou muda de mês.

As tools aceitam `timeout_s` até 290 s (útil em `resultado` com lotes grandes). Se o cliente
cortar a chamada antes disso, aumenta o timeout do cliente MCP (no Claude Code, 60 s por defeito).

## Atualizar

Muda a tag no comando (`#v1.0.0` → nova versão) e reinicia o cliente MCP. O serviço local fica a
correr entre sessões; para ele pegar na versão nova, termina-o uma vez
(`lsof -ti tcp:18765 | xargs kill`) e o `mcp.js` arranca o novo.

## Limitações

- Sem autenticação local: qualquer processo do teu utilizador consegue falar com o serviço.
  Páginas web não conseguem. Ver [SECURITY.md](SECURITY.md).
- Tudo em memória: reiniciar o serviço esquece propostas e contexto (recarrega a Folha de Horas).
- Um mês de cada vez: o que está aberto na página.

## Correr a partir de um clone

```bash
git clone https://github.com/williansaez/suite-timesheet-mcp.git
cd suite-timesheet-mcp
npm ci
node --test
```

Para usar a cópia local num cliente, troca o comando `npx …` por
`node /caminho/para/suite-timesheet-mcp/mcp.js`.

## Licença

Código disponível para consulta, **não open source**. Podes instalar e usar o pacote sem
alterações, para uso pessoal ou interno da tua organização. Não é permitido alterá-lo,
redistribuí-lo nem publicar cópias ou forks. Os termos completos (em inglês, com tradução para
português) estão em [LICENSE](LICENSE).
