import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import test from "node:test";

import {Client} from "../../HTTY/Client.js";
import {HTTP2_CLIENT_PREFACE, readRequestBody} from "../../HTTY/HTTP.js";
import {Server} from "../../HTTY/Server.js";
import {Transport} from "../../HTTY/Transport.js";
import {DisabledError, UnsupportedError} from "../../HTTY/Error.js";

function connectClientToServer(app) {
	let server;
	const client = new Client((chunk) => {
		server.transport.acceptChunk(chunk);
	});
	server = new Server(app, {
		transport: new Transport((chunk) => {
			client.handleChunk(chunk);
		}),
	});
	
	server.start();
	client.start();
	
	return {client, server};
}

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
	
	const response = await client.requestText({path: "/demo"});
	assert.equal(response.status, 200);
	assert.equal(response.body, "GET /demo");
	assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
});

test("server closes after client-side GOAWAY", async (context) => {
	const {client, server} = connectClientToServer((stream) => {
		stream.respond({":status": 200});
		stream.end("OK");
	});
	
	context.after(() => {
		client.close();
		server.close();
	});
	
	await client.requestText({path: "/close"});
	
	const closed = new Promise((resolve) => {
		server.session.once("close", resolve);
	});
	
	client.close();
	
	await closed;
	assert.equal(server.session, null);
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
	
	const response = await client.requestText({
		method: "POST",
		path: "/submit",
		body: "name=chimera",
	});
	
	assert.equal(response.status, 200);
	assert.equal(response.body, "POST /submit name=chimera");
});

test("Server.open checks disabled HTTY support", () => {
	assert.throws(
		() => Server.open(() => {}, {env: {HTTY: "0"}}),
		DisabledError,
	);
});

test("treats byte 0x03 as ordinary raw transport data", () => {
	const input = new PassThrough();
	input.isTTY = true;
	const payloads = [];
	const server = Server.open(() => {}, {
		input,
		output: {write() {}},
		raw: false,
		env: {HTTY: "1"},
	});
	server.transport.acceptChunk = (chunk) => {
		payloads.push(Buffer.from(chunk, "latin1"));
	};
	
	input.write(Buffer.concat([
		Buffer.from(HTTP2_CLIENT_PREFACE, "latin1"),
		Buffer.from([0x03]),
	]));
	
	assert.deepEqual(Array.from(payloads[0].subarray(-1)), [0x03]);
	server.close();
});

test("strips terminal control noise before the client preface arrives", () => {
	const input = new PassThrough();
	input.isTTY = true;
	let payload = null;
	const server = Server.open(() => {}, {
		input,
		output: {write() {}},
		raw: false,
		env: {HTTY: "1"},
	});
	server.transport.acceptChunk = (chunk) => {
		payload = Buffer.from(chunk);
	};
	
	input.write("\u001b[I\u001b]11;rgb:0000/0000/0000\u0007prompt>");
	assert.equal(payload, null);
	
	input.write(Buffer.from(HTTP2_CLIENT_PREFACE));
	assert.equal(payload.toString("latin1"), HTTP2_CLIENT_PREFACE);
	server.close();
});

test("preserves binary frame bytes after the client preface", () => {
	const input = new PassThrough();
	input.isTTY = true;
	let payload = null;
	const settingsFrame = Buffer.from([
		0x00, 0x00, 0x00,
		0x04,
		0x00,
		0x00, 0x00, 0x00, 0x00,
	]);
	const server = Server.open(() => {}, {
		input,
		output: {write() {}},
		raw: false,
		env: {HTTY: "1"},
	});
	server.transport.acceptChunk = (chunk) => {
		payload = Buffer.from(chunk);
	};
	
	input.write(Buffer.concat([
		Buffer.from("\u001b[Iprompt>", "latin1"),
		Buffer.from(HTTP2_CLIENT_PREFACE, "latin1"),
		settingsFrame,
	]));
	
	assert.deepEqual(payload, Buffer.concat([
		Buffer.from(HTTP2_CLIENT_PREFACE, "latin1"),
		settingsFrame,
	]));
	server.close();
});

test("Server.open restores writable streams if startup fails after suppression", () => {
	const input = new PassThrough();
	input.isTTY = true;
	const output = {
		write() {
			throw new Error("write failed");
		},
	};
	const stderr = {
		write() {
			return true;
		},
	};
	const originalOutputWrite = output.write;
	const originalStderrWrite = stderr.write;
	
	assert.throws(
		() => Server.open(() => {}, {
			input,
			output,
			stderr,
			raw: false,
			env: {HTTY: "1"},
		}),
		/write failed/,
	);
	
	assert.equal(output.write, originalOutputWrite);
	assert.equal(stderr.write, originalStderrWrite);
});

test("Server.open suppresses ordinary writable streams while running and restores them after close", async () => {
	const input = new PassThrough();
	input.isTTY = true;
	const outputWrites = [];
	const stderrWrites = [];
	const output = {
		write(chunk) {
			outputWrites.push(String(chunk));
			return true;
		},
	};
	const stderr = {
		write(chunk) {
			stderrWrites.push(String(chunk));
			return true;
		},
	};
	
	const server = Server.open(() => {}, {
		input,
		output,
		stderr,
		raw: false,
		env: {HTTY: "1"},
	});
	const bootstrapWrites = outputWrites.length;
	
	output.write("noise");
	stderr.write("log");
	assert.equal(outputWrites.length, bootstrapWrites);
	assert.deepEqual(stderrWrites, []);
	
	server.close();
	await new Promise((resolve) => setImmediate(resolve));
	
	output.write("after");
	stderr.write("after-error");
	assert.equal(outputWrites.at(-1), "after");
	assert.equal(stderrWrites.at(-1), "after-error");
});

test("Server.open rejects non-TTY stdin", () => {
	const input = new PassThrough();

	assert.throws(
		() => Server.open(() => {}, {
			input,
			output: {write() {}},
			raw: false,
			env: {HTTY: "1"},
		}),
		UnsupportedError,
	);
});
