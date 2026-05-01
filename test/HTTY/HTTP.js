import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import test from "node:test";

import {normalizeRequestHeaders, readRequestBody, sanitizeResponseHeaders} from "../../HTTY/HTTP.js";

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

test("reads request bodies from streams", async () => {
	const stream = new PassThrough();
	const body = readRequestBody(stream);
	
	stream.end("hello");
	
	assert.equal(await body, "hello");
});
