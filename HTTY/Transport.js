import {Duplex} from "node:stream";

export function chunkToBuffer(chunk, encoding = "utf8") {
	if (Buffer.isBuffer(chunk)) {
		return chunk;
	}

	if (chunk instanceof Uint8Array) {
		return Buffer.from(chunk);
	}

	if (typeof chunk === "string") {
		return Buffer.from(chunk, encoding);
	}

	return Buffer.from(chunk ?? []);
}

/**
 * Duplex byte bridge used by Node's http2 client/server sessions.
 *
 * Writes from http2 are delivered to the injected writeChunk callback. Incoming
 * bytes from the peer are pushed into the readable side with acceptChunk().
 */
export class Transport extends Duplex {
	constructor(writeChunk) {
		super();

		this.writeChunk = writeChunk;
		this.localClosed = false;
		this.remoteClosed = false;
	}

	_read() {
		// Reads are satisfied by acceptChunk pushing decoded payloads.
	}

	_write(chunk, _encoding, callback) {
		try {
			if (this.localClosed) {
				callback();
				return;
			}
			
			if (chunk.length > 0) {
				this.writeChunk(chunkToBuffer(chunk));
			}
			callback();
		} catch (error) {
			callback(error);
		}
	}

	_final(callback) {
		try {
			this.localClosed = true;
			callback();
		} catch (error) {
			callback(error);
		}
	}

	acceptChunk(chunk) {
		this.push(chunkToBuffer(chunk, "latin1"));
	}

	closeTransport() {
		if (!this.localClosed) {
			this.localClosed = true;
		}
	}

	endRemote() {
		if (!this.remoteClosed) {
			this.remoteClosed = true;
			this.push(null);
		}
	}

	shutdown() {
		this.closeTransport();
		this.endRemote();
		this.destroy();
	}
}
