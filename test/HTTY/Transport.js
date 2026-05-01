import assert from "node:assert/strict";
import test from "node:test";

import {Transport} from "../../HTTY/Transport.js";

test("writes raw bytes through the duplex transport", async () => {
	const writes = [];
	const duplex = new Transport((chunk) => writes.push(chunk));
	
	duplex.write(Buffer.from("hello"));
	duplex.end();
	
	assert.equal(writes.length, 1);
	assert.equal(writes[0].toString("latin1"), "hello");
});

test("drops writes after transport is closed", async () => {
	const writes = [];
	const transport = new Transport((chunk) => writes.push(chunk));
	
	transport.closeTransport();
	transport.write(Buffer.from("late"));
	transport.end();
	
	await new Promise((resolve) => transport.once("finish", resolve));
	
	assert.deepEqual(writes, []);
});
