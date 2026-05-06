import assert from "node:assert/strict";
import test from "node:test";

import {encodeBootstrap, SESSION_STATUS} from "../../HTTY.js";
import {Handoff} from "../../HTTY/Handoff.js";

const GOAWAY_NO_ERROR_FRAME = Buffer.from([
	0x00, 0x00, 0x08,
	0x07,
	0x00,
	0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00,
]);

function makeHandoff(options = {}) {
	const writes = [];
	const stateEvents = [];
	const resets = [];

	const handoff = new Handoff({
		write: (chunk) => writes.push(chunk),
		onSessionState: (_session, state) => stateEvents.push(state),
		onReset: () => resets.push(true),
		...options,
	});

	return {handoff, writes, stateEvents, resets};
}

test("starts in terminal mode with no active session", () => {
	const {handoff} = makeHandoff();
	assert.equal(handoff.mode, "terminal");
	assert.equal(handoff.isActive, false);
	assert.equal(handoff.session, null);
});

test("classify returns plainText and no rawData before bootstrap", () => {
	const {handoff} = makeHandoff();
	const result = handoff.classify("hello world");
	assert.equal(result.plainText, "hello world");
	assert.equal(result.rawData, "");
	assert.equal(result.activateRaw, false);
});

test("classify detects bootstrap sequence and returns activateRaw", () => {
	const {handoff} = makeHandoff();
	const bootstrap = encodeBootstrap();
	const result = handoff.classify(bootstrap);
	assert.equal(result.activateRaw, true);
	assert.equal(result.plainText, "");
});

test("classify returns terminal text and trailing raw bytes around bootstrap", () => {
	const {handoff} = makeHandoff();
	const trailingBytes = Buffer.from([0x00, 0xff, 0x41]).toString("latin1");
	const result = handoff.classify(`hello${encodeBootstrap()}${trailingBytes}`);
	assert.equal(result.activateRaw, true);
	assert.equal(result.plainText, "hello");
	assert.equal(result.rawData, trailingBytes);
});

test("classify routes all data as rawData once active", () => {
	const {handoff} = makeHandoff();
	handoff.activate();
	const data = Buffer.from([0x50, 0x52, 0x49]);
	const result = handoff.classify(data);
	assert.equal(result.rawData, data);
	assert.equal(result.activateRaw, false);
	assert.equal(result.plainText, "");
});

test("activate switches mode to htty and creates a session", () => {
	const {handoff} = makeHandoff();
	handoff.activate();
	assert.equal(handoff.mode, "htty");
	assert.equal(handoff.isActive, true);
	assert.ok(handoff.session);
});

test("setMode to terminal is blocked while HTTY is active", () => {
	const {handoff} = makeHandoff();
	handoff.activate();
	const result = handoff.setMode("terminal");
	assert.equal(result, "htty");
	assert.equal(handoff.mode, "htty");
});

test("setMode to terminal succeeds when not active", () => {
	const {handoff} = makeHandoff();
	handoff.setMode("htty");
	const result = handoff.setMode("terminal");
	assert.equal(result, "terminal");
	assert.equal(handoff.mode, "terminal");
});

test("interrupt keeps session active until the server's GOAWAY arrives", () => {
	const {handoff} = makeHandoff();
	handoff.activate();
	const session = handoff.session;

	// interrupt() initiates close but does NOT immediately null the session.
	// The session stays live so server bytes keep flowing through the same
	// http/2 client rather than arriving as garbage in the next session.
	handoff.interrupt();
	assert.equal(handoff.isActive, true, "session must remain active after interrupt");
	assert.equal(handoff.session, session, "same session instance during teardown");
});

test("interrupt is idempotent while waiting for server GOAWAY", () => {
	const {handoff, writes} = makeHandoff();
	handoff.activate();
	
	handoff.interrupt();
	handoff.interrupt();
	
	assert.equal(writes.length, 1, "interrupt should write a single manual GOAWAY frame");
	assert.deepEqual(writes[0], GOAWAY_NO_ERROR_FRAME);
});

test("interrupt closes local transport after flush-aware GOAWAY write resolves", async () => {
	const resolvers = [];
	const writes = [];
	const {handoff} = makeHandoff({
		write: (chunk) => {
			writes.push(chunk);
			return new Promise((resolve) => {
				resolvers.push(resolve);
			});
		},
	});
	handoff.activate();
	const session = handoff.session;

	handoff.interrupt();
	assert.equal(writes.length, 1);
	assert.deepEqual(writes[0], GOAWAY_NO_ERROR_FRAME);

	// Before GOAWAY write resolves, local writes are still open.
	session.transport.write(Buffer.from("post-interrupt-write"));
	assert.equal(writes.length, 2);

	// After GOAWAY write resolves, local writes are closed.
	resolvers[0]?.();
	await Promise.resolve();
	session.transport.write(Buffer.from("post-flush-write"));
	assert.equal(writes.length, 2, "local writes should be closed after GOAWAY flush");
});

