import assert from "node:assert/strict";
import test from "node:test";

import {
	Application,
	BootstrapDecoder,
	Client,
	encodeBootstrap,
	assertSupportedEnvironment,
	Server,
	Transport,
	SESSION_STATUS,
} from "../HTTY.js";

test("root module exposes the primary HTTY API", () => {
	assert.equal(typeof Application, "function");
	assert.equal(typeof BootstrapDecoder, "function");
	assert.equal(typeof Client, "function");
	assert.equal(typeof Server, "function");
	assert.equal(typeof Transport, "function");
	assert.equal(typeof encodeBootstrap, "function");
	assert.equal(typeof assertSupportedEnvironment, "function");
	assert.equal(SESSION_STATUS.IDLE, "idle");
});
