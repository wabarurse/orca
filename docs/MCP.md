# MCP servers

Orca can use MCP servers: programs or web services that give agents extra tools
(GitHub, Linear, a browser, your own). You manage them in one file.

## The file: `~/.orca/mcp.json`

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "linear": { "url": "https://mcp.linear.app/mcp" },
    "internal": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${EXAMPLE_TOKEN}" },
      "disabled": true
    }
  }
}
```

Each entry is a name and one of two things:

- **`command`** starts a program on your machine. `args` is its list of
  arguments and `env` its extra environment variables.
- **`url`** reaches a server over HTTP. `headers` are sent with every request.

This is the `mcpServers` shape other MCP clients use, so the snippet in a
server's README can be pasted in as it is.

| To | Do this |
| --- | --- |
| Add a server | Add an entry. |
| Edit one | Change the entry. |
| Turn one off | Add `"disabled": true`. |
| Remove one | Delete the entry. |

The file is read again on every use, so a change applies to the next call.
Nothing needs restarting.

Other settings:

- `"timeout": 120` gives a server's calls 120 seconds instead of 60 (1 to 600).
- `${NAME}` in `args`, `env`, `url` or `headers` is replaced by that environment
  variable, so a token does not have to be written in the file. The variable
  must be set where Orca was started. A literal value works too; then the file
  holds a secret, so keep it private.

A mistake in one entry turns off that entry only, and `orca mcp` says what is
wrong with it. A file that is not valid JSON turns them all off until fixed.

## Commands

```sh
orca mcp                 # list the servers and their state; creates the file if missing
orca mcp test            # connect to each enabled server and count its tools
orca mcp test github     # one server; a failure shows what the server printed
orca mcp login linear    # sign in to a url server in the browser
orca mcp logout linear   # forget that sign-in
```

A `url` server without an `Authorization` header uses OAuth when the server asks
for it. Until you have signed in, using it says `run: orca mcp login <name>`.
Sign-ins are stored privately under `~/.orca/.runtime/mcp-auth/`, never in
`mcp.json`. They belong to the server's name and address, so changing either
means signing in again.

## How agents use them

Every agent has one small `mcp` tool. It lists your servers, searches a server's
tools, fetches one tool's schema and calls it. Server tool schemas are fetched on
demand rather than loaded into every request, so adding servers does not make
every request larger or reset the prompt cache.

A local server is started on first use and keeps running between calls, since
many hold state (a browser, a session). It is stopped after ten minutes without
use, when its entry changes, when the connection fails, or when the agent
process exits. Each agent process has its own connections. A call that fails is
never retried automatically: it may already have had its effect.

## Limits

- One file for every project. There is no per-project or in-repository file.
- The old SSE transport is not supported, only Streamable HTTP.
- No pre-registered OAuth client ID; the server must allow dynamic registration.
- Every agent role can call every tool of every enabled server.