test("session is nullified immediately when the server's GOAWAY arrives", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();
	const session = handoff.session;

	// Simulate the server sending GOAWAY by emitting the state transition
	// that the http/2 client would emit upon receiving the frame.
	session.emit("state", {status: SESSION_STATUS.CLOSING, phase: "goaway"});

	assert.equal(handoff.isActive, false, "session must be nullified on GOAWAY");
	assert.equal(handoff.session, null);
	assert.equal(handoff.mode, "terminal");
	assert.equal(resets.length, 1);
});

test("reset suppresses teardown writes emitted during client destroy", () => {
	const {handoff, writes, resets} = makeHandoff();
	handoff.activate();
	const session = handoff.session;

	const originalDestroy = session.client.destroy.bind(session.client);
	session.client.destroy = (...args) => {
		// Simulate Node/http2 emitting a final local write during teardown.
		session.transport.write(Buffer.from("teardown-write"));
		return originalDestroy(...args);
	};

	// Simulate server GOAWAY triggering #resetSession.
	session.emit("state", {status: SESSION_STATUS.CLOSING, phase: "goaway"});

	assert.equal(handoff.isActive, false);
	assert.equal(handoff.mode, "terminal");
	assert.equal(resets.length, 1);
	assert.equal(writes.length, 0, "teardown write must be suppressed during reset");
});

test("handleChunk resets on command-side GOAWAY and returns trailing terminal data", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();
	const goaway = Buffer.from([
		0x00, 0x00, 0x08,
		0x07,
		0x00,
		0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x01,
		0x00, 0x00, 0x00, 0x00,
	]);
	
	const result = handoff.handleChunk(Buffer.concat([goaway, Buffer.from("prompt")]));
	
	assert.equal(handoff.isActive, false);
	assert.equal(resets.length, 1);
	assert.deepEqual(result.forwardedData, Buffer.alloc(0));
	assert.equal(result.terminalData.toString("latin1"), "prompt");
});

test("handleChunk only detects GOAWAY at real HTTP/2 frame boundaries", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();
	const data = Buffer.from([
		0x00, 0x00, 0x05,
		0x00,
		0x00,
		0x00, 0x00, 0x00, 0x01,
		0x00, 0x00, 0x08, 0x07, 0x00,
	]);
	
	const result = handoff.handleChunk(data);
	
	assert.equal(handoff.isActive, true);
	assert.equal(resets.length, 0);
	assert.deepEqual(result.forwardedData, data);
	assert.equal(result.terminalData, null);
});

test("handleChunk detects GOAWAY split across chunks", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();
	const goaway = Buffer.from([
		0x00, 0x00, 0x08,
		0x07,
		0x00,
		0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x01,
		0x00, 0x00, 0x00, 0x00,
	]);
	
	handoff.handleChunk(goaway.subarray(0, 7));
	const result = handoff.handleChunk(Buffer.concat([goaway.subarray(7), Buffer.from("prompt")]));
	
	assert.equal(handoff.isActive, false);
	assert.equal(resets.length, 1);
	assert.deepEqual(result.forwardedData, Buffer.alloc(0));
	assert.equal(result.terminalData.toString("latin1"), "prompt");
});

test("handleChunk does not scan arbitrary teardown text for GOAWAY", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();
	const goaway = Buffer.from([
		0x00, 0x00, 0x08,
		0x07,
		0x00,
		0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x01,
		0x00, 0x00, 0x00, 0x00,
	]);
	
	handoff.interrupt();
	const result = handoff.handleChunk(Buffer.concat([
		Buffer.from("too large frame size"),
		goaway,
		Buffer.from("prompt"),
	]));
	
	assert.equal(handoff.isActive, true);
	assert.equal(resets.length, 0);
	assert.equal(result.terminalData, null);
});

test("close destroys the session immediately (hard teardown, no GOAWAY)", () => {
	const {handoff, writes} = makeHandoff();
	handoff.activate();
	const staleSession = handoff.session;

	// Hard close destroys immediately. Re-activating creates a new session.
	handoff.close();
	handoff.activate();
	assert.notEqual(handoff.session, staleSession);

	// Writes from the destroyed stale session go nowhere (transport is destroyed).
	const writesBeforeStale = writes.length;
	staleSession.transport.write(Buffer.from("stale"));
	assert.equal(writes.length, writesBeforeStale);
});

test("close resets all state to terminal mode", () => {
	const {handoff} = makeHandoff();
	handoff.activate();
	handoff.close();
	assert.equal(handoff.mode, "terminal");
	assert.equal(handoff.isActive, false);
	assert.equal(handoff.session, null);
});

test("a new session is created when activate() is called after GOAWAY resets to terminal", () => {
	const {handoff} = makeHandoff();
	handoff.activate();
	const first = handoff.session;

	// Simulate server GOAWAY → terminal mode.
	first.emit("state", {status: SESSION_STATUS.CLOSING, phase: "goaway"});
	assert.equal(handoff.session, null);

	// Next bootstrap triggers a fresh session.
	handoff.activate();
	assert.ok(handoff.session, "new session must be created");
	assert.notEqual(handoff.session, first, "must be a different instance");
});

