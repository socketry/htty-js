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

export function terminalChunkPreview(data, encoding = "latin1") {
	const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
	return {
		length: chunk.length,
		preview: chunk.toString("hex").slice(0, 80),
	};
}

export function classifyTerminalData({data, decoder, httyActive}) {
	if (httyActive) {
		return {
			plainText: "",
			rawData: data,
			activateRaw: false,
		};
	}

	const {beforeBootstrap, afterBootstrap, bootstraps} = decoder.push(data);
	return {
		plainText: beforeBootstrap,
		rawData: bootstraps.length > 0 ? afterBootstrap : "",
		activateRaw: bootstraps.some((bootstrap) => bootstrap.mode === "raw"),
	};
}
