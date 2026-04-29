import http2 from "node:http2";
import {Duplex} from "node:stream";

import {encodeBootstrap} from "../../HTTY.js";

const PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

class Transport extends Duplex {
	constructor(writeChunk) {
		super();
		this.writeChunk = writeChunk;
	}
	
	_read() {
	}
	
	_write(chunk, _encoding, callback) {
		this.writeChunk(chunk);
		callback();
	}
	
	acceptChunk(chunk) {
		this.push(chunk);
	}
	
	shutdown() {
		this.push(null);
		this.destroy();
	}
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write(encodeBootstrap());

const transport = new Transport((chunk) => process.stdout.write(chunk));
const session = http2.performServerHandshake(transport);
let awaitingPreface = true;
let prefaceBuffer = "";

process.stdin.on("data", (chunk) => {
	if (awaitingPreface) {
		prefaceBuffer += Buffer.from(chunk).toString("latin1");
		const index = prefaceBuffer.indexOf(PREFACE);
		
		if (index === -1) return;
		
		awaitingPreface = false;
		transport.acceptChunk(Buffer.from(prefaceBuffer.slice(index), "latin1"));
		prefaceBuffer = "";
		return;
	}
	
	transport.acceptChunk(Buffer.from(chunk));
});

session.on("stream", (stream) => {
	stream.respond({
		":status": 200,
		"content-type": "text/plain",
	});
	stream.end("OK");
	stream.on("close", () => {
		session.close();
	});
});

session.on("close", () => {
	transport.shutdown();
	process.exit(0);
});
