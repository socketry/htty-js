# htty

JavaScript HTTY transport, client, and server primitives.

This package is the primary HTTY implementation used by Chimera for its default demo sessions and end-to-end coverage.

## Installation

```bash
npm install htty
```

## Protocol Shape

HTTY v1 starts with a single DCS bootstrap:

```text
ESC P + H raw ESC \
```

After that bootstrap has been consumed, the session carries plain `h2c` bytes over a byte-preserving HTTY transport. HTTP/2 still owns connection setup, stream lifecycle, request/response semantics, and graceful shutdown.

High-level `open` helpers expect an HTTY-capable environment advertised with `HTTY=1` or another positive version. If `HTTY` is absent, they print a message directing users to [https://htty.dev](https://htty.dev); if `HTTY=0`, they raise a disabled-environment error.

## API Surface

The root module keeps to the core HTTY interface:

```javascript
import {
	Application,
	BootstrapDecoder,
	Client,
	Server,
	Transport,
	decodeBootstrap,
	encodeBootstrap,
} from "htty";
```

Focused submodules are also available:

- `htty/Application`
- `htty/Bootstrap`
- `htty/Client`
- `htty/Error`
- `htty/HTTP`
- `htty/Server`
- `htty/Session`
- `htty/Transport`

`Handoff` is intentionally internal. Terminal integrations should use `Session`, its events, and `isHttyActive()` rather than depending on the handoff state machine directly.

## Usage

### Client

`Client` is the HTTP/2 client endpoint after a terminal has detected the HTTY bootstrap. It wraps Node's `http2.connect()` over an HTTY `Transport`.

The constructor receives a `writeChunk` callback. Every byte written by Node's HTTP/2 client is passed to this callback; terminal integrations should forward those bytes to the command process. Bytes received from the command process after takeover must be fed back with `client.handleChunk(chunk)`.

```javascript
import {Client} from "htty";

const client = new Client((chunk) => {
	// Outbound HTTP/2 bytes: send these to the command process stdin.
	commandProcess.write(chunk);
});

commandProcess.onData((chunk) => {
	// Inbound HTTP/2 bytes: feed bytes from the command process stdout.
	client.handleChunk(chunk);
});

client.on("state", (state) => {
	console.log(state);
});
```

Once connected, use `request()` for a small convenience wrapper around Node's client stream API:

```javascript
const response = await client.request({
	method: "GET",
	path: "/status",
});

console.log(response.status, response.body);
```

`handleChunk()` starts the HTTP/2 client lazily if needed, or you can call `client.start()` explicitly. The client becomes `attached` once the HTTP/2 connection is established and reports `phase: "ready"` once remote settings arrive.

The HTTY bootstrap itself is usually detected outside `Client`, by `BootstrapDecoder` or by the higher-level `Session` wrapper. `Client` only handles the byte stream after takeover.

### Server

Use `Server.open()` for command processes connected to stdio. It checks the HTTY environment, puts TTY input into byte-preserving mode when possible, emits the bootstrap, filters terminal noise before the HTTP/2 client preface, and then starts Node's server-side HTTP/2 session.

```javascript
import {Server} from "htty";

Server.open((stream, headers) => {
	stream.respond({
		":status": 200,
		"content-type": "text/plain; charset=utf-8",
	});

	stream.end(`Hello from ${headers[":path"]}`);
});
```

Use `new Server(app, {transport})` when you already have a byte-preserving transport:

```javascript
import {Server, Transport} from "htty";

const transport = new Transport((chunk) => {
	remote.write(chunk);
});

remote.on("data", (chunk) => {
	transport.acceptChunk(chunk);
});

const server = new Server((stream) => {
	stream.respond({":status": 200});
	stream.end("OK");
}, {transport});

server.start();
```

### Application Adapter

`Application` is a convenience wrapper for typical request/response apps. It is not a separate protocol layer.

```javascript
import {Application} from "htty";

Application.open(({method, path}) => ({
	status: 200,
	headers: {"content-type": "text/plain; charset=utf-8"},
	body: `${method} ${path}`,
}));
```

### HTTP Helpers

Request/response helpers live under the `HTTP` submodule rather than the root export:

```javascript
import {
	normalizeRequestHeaders,
	readRequestBody,
	sanitizeResponseHeaders,
} from "htty/HTTP";
```

These are useful for application adapters and tests, but the core API remains the raw HTTP/2 interface exposed by Node.

### Terminal Session Integration

`Session` is for terminal-emulator integrations such as [Chimera](https://github.com/socketry/chimera). It wraps a process handle, watches terminal output for the HTTY bootstrap, and routes bytes between terminal mode and the HTTP/2 client.

```javascript
import {Session} from "htty/Session";

const session = new Session(processHandle, {
	id: "terminal-1",
	command: "node",
	args: ["examples/browser-demo.mjs"],
});

session.on("terminal-data", (text) => terminal.write(text));
session.on("attached", () => requestInitialResource(session.client));
session.on("detached", () => showTerminalAgain());
```

The process handle is expected to expose PTY-style callbacks and methods: `onData(callback)`, `onExit(callback)`, `write(data)`, `resize(cols, rows)`, and `kill()`.

## Scope

- HTTY bootstrap encoding and decoding.
- Byte-preserving HTTP/2 transport after takeover.
- HTTP/2 client session over HTTY.
- Bare HTTP/2 stream + header adapter over HTTY using Node's `http2.performServerHandshake`.
- Optional `Application` adapter for a higher-level request/response shape.

HTTY itself stays intentionally small. The v1 transport is a DCS bootstrap followed by `h2c` bytes over a byte-preserving channel; HTTP/2 owns connection setup, stream lifecycle, and graceful shutdown.

## Examples

- `examples/hello-world.mjs`
- `examples/browser-demo.mjs`
- `examples/styled-browser-demo.mjs`

## Chimera Integration

In this workspace, Chimera consumes this package through a local file dependency and launches the example servers from this package by default.
