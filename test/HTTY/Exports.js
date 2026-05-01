import assert from "node:assert/strict";
import test from "node:test";

test("package root exposes the intended public API", async () => {
	const root = await import("@socketry/htty");
	
	assert.equal(typeof root.Application, "function");
	assert.equal(typeof root.BootstrapDecoder, "function");
	assert.equal(typeof root.Client, "function");
	assert.equal(typeof root.Server, "function");
	assert.equal(typeof root.Transport, "function");
	assert.equal(typeof root.encodeBootstrap, "function");
	assert.equal(typeof root.assertSupportedEnvironment, "function");
	assert.equal(typeof root.SESSION_STATUS, "object");
	
	assert.equal(root.readRequestBody, undefined);
	assert.equal(root.chunkToBuffer, undefined);
});

test("package subpaths expose supported modules explicitly", async () => {
	const modules = {
		Application: ["Application"],
		Bootstrap: ["BootstrapDecoder", "encodeBootstrap"],
		Client: ["Client", "SESSION_STATUS"],
		Error: ["HTTYError", "UnsupportedError", "DisabledError", "assertSupportedEnvironment"],
		HTTP: ["normalizeRequestHeaders", "sanitizeResponseHeaders", "readRequestBody"],
		Server: ["Server"],
		Session: ["Session"],
		Transport: ["Transport", "chunkToBuffer"],
	};
	
	for (const [subpath, names] of Object.entries(modules)) {
		const mod = await import(`@socketry/htty/${subpath}`);
		
		for (const name of names) {
			assert.notEqual(mod[name], undefined, `expected ${subpath} to export ${name}`);
		}
	}
});

test("internal handoff module is not package-exported", async () => {
	await assert.rejects(
		() => import("@socketry/htty/Handoff"),
		(error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
	);
});
