# MCP connections

`/connections` opens connection management. Select a connection to test it, inspect
tools, edit its definition, enable/disable it, sign in/out or remove it. Add/Edit
places an editable definition in the composer; submitting saves it without
starting a server. The existing menu navigation, including Vim navigation, applies.

Definitions are global or directory-project scoped. A project definition with the
same name overrides the global one, including when disabled. Sibling conversations
in that directory share project definitions. Definitions use SQLite; OAuth tokens
and registrations live only in `.runtime/connection-auth/`, with private file
permissions. Endpoint changes invalidate the credential identity. Environment
settings name local variables; their values never enter the definitions.

```sh
orca connections save global '{"name":"example","transport":"http","enabled":true,"url":"https://example.com/mcp","oauth":true}'
orca connections save project '{"name":"local","transport":"stdio","enabled":true,"command":"bun","args":["/path/to/server.ts"],"env":["SERVICE_TOKEN"]}' --project orch-example
orca connections list
orca connections test example
orca connections login example
orca connections tools example
orca connections disable example
orca connections logout example
orca connections remove example
```

HTTP supports MCP Streamable HTTP, OAuth discovery/registration/PKCE/token refresh
through the official TypeScript SDK, or a bearer token from `tokenEnv`. OAuth login
prints a browser URL and accepts only a matching state on a temporary loopback
callback; it expires after three minutes. Servers requiring a pre-registered OAuth
client rather than dynamic registration are not configured in this first UI.
Local stdio connections use executable/argument arrays, never a shell. Only the
SDK's basic environment and explicitly named local variables are inherited. Remote
URLs use HTTPS; HTTP is supported on loopback for development. Credentials do not
belong in URL userinfo, query strings or executable arguments.

The agent sees one `mcp` gateway: connections, tools, schema, call, resources,
read_resource, prompts and get_prompt. Names are scoped by server. Tool schemas
load only when requested, so installing a server does not inflate every request's
prompt. Catalogs are paginated. Image tool results enter Orca's scoped image store;
other results use the normal tool-result handling. Server descriptions and results
remain external data, not instructions or additional authorization.

Clients connect on demand, reuse a connection within an agent process and close
after 30 idle seconds. The default operation timeout is 60 seconds and can be set
per definition with `timeoutMs` (1–600 seconds). Cancellation closes the connection;
the SDK terminates an owned local server. Closing a remote connection does not
stop the remote service. Failed calls are never automatically replayed because
they may already have had effects. Disabling a definition prevents subsequent
calls; it does not roll back an in-flight operation in another agent process.

No credential, connection session, process ID or active status is portable. The
database-sync PR can transfer definitions as configuration; each receiving device
must have its own executable/environment and sign in separately. Tracing is a
separate change; existing tool timing continues to cover the gateway.
