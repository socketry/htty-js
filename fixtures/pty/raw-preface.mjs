import {encodeBootstrap} from "../../HTTY.js";

const PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write(encodeBootstrap());

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
	
	if (buffer.length >= PREFACE.length) {
		process.stdout.write(buffer.subarray(0, PREFACE.length).toString("latin1") === PREFACE ? "PREFACE_OK" : "PREFACE_BAD");
		process.exit(0);
	}
});
