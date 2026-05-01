import assert from "node:assert/strict";
import test from "node:test";
import {PassThrough} from "node:stream";

import {
	Application,
	BootstrapDecoder,
	Client,
	DisabledError,
	decodeBootstrap,
	encodeBootstrap,
	assertSupportedEnvironment,
	HTTY_BOOTSTRAP_IDENTIFIER,
	Server,
	Transport,
	UnsupportedError,
	readRequestBody,
	normalizeRequestHeaders,
	sanitizeResponseHeaders,
	SESSION_STATUS,
} from "../HTTY.js";

function connectClientToServer(app) {
	const serverInput = new PassThrough();
	const clientInput = new PassThrough();
	const decoder = new BootstrapDecoder();
	const client = new Client((chunk) => {
		serverInput.write(chunk);
	});
	const server = new Server(app, {
		input: serverInput,
		output: {
			write(chunk) {
				clientInput.write(chunk);
			},
		},
		raw: false,
	});

	clientInput.on("data", (chunk) => {
		const {afterBootstrap, bootstraps} = decoder.push(chunk);
		if (bootstraps.length > 0) {
			if (afterBootstrap.length > 0) {
				client.handleChunk(Buffer.from(afterBootstrap, "latin1"));
			}
			return;
		}

		client.handleChunk(chunk);
	});

	server.start();
	client.start();

	return {client, server};
}

test("encodes and decodes an HTTY raw bootstrap sequence", () => {
	const encoded = encodeBootstrap();

	assert.equal(encoded, "\u001bP+Hraw\u001b\\");
	assert.deepEqual(HTTY_BOOTSTRAP_IDENTIFIER, {intermediates: "+", final: "H"});
	assert.deepEqual(decodeBootstrap(" raw "), {mode: "raw"});
	assert.equal(decodeBootstrap("framed"), null);
});

test("reports raw trailing bytes after the bootstrap boundary", () => {
	const decoder = new BootstrapDecoder();
	const trailingBytes = Buffer.from([0x00, 0xff, 0x41]).toString("latin1");
	const result = decoder.push(`${encodeBootstrap()}${trailingBytes}`);

	assert.equal(result.beforeBootstrap, "");
	assert.equal(result.afterBootstrap, trailingBytes);
	assert.deepEqual(result.bootstraps, [{mode: "raw"}]);
});

test("ignores implementation-specific DCS markers before bootstrap", () => {
	const decoder = new BootstrapDecoder();
	const result = decoder.push("\u001bP+reset:token\u001b\\terminal text\u001bP+Hraw\u001b\\RAW");
	
	assert.equal(result.beforeBootstrap, "\u001bP+reset:token\u001b\\terminal text");
	assert.equal(result.afterBootstrap, "RAW");
	assert.deepEqual(result.bootstraps, [{mode: "raw"}]);
});

test("reports unsupported environment when HTTY is absent", () => {
	const writes = [];
	const stderr = {write: (message) => writes.push(message)};
	
	assert.throws(
		() => assertSupportedEnvironment({}, stderr),
		(error) => error instanceof UnsupportedError && /not supported/.test(error.message),
	);
	assert.match(writes.join(""), /https:\/\/htty\.dev/);
});

test("reports disabled environment when HTTY=0", () => {
	assert.throws(
		() => assertSupportedEnvironment({HTTY: "0"}),
		(error) => error instanceof DisabledError && error instanceof UnsupportedError && /disabled/.test(error.message),
	);
});

test("accepts advertised HTTY environments", () => {
	assert.doesNotThrow(() => assertSupportedEnvironment({HTTY: "1"}));
});

test("writes raw bytes through the duplex transport", async () => {
	const writes = [];
	const duplex = new Transport((chunk) => writes.push(chunk));

	duplex.write(Buffer.from("hello"));
	duplex.end();

	assert.equal(writes.length, 1);
	assert.equal(writes[0].toString("latin1"), "hello");
});

test("reports bootstrap sequences and trailing raw bytes", () => {
	const decoder = new BootstrapDecoder();
	const trailingBytes = Buffer.from([0x00, 0xff, 0x41]).toString("latin1");
	const result = decoder.push(`${encodeBootstrap()}${trailingBytes}`);

	assert.deepEqual(result.bootstraps, [{mode: "raw"}]);
	assert.equal(result.beforeBootstrap, "");
	assert.equal(result.afterBootstrap, trailingBytes);
});

test("normalizes request headers for h2 over HTTY", () => {
	assert.deepEqual(normalizeRequestHeaders({path: "/demo", headers: {"Content-Type": "text/plain"}}), {
		":method": "GET",
		":path": "/demo",
		":scheme": "http",
		":authority": "htty.local",
		"content-type": "text/plain",
	});
});

test("sanitizes pseudo headers from HTTP/2 responses", () => {
	assert.deepEqual(sanitizeResponseHeaders({":status": 200, "content-type": "text/plain", "set-cookie": ["a=1", "b=2"]}), {
		"content-type": "text/plain",
		"set-cookie": "a=1, b=2",
	});
});

test("tracks client session state transitions", async () => {
	const session = new Client(() => {});
	const states = [];

	session.on("state", (state) => states.push(state.status));

	session.start();
	assert.equal(session.status, SESSION_STATUS.NEGOTIATING);

	session.close();
	assert.equal(session.status, SESSION_STATUS.CLOSING);

	// CLOSED is emitted asynchronously when the http/2 session drains.
	// Signal EOF on the transport to simulate the remote side disconnecting.
	session.transport.endRemote();

	await new Promise((resolve) => {
		if (session.status === SESSION_STATUS.CLOSED) { resolve(); return; }
		session.on("state", (s) => { if (s.status === SESSION_STATUS.CLOSED) resolve(); });
	});

	// An in-flight http/2 "connect" event from start() may fire between CLOSING
	// and CLOSED, adding ATTACHED to the state sequence — filter it out since
	// it's an artifact of the async connect racing with an immediate close().
	const significant = states.filter((s) => s !== SESSION_STATUS.ATTACHED);
	assert.deepEqual(significant, [SESSION_STATUS.NEGOTIATING, SESSION_STATUS.CLOSING, SESSION_STATUS.CLOSED]);
});

