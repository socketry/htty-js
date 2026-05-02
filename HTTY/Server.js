import {execFileSync} from "node:child_process";
import {EventEmitter} from "node:events";
import http2 from "node:http2";

import {encodeBootstrap} from "./Bootstrap.js";
import {assertSupportedEnvironment} from "./Error.js";
import {HTTP2_CLIENT_PREFACE, trimToPotentialPreface} from "./HTTP.js";
import {chunkToBuffer, Transport} from "./Transport.js";

function enableRawMode(input, raw) {
	if (!raw || !input.isTTY || typeof input.setRawMode !== "function") {
		return null;
	}

	try {
		const mode = execFileSync("stty", ["-g"], {
			encoding: "utf8",
			stdio: [input, "pipe", "ignore"],
		}).trim();
		
		execFileSync("stty", ["raw", "-echo"], {
			stdio: [input, "ignore", "ignore"],
		});
		
		return () => {
			execFileSync("stty", [mode], {
				stdio: [input, "ignore", "ignore"],
			});
		};
	} catch {
		const wasRaw = input.isRaw;
		// Node/libuv raw mode keeps output processing such as ONLCR enabled,
		// so this fallback is not fully byte-preserving for HTTY.
		input.setRawMode(true);
		return () => {
			input.setRawMode(Boolean(wasRaw));
		};
	}
}

// Keep a private writer for HTTY protocol bytes before suppressing public
// writes to the same stream. This lets bootstrap/HTTP2 output continue while
// console.log or other incidental writes are dropped.
function captureWritable(stream) {
	if (typeof stream?.write === "function") {
		return {
			write: stream.write.bind(stream),
		};
	}
	
	return stream;
}

// Node streams report write completion through an optional callback; preserve
// that contract even though the bytes are intentionally discarded.
function nullWrite(_chunk, encoding, callback) {
	if (typeof encoding === "function") {
		encoding();
	} else if (typeof callback === "function") {
		callback();
	}
	
	return true;
}

// Node stdio streams do not provide a descriptor-level reopen operation, so
// temporarily replace write() and restore it when the HTTY session closes.
function suppressWritable(stream) {
	if (typeof stream?.write === "function") {
		const write = stream.write;
		stream.write = nullWrite;
		return () => {
			stream.write = write;
		};
	}
	
	return null;
}

function restoreWritableStreams(restorers) {
	for (const restore of restorers.splice(0).reverse()) {
		restore?.();
	}
}

function openTerminalTransport({input = process.stdin, output = process.stdout, raw = true} = {}) {
	const transport = new Transport((chunk) => {
		output.write(chunk);
	});
	let restoreMode = null;
	let awaitingClientPreface = true;
	let prefaceBuffer = "";
	
	const handleInputData = (chunk) => {
		const data = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunkToBuffer(chunk);

		if (data.length === 0) {
			return;
		}

		if (awaitingClientPreface) {
			prefaceBuffer += data.toString("latin1");
			const prefaceIndex = prefaceBuffer.indexOf(HTTP2_CLIENT_PREFACE);

			if (prefaceIndex === -1) {
				prefaceBuffer = trimToPotentialPreface(prefaceBuffer);
				return;
			}

			const prefaceData = prefaceBuffer.slice(prefaceIndex);
			prefaceBuffer = "";
			awaitingClientPreface = false;
			transport.acceptChunk(Buffer.from(prefaceData, "latin1"));
			return;
		}

		transport.acceptChunk(data);
	};
	
	return {
		transport,
		start() {
			restoreMode = enableRawMode(input, raw);
			input.setEncoding?.("latin1");
			input.on("data", handleInputData);
			input.resume?.();
			output.write(encodeBootstrap());
		},
		close() {
			input.off?.("data", handleInputData);
			input.pause?.();
			awaitingClientPreface = true;
			prefaceBuffer = "";
			restoreMode?.();
			restoreMode = null;
		},
	};
}

/**
 * HTTP/2 server endpoint over an HTTY byte transport.
 *
 * Construct directly when you already have a byte-preserving Transport. Use
 * Server.open() for stdio-backed command processes; it owns environment
 * checks, terminal raw-mode setup, bootstrap emission, and preface filtering.
 */
export class Server extends EventEmitter {
	constructor(app, {transport, onClose} = {}) {
		super();

		this.app = app;
		this.transport = transport;
		this.onClose = onClose;
		this.session = null;
	}

	start() {
		if (this.session) {
			return this.session;
		}

		if (!this.transport) {
			throw new TypeError("Server requires a byte-preserving transport. Use Server.open() for stdio.");
		}

		this.session = http2.performServerHandshake(this.transport, {
			settings: {
				enableConnectProtocol: true,
			},
		});

		this.session.on("stream", async (stream, headers) => {
			try {
				await this.app(stream, headers);
			} catch (error) {
				this.emit("error", error);
				try {
					stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
				} catch {
					stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
				}
			}
		});

		this.session.on("goaway", () => {
			if (this.session) {
				this.close();
			}
		});

		this.session.on("close", () => {
			if (this.session) {
				this.close();
			}
		});

		return this.session;
	}

	close() {
		const session = this.session;
		this.session = null;

		if (session) {
			session.close();
			setImmediate(() => {
				this.transport.shutdown();
				this.onClose?.();
			});
		} else {
			setImmediate(() => {
				this.transport.shutdown();
				this.onClose?.();
			});
		}
	}

	static open(app, {input = process.stdin, output = process.stdout, stderr = process.stderr, env = process.env, ...options} = {}) {
		assertSupportedEnvironment(env, stderr);
		
		const protocolOutput = captureWritable(output);
		const restorers = [];
		
		const terminal = openTerminalTransport({
			...options,
			input,
			output: protocolOutput,
		});
		const server = new Server(app, {
			transport: terminal.transport,
			onClose: () => {
				terminal.close();
				restoreWritableStreams(restorers);
			},
		});
		
		try {
			// Suppress public output only after the protocol writer has been captured.
			// This protects HTTY framing from console output and logging noise.
			restorers.push(
				suppressWritable(output),
				suppressWritable(stderr),
			);
			terminal.start();
			server.start();
		} catch (error) {
			terminal.close();
			terminal.transport.shutdown();
			restoreWritableStreams(restorers);
			throw error;
		}
		return server;
	}
}
