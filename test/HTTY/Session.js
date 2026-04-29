import assert from "node:assert/strict";
import test from "node:test";
import {PassThrough} from "node:stream";

import {encodeBootstrap, Server, SESSION_STATUS} from "../../HTTY.js";
import {Session, HANDOFF_STATES} from "../../HTTY/Session.js";

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
	assert.equal(session.handoffState, HANDOFF_STATES.TERMINAL);
	assert.equal(session.mode, "terminal");
	assert.equal(session.httySession, null);
});

test("snapshot reflects initial state", () => {
	const {session} = makeSession();
	const snap = session.snapshot(true);
	assert.equal(snap.id, "test-session");
	assert.equal(snap.httyHandoffState, HANDOFF_STATES.TERMINAL);
	assert.equal(snap.hasDocument, false);
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

test("does not emit terminal-data for HTTY bootstrap escape", () => {
	const {proc, session} = makeSession();
	const received = [];
	session.on("terminal-data", (text) => received.push(text));
	proc.push(encodeBootstrap());
	assert.deepEqual(received, []);
});

// ── Bootstrap detection ────────────────────────────────────────────────────

test("transitions to BOOTSTRAP_DETECTED on bootstrap sequence", () => {
	const {proc, session} = makeSession();
	const states = [];
	session.on("handoff-state", (entry) => states.push(entry.state));
	proc.push(encodeBootstrap());
	assert.ok(states.includes(HANDOFF_STATES.BOOTSTRAP_DETECTED));
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
	const server = new Server((_stream, _headers) => {}, {
		input: serverInput,
		output: {write(chunk) { proc.push(chunk); }},
		raw: false,
	});

	// Redirect Session's outbound writes (via proc.write) into the server input.
	proc.write = (chunk) => { serverInput.write(chunk); };

	const states = [];
	session.on("handoff-state", (entry) => states.push(entry.state));

	context.after(() => {
		session.handoff.close();
		server.close();
	});

	// Server.start() writes the bootstrap sequence to output, which flows
	// through proc.push() and triggers the Session's bootstrap detection.
	// We do NOT need a separate proc.push(encodeBootstrap()) call.
	server.start();

	await new Promise((resolve) => {
		session.on("handoff-state", (entry) => {
			if (entry.state === HANDOFF_STATES.ATTACHED) resolve();
		});
	});

	// Suppress teardown errors: server.close() calls transport.shutdown()
	// immediately after session.close(), which can cause a second INTERNAL_ERROR
	// to arrive on the client after the first error's once-listener is consumed.
	session.httySession?.client?.on("error", () => {});

	assert.ok(states.includes(HANDOFF_STATES.BOOTSTRAP_DETECTED));
	assert.ok(states.includes(HANDOFF_STATES.CLIENT_NEGOTIATING));
	assert.ok(states.includes(HANDOFF_STATES.ATTACHED));
	assert.equal(session.handoffState, HANDOFF_STATES.ATTACHED);
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
	session.handoff.setMode("htty");
	// Manually force mode since setMode blocks while active; bypass for test.
	Object.defineProperty(session.handoff, "mode", {get: () => "htty"});
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

test("sendInterrupt emits request-close for hidden sessions", () => {
	const {session} = makeSession({showTerminalTab: false});
	const closes = [];
	session.on("request-close", () => closes.push(true));
	session.sendInterrupt();
	assert.equal(closes.length, 1);
	assert.equal(session.closeAfterExit, true);
	assert.equal(session.closeSurfacesOnExit, true);
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

test("sets closeAfterExit on exit when showTerminalTab is false", () => {
	const {proc, session} = makeSession({showTerminalTab: false});
	proc.exit(0);
	assert.equal(session.closeAfterExit, true);
});

test("kills process on close()", () => {
	const {proc, session} = makeSession();
	session.close();
	assert.equal(proc.killed, true);
});

// ── State / document / title updates ──────────────────────────────────────

test("updateDocument emits document and snapshot events", () => {
	const {session} = makeSession();
	const docs = [];
	const snaps = [];
	session.on("document", (p) => docs.push(p));
	session.on("snapshot", () => snaps.push(true));
	session.updateDocument({path: "/", body: "<h1>hello</h1>"});
	assert.equal(docs.length, 1);
	assert.ok(snaps.length > 0);
	assert.equal(session.debugState.document.path, "/");
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

test("snapshotDebugState reflects chunk and handoff history", () => {
	const {proc, session} = makeSession();
	proc.push("some output");
	const debug = session.snapshotDebugState();
	assert.equal(debug.sessionId, "test-session");
	assert.equal(typeof debug.chunkCount, "number");
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
//   2. Handoff.interrupt() called http2Client.close() (async), which scheduled
//      the GOAWAY write for a future event loop tick. The new bootstrap could
//      be processed before the GOAWAY was sent, leaving a stale write window.
//
// Fix:
//   1. Server.close() defers transport.shutdown() to session.once("close")
//      so the transport is only shut down after the session has closed
//      gracefully — preventing the GOAWAY(INTERNAL_ERROR) entirely.
//
//   2. Handoff.interrupt() writes the GOAWAY(NO_ERROR) frame *synchronously*
//      via the transport's writeChunk before resetting state, then immediately
//      destroys the session (no 2000 ms timer, no async race).

test("second server connection succeeds after Server.close() with no residual GOAWAY corruption", async (context) => {
	const proc = new MockProcess();
	const session = new Session(proc, {
		id: "repro",
		command: "/bin/sh",
		args: [],
		usePty: true,
		showTerminalTab: true,
	});

	function makeServer() {
		const serverInput = new PassThrough();
		const server = new Server(async (stream) => {
			stream.respond({":status": 200, "content-type": "text/plain"});
			stream.end("hello");
		}, {input: serverInput, output: {write(chunk) { proc.push(chunk); }}, raw: false});
		return {server, serverInput};
	}

	// ── First connection ──────────────────────────────────────────────────────

	const {server: server1, serverInput: serverInput1} = makeServer();
	proc.write = (chunk) => { serverInput1.write(chunk); };
	server1.start();

	await new Promise((resolve) => {
		session.on("handoff-state", function onState(entry) {
			if (entry.state === HANDOFF_STATES.ATTACHED) { session.off("handoff-state", onState); resolve(); }
		});
	});

	assert.equal(session.handoffState, HANDOFF_STATES.ATTACHED, "first connection ATTACHED");

	// User closes the HTTY surface.
	// With the fix, interrupt() writes GOAWAY synchronously and destroys the
	// session immediately — no async close racing with the next bootstrap.
	session.handoff.interrupt();

	// The server receives the GOAWAY and closes.
	// With the fix, transport.shutdown() is deferred to session.once("close"),
	// so no GOAWAY(INTERNAL_ERROR) is emitted to the output/PTY.
	server1.close();

	// Wait for the handoff to return to terminal mode. With the new design,
	// #session is nullified when the server's GOAWAY arrives — wait for the
	// "reset" event which is emitted at that moment rather than relying on
	// a fixed-time delay.
	await new Promise((resolve) => {
		if (!session.handoff.isActive) { resolve(); return; }
		session.on("reset", resolve);
	});

	// ── Second connection ─────────────────────────────────────────────────────

	const {server: server2, serverInput: serverInput2} = makeServer();
	proc.write = (chunk) => { serverInput2.write(chunk); };

	const states2 = [];
	session.on("handoff-state", (entry) => states2.push(entry.state));

	server2.start();

	await new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("timed out waiting for second ATTACHED")), 3000,
		);
		session.on("handoff-state", function onState(entry) {
			if (entry.state === HANDOFF_STATES.ATTACHED) {
				clearTimeout(timeout); session.off("handoff-state", onState); resolve();
			}
			if (entry.state === HANDOFF_STATES.ERROR) {
				clearTimeout(timeout); session.off("handoff-state", onState);
				reject(new Error("second session errored — residual teardown data corrupted it"));
			}
		});
	});

	assert.equal(session.handoffState, HANDOFF_STATES.ATTACHED, "second connection reaches ATTACHED cleanly");
	assert.ok(states2.includes(HANDOFF_STATES.BOOTSTRAP_DETECTED));
	assert.ok(states2.includes(HANDOFF_STATES.ATTACHED));
	assert.ok(!states2.includes(HANDOFF_STATES.ERROR));

	context.after(() => {
		session.httySession?.client?.on("error", () => {});
		session.handoff.close();
		server1.close();
		server2.close();
	});
});
