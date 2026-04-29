import assert from "node:assert/strict";
import http2 from "node:http2";
import path from "node:path";
import {Duplex} from "node:stream";
import test from "node:test";
import {fileURLToPath} from "node:url";

import pty from "node-pty";

import {BootstrapDecoder, encodeBootstrap} from "../../HTTY.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const fixtures = path.join(root, "fixtures/pty");
const PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
const GOAWAY_NO_ERROR = Buffer.from([
	0x00, 0x00, 0x08,
	0x07,
	0x00,
	0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00,
]).toString("latin1");

function fixturePath(name) {
	return path.join(fixtures, name);
}

function spawnFixture(name) {
	const child = pty.spawn(process.execPath, [fixturePath(name)], {
		cwd: root,
		encoding: null,
		cols: 80,
		rows: 24,
	});
	
	return child;
}

function waitFor(child, predicate, timeout = 3000) {
	let buffer = "";
	
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			disposable.dispose();
			reject(new Error(`timed out waiting for PTY output: ${buffer}`));
		}, timeout);
		
		const disposable = child.onData((data) => {
			buffer += Buffer.from(data).toString("latin1");
			
			const result = predicate(buffer);
			if (result) {
				clearTimeout(timer);
				disposable.dispose();
				resolve(result);
			}
		});
	});
}

function waitForExit(child, timeout = 3000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			disposable.dispose();
			reject(new Error("timed out waiting for PTY exit"));
		}, timeout);
		
		const disposable = child.onExit((event) => {
			clearTimeout(timer);
			disposable.dispose();
			resolve(event);
		});
	});
}

class PTYTransport extends Duplex {
	constructor(child) {
		super();
		this.child = child;
		this.disposable = child.onData((data) => {
			this.push(Buffer.from(data));
		});
		child.onExit(() => {
			this.disposable.dispose();
			this.push(null);
		});
	}
	
	_read() {
	}
	
	_write(chunk, _encoding, callback) {
		this.child.write(chunk);
		callback();
	}
	
	_destroy(error, callback) {
		this.disposable?.dispose();
		callback(error);
	}
}

async function withFixture(name, callback) {
	const child = spawnFixture(name);
	
	try {
		return await callback(child);
	} finally {
		child.kill();
	}
}

test("PTY ignores terminal noise before the bootstrap", async () => {
	await withFixture("bootstrap.mjs", async (child) => {
		const result = await waitFor(child, (buffer) => {
			const decoder = new BootstrapDecoder();
			const decoded = decoder.push(buffer);
			return decoded.bootstraps.length > 0 && decoded.afterBootstrap.includes("RAW") ? decoded : null;
		});
		
		assert.equal(result.beforeBootstrap, "ignored output\u001bP+reset:test-token\u001b\\");
		assert.equal(result.afterBootstrap, "RAW");
		assert.deepEqual(result.bootstraps, [{mode: "raw"}]);
	});
});

test("PTY delivers the HTTP/2 connection preface after raw takeover", async () => {
	await withFixture("raw-preface.mjs", async (child) => {
		await waitFor(child, (buffer) => buffer.includes(encodeBootstrap()));
		
		child.write(PREFACE);
		
		const output = await waitFor(child, (buffer) => buffer.includes("PREFACE_OK") ? buffer : null);
		assert.match(output, /PREFACE_OK/);
	});
});

test("PTY treats command exit after bootstrap without GOAWAY as an abort", async () => {
	await withFixture("abort-after-bootstrap.mjs", async (child) => {
		const output = await waitFor(child, (buffer) => buffer.includes(encodeBootstrap()) ? buffer : null);
		assert.equal(output, encodeBootstrap());
		
		const {exitCode} = await waitForExit(child);
		assert.equal(exitCode, 0);
	});
});

test("PTY preserves command-side GOAWAY bytes after bootstrap", async () => {
	await withFixture("goaway.mjs", async (child) => {
		const output = await waitFor(child, (buffer) => {
			if (!buffer.includes(encodeBootstrap()) || !buffer.includes(GOAWAY_NO_ERROR)) return null;
			
			const decoder = new BootstrapDecoder();
			const decoded = decoder.push(buffer);
			return decoded.bootstraps.length > 0 ? decoded : null;
		});
		
		assert.deepEqual(output.bootstraps, [{mode: "raw"}]);
		assert.equal(output.afterBootstrap, GOAWAY_NO_ERROR);
	});
});

test("PTY runs an HTTP/2 session until command-side GOAWAY", async () => {
	await withFixture("http2-server.mjs", async (child) => {
		const decoder = new BootstrapDecoder();
		
		const output = await waitFor(child, (buffer) => {
			const decoded = decoder.push(buffer);
			return decoded.bootstraps.length > 0 ? decoded : null;
		});
		
		assert.deepEqual(output.bootstraps, [{mode: "raw"}]);
		
		const transport = new PTYTransport(child);
		if (output.afterBootstrap) {
			transport.push(Buffer.from(output.afterBootstrap, "latin1"));
		}
		
		const client = http2.connect("http://htty.local", {
			createConnection: () => transport,
		});
		
		client.on("error", () => {});
		
		const response = await new Promise((resolve, reject) => {
			const request = client.request({
				":method": "GET",
				":path": "/",
			});
			
			let status;
			let body = "";
			
			request.setEncoding("utf8");
			request.on("response", (headers) => {
				status = headers[":status"];
			});
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => resolve({status, body}));
			request.on("error", reject);
			request.end();
		});
		
		assert.equal(response.status, 200);
		assert.equal(response.body, "OK");
		
		client.close();
	});
});
