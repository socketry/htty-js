# @socketry/htty

JavaScript HTTY transport, client, and server primitives.

This package is the primary HTTY implementation used by Chimera for its default demo sessions and end-to-end coverage.

## Installation

```bash
npm install @socketry/htty
```

## Usage

HTTY v1 starts with a single DCS bootstrap:

```text
ESC P + H raw ESC \
```

After that bootstrap has been consumed, the session carries plain `h2c` bytes over the raw transport.

High-level `open` helpers expect an HTTY-capable environment advertised with `HTTY=1` or another positive version. If `HTTY` is absent, they print a message directing users to [https://htty.dev](https://htty.dev); if `HTTY=0`, they raise a disabled-environment error.

### Client

```javascript
import {Client, encodeBootstrap} from "@socketry/htty";

let bootstrapped = false;

const client = new Client((chunk) => {
	if (!bootstrapped) {
		process.stdout.write(encodeBootstrap());
		bootstrapped = true;
	}

	process.stdout.write(chunk);
});

client.on("state", (state) => {
	console.log(state);
});
```

When running in raw mode, the client becomes `attached` once the HTTP/2 connection is established and reports `phase: "ready"` once remote settings arrive.

### Server

```javascript
import {Server} from "@socketry/htty";

Server.open((stream, headers) => {
	stream.respond({
		":status": 200,
		"content-type": "text/plain; charset=utf-8",
	});

	stream.end(`Hello from ${headers[":path"]}`);
});
```

In raw mode, the server emits the bootstrap before starting the HTTP/2 handshake.

### Application Adapter

```javascript
import {Application} from "@socketry/htty";

Application.open(({method, path}) => ({
	status: 200,
	headers: {"content-type": "text/plain; charset=utf-8"},
	body: `${method} ${path}`,
}));
```

## Scope

- HTTY bootstrap encoding and decoding.
- Raw HTTP/2 byte transport after takeover.
- HTTP/2 client session over HTTY.
- Bare HTTP/2 stream + header adapter over HTTY using Node's `http2.performServerHandshake`.
- Optional `Application` adapter for a higher-level request/response shape.

HTTY itself stays intentionally small. The v1 transport is a DCS bootstrap followed by raw `h2c` bytes; HTTP/2 owns connection setup, stream lifecycle, and graceful shutdown.

## Examples

- `examples/hello-world.mjs`
- `examples/browser-demo.mjs`
- `examples/raw-browser-demo.mjs`

## Chimera Integration

In this workspace, Chimera consumes `@socketry/htty` through a local file dependency and launches the example servers from this package by default.
