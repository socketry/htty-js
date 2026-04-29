import assert from "node:assert/strict";
import test from "node:test";

import {encodeBootstrap, SESSION_STATUS} from "../../HTTY.js";
import {Handoff} from "../../HTTY/Handoff.js";

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
