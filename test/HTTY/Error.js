import assert from "node:assert/strict";
import test from "node:test";

import {DisabledError, UnsupportedError, assertSupportedEnvironment} from "../../HTTY/Error.js";

test("reports unsupported environment when HTTY is absent", () => {
	const writes = [];
	const stderr = {write: (message) => writes.push(message)};
	
	assert.throws(
		() => assertSupportedEnvironment({}, stderr),
		(error) => error instanceof UnsupportedError && /not supported/.test(error.message),
	);
	assert.match(writes.join(""), /https:\/\/htty\.dev/);
});

test("reports disabled environment when HTTY=0", () => {
	assert.throws(
		() => assertSupportedEnvironment({HTTY: "0"}),
		(error) => error instanceof DisabledError && error instanceof UnsupportedError && /disabled/.test(error.message),
	);
});

test("accepts advertised HTTY environments", () => {
	assert.doesNotThrow(() => assertSupportedEnvironment({HTTY: "1"}));
});