test("marks raw client sessions as attached once the connection is established", async (context) => {
	const {client, server} = connectClientToServer((stream) => {
		stream.respond({
			":status": 204,
		});
		stream.end();
	});
	const states = [];

	client.on("state", (state) => {
		states.push({status: state.status, phase: state.phase ?? null});
	});

	context.after(() => {
		client.close();
		server.close();
	});

	await client.request({path: "/ready"});

	assert.deepEqual(states.map((state) => state.status), [SESSION_STATUS.ATTACHED, SESSION_STATUS.ATTACHED]);
	assert.deepEqual(states[0], {status: SESSION_STATUS.ATTACHED, phase: "connected"});
	assert.equal(states[1].status, SESSION_STATUS.ATTACHED);
	assert.equal(states[1].phase, "ready");
});

test("serves responses through a JS HTTY server", async (context) => {
	const {client, server} = connectClientToServer((stream, headers) => {
		stream.respond({
			":status": 200,
			"content-type": "text/plain; charset=utf-8",
		});
		stream.end(`${headers[":method"]} ${headers[":path"]}`);
	});

	context.after(() => {
		client.close();
		server.close();
	});

	const response = await client.request({path: "/demo"});
	assert.equal(response.status, 200);
	assert.equal(response.body, "GET /demo");
	assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
});

test("passes the request body through the live HTTP/2 stream", async (context) => {
	const {client, server} = connectClientToServer(async (stream, headers) => {
		const body = await readRequestBody(stream);

		stream.respond({
			":status": 200,
			"content-type": "text/plain; charset=utf-8",
		});
		stream.end(`${headers[":method"]} ${headers[":path"]} ${body}`);
	});

	context.after(() => {
		client.close();
		server.close();
	});

	const response = await client.request({
		method: "POST",
		path: "/submit",
		body: "name=chimera",
	});

	assert.equal(response.status, 200);
	assert.equal(response.body, "POST /submit name=chimera");
});

test("serves responses through Application's higher-level request wrapper", async (context) => {
	const serverInput = new PassThrough();
	const clientInput = new PassThrough();
	const decoder = new BootstrapDecoder();
	const client = new Client((chunk) => {
		serverInput.write(chunk);
	});
	const application = new Application(({method, path}) => ({
		status: 200,
		headers: {"content-type": "text/plain; charset=utf-8"},
		body: `${method} ${path}`,
	}), {
		input: serverInput,
		output: {
			write(chunk) {
				clientInput.write(chunk);
			},
		},
		raw: false,
	});

	clientInput.on("data", (chunk) => {
		const {afterBootstrap, bootstraps} = decoder.push(chunk);
		if (bootstraps.length > 0) {
			if (afterBootstrap.length > 0) {
				client.handleChunk(Buffer.from(afterBootstrap, "latin1"));
			}
			return;
		}

		client.handleChunk(chunk);
	});

	application.start();
	client.start();

	context.after(() => {
		client.close();
		application.close();
	});

	const response = await client.request({path: "/adapter"});
	assert.equal(response.status, 200);
	assert.equal(response.body, "GET /adapter");
});

test("Application.open checks advertised HTTY support", () => {
	assert.throws(
		() => Application.open(() => "unused", {env: {}, stderr: {write() {}}}),
		UnsupportedError,
	);
});

test("Server.open checks disabled HTTY support", () => {
	assert.throws(
		() => Server.open(() => {}, {env: {HTTY: "0"}}),
		DisabledError,
	);
});

test("treats byte 0x03 as ordinary raw transport data", () => {
	let payload = null;
	const server = new Server(() => {}, {
		raw: true,
	});
	server.transport.acceptChunk = (chunk) => {
		payload = Buffer.from(chunk, "latin1");
	};

	server.awaitingClientPreface = false;
	server.handleInputData(Buffer.from([0x03]));

	assert.deepEqual(Array.from(payload), [0x03]);
	server.close();
});

test("strips terminal control noise before the client preface arrives", () => {
	let payload = null;
	const server = new Server(() => {}, {
		raw: true,
	});
	server.transport.acceptChunk = (chunk) => {
		payload = Buffer.from(chunk);
	};

	server.handleInputData("\u001b[I\u001b]11;rgb:0000/0000/0000\u0007prompt>");
	assert.equal(payload, null);

	server.handleInputData(Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"));
	assert.equal(payload.toString("latin1"), "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
	server.close();
});

test("preserves binary frame bytes after the client preface", () => {
	let payload = null;
	const settingsFrame = Buffer.from([
		0x00, 0x00, 0x00,
		0x04,
		0x00,
		0x00, 0x00, 0x00, 0x00,
	]);
	const server = new Server(() => {}, {
		raw: true,
	});
	server.transport.acceptChunk = (chunk) => {
		payload = Buffer.from(chunk);
	};
	
	server.handleInputData(Buffer.concat([
		Buffer.from("\u001b[Iprompt>", "latin1"),
		Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1"),
		settingsFrame,
	]));
	
	assert.deepEqual(payload, Buffer.concat([
		Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1"),
		settingsFrame,
	]));
	server.close();
});