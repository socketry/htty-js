import {EventEmitter} from "node:events";
import http2 from "node:http2";
import {Readable} from "node:stream";

import {DEFAULT_AUTHORITY, normalizeRequestHeaders, sanitizeResponseHeaders} from "./HTTP.js";
import {Transport} from "./Transport.js";

// Status transitions for Client:
//
//   IDLE -> NEGOTIATING  on start() or the first handleChunk() call
//   NEGOTIATING -> ATTACHED (phase: "connected")  on http/2 "connect" event
//   ATTACHED (connected) -> ATTACHED (phase: "ready")  on "remoteSettings"
//   ATTACHED -> CLOSING (phase: "goaway")  on server-sent GOAWAY frame
//   any -> CLOSING (phase: "local-close")  on close()
//   CLOSING -> CLOSED  on http/2 "close" event or immediately in close()
//   any -> ERROR  on http/2 "error" event
export const SESSION_STATUS = {
	IDLE: "idle",
	NEGOTIATING: "negotiating",
	ATTACHED: "attached",
	CLOSING: "closing",
	CLOSED: "closed",
	ERROR: "error",
};

function pipeRequestBody(stream, body) {
	if (body == null) {
		stream.end();
		return;
	}

	if (typeof body.pipe === "function") {
		body.on?.("error", (error) => stream.destroy(error));
		body.pipe(stream);
		return;
	}

	if (typeof body.getReader === "function") {
		Readable.fromWeb(body).pipe(stream);
		return;
	}

	if (typeof body[Symbol.asyncIterator] === "function") {
		Readable.from(body).pipe(stream);
		return;
	}

	stream.end(body);
}

async function readResponseBuffer(body) {
	const chunks = [];

	for await (const chunk of body) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}

	return Buffer.concat(chunks);
}

/**
 * HTTP/2 client endpoint for an already-bootstrapped HTTY session.
 *
 * The write callback receives outbound HTTP/2 bytes that should be written to
 * the command process. Bytes received from the command process after HTTY
 * takeover should be passed back with handleChunk().
 */
export class Client extends EventEmitter {
	constructor(writeChunk) {
		super();

		this.transport = new Transport(writeChunk);
		this.client = null;
		this.status = SESSION_STATUS.IDLE;
	}

	setStatus(status, details = {}) {
		if (this.status === status && Object.keys(details).length === 0) {
			return;
		}

		this.status = status;
		this.emit("state", {status, ...details});
	}

	start() {
		if (this.client && !this.client.closed) {
			return this.client;
		}

		this.setStatus(SESSION_STATUS.NEGOTIATING);

		this.client = http2.connect(`http://${DEFAULT_AUTHORITY}`, {
			createConnection: () => this.transport,
			settings: {
				enableConnectProtocol: true,
			},
		});

		this.client.on("connect", () => {
			this.setStatus(SESSION_STATUS.ATTACHED, {phase: "connected"});
		});

		this.client.on("remoteSettings", (settings) => {
			this.setStatus(SESSION_STATUS.ATTACHED, {phase: "ready", settings});
		});

		this.client.on("goaway", (errorCode, lastStreamID, opaqueData) => {
			this.setStatus(SESSION_STATUS.CLOSING, {
				phase: "goaway",
				errorCode,
				lastStreamID,
				opaqueData: opaqueData?.toString("utf8") ?? "",
			});
		});

		this.client.on("error", (error) => {
			this.setStatus(SESSION_STATUS.ERROR, {message: error.message});
		});

		this.client.on("close", () => {
			this.setStatus(SESSION_STATUS.CLOSED);
			if (!this.transport.destroyed) {
				this.transport.shutdown();
			}
		});

		return this.client;
	}

	handleChunk(chunk) {
		if (this.status === SESSION_STATUS.IDLE) {
			this.start();
		}

		this.transport.acceptChunk(chunk);
	}

	async request({path = "/", method = "GET", headers = {}, body} = {}) {
		const client = this.start();

		return new Promise((resolve, reject) => {
			const requestHeaders = normalizeRequestHeaders({path, method, headers});
			const stream = client.request(requestHeaders);
			let responseHeaders = {};
			let responseStatus = 0;
			let settled = false;

			stream.on("response", (incomingHeaders) => {
				responseStatus = Number(incomingHeaders[":status"] || 0);
				responseHeaders = sanitizeResponseHeaders(incomingHeaders);
				settled = true;
				resolve({
					status: responseStatus,
					headers: responseHeaders,
					body: stream,
					stream,
				});
			});
			stream.on("error", (error) => {
				if (!settled) {
					reject(error);
				}
			});

			pipeRequestBody(stream, body);
		});
	}

	async requestBuffer(options = {}) {
		const response = await this.request(options);
		const {status, headers} = response;
		return {
			status,
			headers,
			body: await readResponseBuffer(response.body),
		};
	}

	async requestText(options = {}) {
		const response = await this.requestBuffer(options);
		const {status, headers} = response;
		return {
			status,
			headers,
			body: response.body.toString("utf8"),
		};
	}

	close() {
		if (this.status === SESSION_STATUS.CLOSED || this.status === SESSION_STATUS.CLOSING) {
			return;
		}

		this.setStatus(SESSION_STATUS.CLOSING, {phase: "local-close"});

		const client = this.client;
		this.client = null;

		if (client && !client.closed && !client.destroyed) {
			client.close();
		} else {
			this.setStatus(SESSION_STATUS.CLOSED);
			if (!this.transport.destroyed) {
				this.transport.shutdown();
			}
		}
	}
}
