import assert from "node:assert/strict";
import test from "node:test";
import {PassThrough} from "node:stream";

import {encodeBootstrap, Server, SESSION_STATUS} from "../../HTTY.js";
import {Session} from "../../HTTY/Session.js";

// ── MockProcess ────────────────────────────────────────────────────────────
//
// Simulates a PTY process: supports onData, onExit, write, resize, kill.
// Feed terminal bytes in via push(); capture PTY writes via writes[].

class MockProcess {
	#dataListeners = new Set();
	#exitListeners = new Set();
	writes = [];
	killed = false;

	onData(callback) {
		this.#dataListeners.add(callback);
		return {dispose: () => this.#dataListeners.delete(callback)};
	}

	onExit(callback) {
		this.#exitListeners.add(callback);
		return {dispose: () => this.#exitListeners.delete(callback)};
	}

	push(data) {
		for (const fn of this.#dataListeners) fn(data);
	}

	exit(exitCode = 0, signal = null) {
		for (const fn of this.#exitListeners) fn({exitCode, signal});
	}

	write(data) { this.writes.push(data); }
	resize() {}
	kill() { this.killed = true; }
}

function makeSession(options = {}) {
	const proc = new MockProcess();
	const session = new Session(proc, {
		id: "test-session",
		command: "/bin/sh",
		args: [],
		cwd: "/tmp",
		usePty: true,
		showTerminalTab: true,
		...options,
	});
	return {proc, session};
}

// ── Basic state ────────────────────────────────────────────────────────────

test("starts in terminal handoff state", () => {
	const {session} = makeSession();
	assert.equal(session.mode, "terminal");
	assert.equal(session.client, null);
});

test("snapshot reflects initial state", () => {
	const {session} = makeSession();
	const snap = session.snapshot(true);
	assert.equal(snap.id, "test-session");
	assert.equal(snap.exitInfo, null);
	assert.equal(snap.isActive, true);
});

// ── Terminal data ──────────────────────────────────────────────────────────

test("emits terminal-data for plain PTY output", () => {
	const {proc, session} = makeSession();
	const received = [];
	session.on("terminal-data", (text) => received.push(text));
	proc.push("hello\r\n");
	assert.deepEqual(received, ["hello\r\n"]);
});

test("decodes UTF-8 terminal output split across chunks", () => {
	const {proc, session} = makeSession();
	const received = [];
	const bytes = Buffer.from("│─┌ process\n", "utf8");
	
	session.on("terminal-data", (text) => received.push(text));
	proc.push(bytes.subarray(0, 1));
	proc.push(bytes.subarray(1, 5));
	proc.push(bytes.subarray(5));
	
	assert.equal(received.join(""), "│─┌ process\n");
});

test("does not emit terminal-data for HTTY bootstrap escape", () => {
	const {proc, session} = makeSession();
	const received = [];
	session.on("terminal-data", (text) => received.push(text));
	proc.push(encodeBootstrap());
	assert.deepEqual(received, []);
});

// ── Bootstrap detection ────────────────────────────────────────────────────

test("bootstrap sequence activates HTTY mode", () => {
	const {proc, session} = makeSession();
	proc.push(encodeBootstrap());
	assert.equal(session.mode, "htty");
	assert.equal(session.isHttyActive(), true);
});

test("negotiates http/2 and reaches ATTACHED state via loopback", async (context) => {
	// Build a loopback:
	//   proc.push(data)   →  Session handles it  →  Handoff calls proc.write()
	//   proc.write(chunk) →  serverInput         →  Server
	//   Server output     →  proc.push()         →  back into Session
	const proc = new MockProcess();
	const session = new Session(proc, {
		id: "loop",
		command: "/bin/sh",
		args: [],
		usePty: true,
		showTerminalTab: true,
	});

	const serverInput = new PassThrough();
	// Redirect Session's outbound writes (via proc.write) into the server input.
	proc.write = (chunk) => { serverInput.write(chunk); };

	const states = [];
	const attached = [];
	session.on("state", (state) => states.push(state));
	session.on("attached", () => attached.push(true));

	const server = Server.open((_stream, _headers) => {}, {
		input: serverInput,
		output: {write(chunk) { proc.push(chunk); }},
		raw: false,
		env: {HTTY: "1"},
	});

	context.after(() => {
		session.close();
		server.close();
	});

	// Server.start() writes the bootstrap sequence to output, which flows
	// through proc.push() and triggers the Session's bootstrap detection.
	// We do NOT need a separate proc.push(encodeBootstrap()) call.
	await new Promise((resolve) => {
		if (attached.length > 0) { resolve(); return; }
		session.on("attached", resolve);
	});

	// Suppress teardown errors: server.close() calls transport.shutdown()
	// immediately after session.close(), which can cause a second INTERNAL_ERROR
	// to arrive on the client after the first error's once-listener is consumed.
	session.client?.client?.on("error", () => {});

	assert.ok(states.some((state) => state.status === SESSION_STATUS.NEGOTIATING));
	assert.ok(states.some((state) => state.status === SESSION_STATUS.ATTACHED && state.phase === "ready"));
	assert.equal(attached.length, 1);
	assert.equal(session.mode, "htty");
});

// ── sendInput ──────────────────────────────────────────────────────────────

test("sendInput writes to process in terminal mode", () => {
	const {proc, session} = makeSession();
	const result = session.sendInput("ls\n");
	assert.equal(result, true);
	assert.equal(proc.writes.length, 1);
	assert.equal(proc.writes[0], "ls\n");
});

test("sendInput is blocked in htty mode", () => {
	const {proc, session} = makeSession();
	session.setMode("htty");
	const result = session.sendInput("ls\n");
	assert.equal(result, false);
});

// ── sendInterrupt ──────────────────────────────────────────────────────────

test("sendInterrupt sends CTRL+C in terminal mode", () => {
	const {proc, session} = makeSession();
	const result = session.sendInterrupt();
	assert.equal(result, true);
	assert.ok(proc.writes.some((w) => w === "\u0003"));
});

// ── Process exit ───────────────────────────────────────────────────────────

test("emits exit with exitCode and signal on process exit", () => {
	const {proc, session} = makeSession();
	const exits = [];
	session.on("exit", (info) => exits.push(info));
	proc.exit(0, null);
	assert.deepEqual(exits, [{exitCode: 0, signal: null}]);
	assert.deepEqual(session.exitInfo, {exitCode: 0, signal: null});
});

test("emits snapshot after process exit", () => {
	const {proc, session} = makeSession();
	const snapshots = [];
	session.on("snapshot", () => snapshots.push(true));
	proc.exit(1);
	assert.ok(snapshots.length > 0);
});

test("kills process on close()", () => {
	const {proc, session} = makeSession();
	session.close();
	assert.equal(proc.killed, true);
});

// ── State / title updates ─────────────────────────────────────────────────

test("updateState emits state and snapshot events", () => {
	const {session} = makeSession();
	const states = [];
	const snaps = [];
	session.on("state", (state) => states.push(state));
	session.on("snapshot", () => snaps.push(true));
	session.updateState({status: SESSION_STATUS.ATTACHED, phase: "ready"});
	assert.deepEqual(states, [{status: SESSION_STATUS.ATTACHED, phase: "ready"}]);
	assert.ok(snaps.length > 0);
});

test("updateTitle emits title and snapshot when changed", () => {
	const {session} = makeSession();
	const titles = [];
	session.on("title", (t) => titles.push(t));
	session.updateTitle("My App");
	assert.deepEqual(titles, ["My App"]);
	assert.equal(session.title, "My App");
});

test("updateTitle is a no-op when title is unchanged", () => {
	const {session} = makeSession({title: "shell"});
	const titles = [];
	session.on("title", (t) => titles.push(t));
	session.updateTitle("shell");
	assert.deepEqual(titles, []);
});

// ── Residual teardown data regression ─────────────────────────────────────
//
// Reproduces the "fails on second run" bug:
//
// Root cause (two interacting issues):
//
//   1. Server.close() called transport.shutdown() synchronously right after
//      session.close(). The http2 server session, seeing its transport destroyed
//      while still active, emitted a trailing GOAWAY(INTERNAL_ERROR) via its
//      output (PTY stdout). Because of PTY read buffering, this frame could
//      arrive *after* the second server had bootstrapped and its new
//      Session was ATTACHED, corrupting the new session.
//
//   2. Session.sendInterrupt() previously closed the HTTP/2 client
//      asynchronously, scheduling GOAWAY for a future event loop tick. The new
//      bootstrap could be processed before GOAWAY was sent, leaving a stale
//      write window.
//
// Fix:
//   1. Server.close() defers transport.shutdown() to session.once("close")
//      so the transport is only shut down after the session has closed
//      gracefully — preventing the GOAWAY(INTERNAL_ERROR) entirely.
//
//   2. Session.sendInterrupt() writes GOAWAY(NO_ERROR) synchronously before
//      returning to terminal mode, so there is no async race with the next
//      bootstrap.

test("second server connection succeeds after Server.close() with no residual GOAWAY corruption", async (context) => {
	const proc = new MockProcess();
	const session = new Session(proc, {
		id: "repro",
		command: "/bin/sh",
		args: [],
		usePty: true,
		showTerminalTab: true,
	});

	function openServer(serverInput) {
		return Server.open(async (stream) => {
			stream.respond({":status": 200, "content-type": "text/plain"});
			stream.end("hello");
		}, {input: serverInput, output: {write(chunk) { proc.push(chunk); }}, raw: false, env: {HTTY: "1"}});
	}

	// ── First connection ──────────────────────────────────────────────────────

	const serverInput1 = new PassThrough();
	proc.write = (chunk) => { serverInput1.write(chunk); };
	const firstConnection = new Promise((resolve) => {
		session.on("attached", function onAttached() {
			session.off("attached", onAttached); resolve();
		});
	});
	const server1 = openServer(serverInput1);
	await firstConnection;

	assert.equal(session.mode, "htty", "first connection ATTACHED");
	const detached = [];
	session.on("detached", () => detached.push(true));

	// User closes the HTTY surface. sendInterrupt() writes GOAWAY synchronously
	// before the next bootstrap can be processed.
	session.sendInterrupt();

	// The server receives the GOAWAY and closes.
	// With the fix, transport.shutdown() is deferred to session.once("close"),
	// so no GOAWAY(INTERNAL_ERROR) is emitted to the output/PTY.
	server1.close();

	// Wait for the handoff to return to terminal mode. With the new design,
	// #session is nullified when the server's GOAWAY arrives — wait for the
	// "reset" event which is emitted at that moment rather than relying on
	// a fixed-time delay.
	await new Promise((resolve) => {
		if (!session.isHttyActive()) { resolve(); return; }
		session.on("reset", resolve);
	});

	// ── Second connection ─────────────────────────────────────────────────────

	const serverInput2 = new PassThrough();
	proc.write = (chunk) => { serverInput2.write(chunk); };

	const states2 = [];
	session.on("state", (state) => states2.push(state));
	const secondConnection = new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("timed out waiting for second ATTACHED")), 3000,
		);
		session.on("attached", function onAttached() {
			clearTimeout(timeout); session.off("attached", onAttached); resolve();
		});
		session.on("state", function onState(state) {
			if (state.status === SESSION_STATUS.ERROR) {
				clearTimeout(timeout); session.off("state", onState);
				reject(new Error("second session errored — residual teardown data corrupted it"));
			}
			if (state.status === SESSION_STATUS.ATTACHED && state.phase === "ready") {
				session.off("state", onState);
			}
		});
	});
	const server2 = openServer(serverInput2);
	await secondConnection;

	assert.equal(session.mode, "htty", "second connection reaches ATTACHED cleanly");
	assert.ok(states2.some((state) => state.status === SESSION_STATUS.NEGOTIATING));
	assert.ok(states2.some((state) => state.status === SESSION_STATUS.ATTACHED && state.phase === "ready"));
	assert.ok(!states2.some((state) => state.status === SESSION_STATUS.ERROR));
	assert.equal(detached.length, 1);

	context.after(() => {
		session.client?.client?.on("error", () => {});
		session.close();
		server1.close();
		server2.close();
	});
});
