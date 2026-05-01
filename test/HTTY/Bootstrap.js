import assert from "node:assert/strict";
import test from "node:test";

import {BootstrapDecoder, HTTY_BOOTSTRAP_IDENTIFIER, decodeBootstrap, encodeBootstrap} from "../../HTTY/Bootstrap.js";

test("encodes and decodes an HTTY raw bootstrap sequence", () => {
	const encoded = encodeBootstrap();
	
	assert.equal(encoded, "\u001bP+Hraw\u001b\\");
	assert.deepEqual(HTTY_BOOTSTRAP_IDENTIFIER, {intermediates: "+", final: "H"});
	assert.deepEqual(decodeBootstrap(" raw "), {mode: "raw"});
	assert.equal(decodeBootstrap("framed"), null);
});

test("reports raw trailing bytes after the bootstrap boundary", () => {
	const decoder = new BootstrapDecoder();
	const trailingBytes = Buffer.from([0x00, 0xff, 0x41]).toString("latin1");
	const result = decoder.push(`${encodeBootstrap()}${trailingBytes}`);
	
	assert.equal(result.beforeBootstrap, "");
	assert.equal(result.afterBootstrap, trailingBytes);
	assert.deepEqual(result.bootstraps, [{mode: "raw"}]);
});

test("ignores implementation-specific DCS markers before bootstrap", () => {
	const decoder = new BootstrapDecoder();
	const result = decoder.push("\u001bP+reset:token\u001b\\terminal text\u001bP+Hraw\u001b\\RAW");
	
	assert.equal(result.beforeBootstrap, "\u001bP+reset:token\u001b\\terminal text");
	assert.equal(result.afterBootstrap, "RAW");
	assert.deepEqual(result.bootstraps, [{mode: "raw"}]);
});
