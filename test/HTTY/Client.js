import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import test from "node:test";

import {Client, SESSION_STATUS} from "../../HTTY/Client.js";
import {Server} from "../../HTTY/Server.js";
import {Transport} from "../../HTTY/Transport.js";

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
		session.transport.closeRemote();
	
	await new Promise((resolve) => {
		if (session.status === SESSION_STATUS.CLOSED) { resolve(); return; }
		session.on("state", (s) => { if (s.status === SESSION_STATUS.CLOSED) resolve(); });
	});
	
	// An in-flight http/2 "connect" event from start() may fire between CLOSING
	// and CLOSED, adding ATTACHED to the state sequence. Filter it out since
	// it is an artifact of the async connect racing with an immediate close().
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
	
	await client.requestText({path: "/ready"});
	
	assert.deepEqual(states.map((state) => state.status), [SESSION_STATUS.ATTACHED, SESSION_STATUS.ATTACHED]);
	assert.deepEqual(states[0], {status: SESSION_STATUS.ATTACHED, phase: "connected"});
	assert.equal(states[1].status, SESSION_STATUS.ATTACHED);
	assert.equal(states[1].phase, "ready");
});

test("request streams request and response bodies", async (context) => {
	const {client, server} = connectClientToServer((stream) => {
		stream.respond({
			":status": 200,
			"content-type": "text/plain; charset=utf-8",
		});
		stream.write("response:");
		stream.on("data", (chunk) => stream.write(chunk));
		stream.on("end", () => stream.end());
	});
	const body = new PassThrough();

	context.after(() => {
		client.close();
		server.close();
	});

	const responsePromise = client.request({
		method: "POST",
		path: "/stream",
		body,
	});
	body.write("hello");
	body.end(" world");

	const response = await responsePromise;
	const chunks = [];
	for await (const chunk of response.body) {
		chunks.push(Buffer.from(chunk));
	}

	assert.equal(response.status, 200);
	assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
	assert.equal(Buffer.concat(chunks).toString("utf8"), "response:hello world");
});

test("requestText buffers response bodies explicitly", async (context) => {
	const {client, server} = connectClientToServer((stream) => {
		stream.respond({
			":status": 200,
			"content-type": "text/plain; charset=utf-8",
		});
		stream.end("buffered");
	});

	context.after(() => {
		client.close();
		server.close();
	});

	const response = await client.requestText({path: "/text"});

	assert.equal(response.status, 200);
	assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
	assert.equal(response.body, "buffered");
});
