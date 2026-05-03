import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import test from "node:test";

import {Application} from "../../HTTY/Application.js";
import {BootstrapDecoder} from "../../HTTY/Bootstrap.js";
import {Client} from "../../HTTY/Client.js";
import {UnsupportedError} from "../../HTTY/Error.js";

test("serves responses through Application's higher-level request wrapper", async (context) => {
	const serverInput = new PassThrough();
	serverInput.isTTY = true;
	const clientInput = new PassThrough();
	const decoder = new BootstrapDecoder();
	const client = new Client((chunk) => {
		serverInput.write(chunk);
	});
	const application = Application.open(({method, path}) => ({
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
		env: {HTTY: "1"},
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
	
	client.start();
	
	context.after(() => {
		client.close();
		application.close();
	});
	
	const response = await client.requestText({path: "/adapter"});
	assert.equal(response.status, 200);
	assert.equal(response.body, "GET /adapter");
});

test("serves streamed responses through Application's higher-level request wrapper", async (context) => {
	const serverInput = new PassThrough();
	serverInput.isTTY = true;
	const clientInput = new PassThrough();
	const decoder = new BootstrapDecoder();
	const client = new Client((chunk) => {
		serverInput.write(chunk);
	});
	const application = Application.open(() => {
		const body = new PassThrough();
		queueMicrotask(() => {
			body.write("hello");
			body.end(" world");
		});
		return {
			status: 200,
			headers: {"content-type": "text/plain; charset=utf-8"},
			body,
		};
	}, {
		input: serverInput,
		output: {
			write(chunk) {
				clientInput.write(chunk);
			},
		},
		raw: false,
		env: {HTTY: "1"},
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

	client.start();

	context.after(() => {
		client.close();
		application.close();
	});

	const response = await client.requestText({path: "/stream"});
	assert.equal(response.status, 200);
	assert.equal(response.body, "hello world");
});

test("Application.open checks advertised HTTY support", () => {
	assert.throws(
		() => Application.open(() => "unused", {env: {}, stderr: {write() {}}}),
		UnsupportedError,
	);
});