test("onReset fires when the server sends GOAWAY", () => {
	const resets = [];
	const {handoff} = makeHandoff({onReset: () => resets.push(true)});
	handoff.activate();
	const session = handoff.session;

	// Simulate the server's GOAWAY frame arriving.
	session.emit("state", {status: SESSION_STATUS.CLOSING, phase: "goaway"});

	assert.equal(resets.length, 1);
	assert.equal(handoff.isActive, false);
});

test("onReset also fires on CLOSED or ERROR without a prior GOAWAY (fallback)", () => {
	const resets = [];
	const {handoff} = makeHandoff({onReset: () => resets.push(true)});
	handoff.activate();
	const session = handoff.session;

	session.emit("state", {status: SESSION_STATUS.ERROR});

	assert.equal(resets.length, 1);
	assert.equal(handoff.isActive, false);
});

// ── Frame-splitting / byte-by-byte tests ─────────────────────────────────────

// A minimal DATA frame (stream 1, "hello") used as a forwarded payload in splitting tests.
const DATA_FRAME = Buffer.from([
	0x00, 0x00, 0x05,        // length = 5
	0x00,                    // type = DATA
	0x00,                    // flags
	0x00, 0x00, 0x00, 0x01,  // stream id = 1
	0x68, 0x65, 0x6c, 0x6c, 0x6f,  // "hello"
]);

// GOAWAY frame used in splitting tests (last-stream-id=1, NO_ERROR).
const GOAWAY_FRAME = Buffer.from([
	0x00, 0x00, 0x08,
	0x07,
	0x00,
	0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x01,
	0x00, 0x00, 0x00, 0x00,
]);

test("handleChunk: GOAWAY header without payload is buffered — payload bytes are not leaked as terminal data", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();

	// Feed only the 9-byte GOAWAY header — session must NOT reset yet.
	handoff.handleChunk(GOAWAY_FRAME.subarray(0, 9));
	assert.equal(handoff.isActive, true, "session must stay active while GOAWAY payload is outstanding");
	assert.equal(resets.length, 0, "no reset until full GOAWAY has arrived");

	// Feed the remaining 8 payload bytes plus terminal text.
	const result = handoff.handleChunk(Buffer.concat([GOAWAY_FRAME.subarray(9), Buffer.from("prompt")]));
	assert.equal(handoff.isActive, false, "session reset after full GOAWAY");
	assert.equal(resets.length, 1);
	assert.deepEqual(result.forwardedData, Buffer.alloc(0));
	assert.equal(result.terminalData.toString(), "prompt");
});

test("handleChunk: DATA frame then GOAWAY fed one byte at a time", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();

	const corpus = Buffer.concat([DATA_FRAME, GOAWAY_FRAME, Buffer.from("prompt")]);

	const forwardedChunks = [];
	const terminalChunks = [];

	for (const byte of corpus) {
		const result = handoff.handleChunk(Buffer.from([byte]));
		if (result.forwardedData?.length > 0) forwardedChunks.push(result.forwardedData);
		if (result.terminalData) {
			const b = Buffer.isBuffer(result.terminalData) ? result.terminalData : Buffer.from(result.terminalData, "latin1");
			if (b.length > 0) terminalChunks.push(b);
		}
	}

	assert.equal(handoff.isActive, false, "session reset after GOAWAY");
	assert.equal(resets.length, 1, "exactly one reset");
	assert.deepEqual(Buffer.concat(forwardedChunks), DATA_FRAME, "DATA frame forwarded exactly");
	assert.equal(Buffer.concat(terminalChunks).toString(), "prompt", "terminal bytes returned after GOAWAY");
});

test("handleChunk: two DATA frames then GOAWAY fed one byte at a time", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();

	const corpus = Buffer.concat([DATA_FRAME, DATA_FRAME, GOAWAY_FRAME, Buffer.from("$")]);

	const forwardedChunks = [];
	const terminalChunks = [];

	for (const byte of corpus) {
		const result = handoff.handleChunk(Buffer.from([byte]));
		if (result.forwardedData?.length > 0) forwardedChunks.push(result.forwardedData);
		if (result.terminalData) {
			const b = Buffer.isBuffer(result.terminalData) ? result.terminalData : Buffer.from(result.terminalData, "latin1");
			if (b.length > 0) terminalChunks.push(b);
		}
	}

	assert.equal(handoff.isActive, false);
	assert.equal(resets.length, 1);
	assert.deepEqual(Buffer.concat(forwardedChunks), Buffer.concat([DATA_FRAME, DATA_FRAME]));
	assert.equal(Buffer.concat(terminalChunks).toString(), "$");
});

test("handleChunk: GOAWAY only, no trailing bytes, fed one byte at a time", () => {
	const {handoff, resets} = makeHandoff();
	handoff.activate();

	let lastResult;
	for (const byte of GOAWAY_FRAME) {
		lastResult = handoff.handleChunk(Buffer.from([byte]));
	}

	assert.equal(handoff.isActive, false);
	assert.equal(resets.length, 1);
	assert.deepEqual(lastResult.forwardedData, Buffer.alloc(0));
	assert.equal(lastResult.terminalData, null);
});
