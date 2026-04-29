import {EventEmitter} from "node:events";
import http2 from "node:http2";

import {encodeBootstrap} from "./Bootstrap.js";
import {assertSupportedEnvironment} from "./Error.js";
import {HTTP2_CLIENT_PREFACE, sanitizePrefaceInput, trimToPotentialPreface} from "./HTTP.js";
import {chunkToBuffer, Transport} from "./Transport.js";

export class Server extends EventEmitter {
	constructor(app, {input = process.stdin, output = process.stdout, raw = true} = {}) {
		super();

		this.app = app;
		this.input = input;
		this.output = output;
		this.raw = raw;
		this.transport = new Transport((chunk) => {
			this.output.write(chunk);
		});
		this.session = null;
		this.restoreMode = null;
		this.awaitingClientPreface = true;
		this.prefaceBuffer = "";
		this.handleInputData = (chunk) => {
			const data = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunkToBuffer(chunk);

			if (data.length === 0) {
				return;
			}

			if (this.awaitingClientPreface) {
				this.prefaceBuffer += sanitizePrefaceInput(data.toString("latin1"));
				const prefaceIndex = this.prefaceBuffer.indexOf(HTTP2_CLIENT_PREFACE);

				if (prefaceIndex === -1) {
					this.prefaceBuffer = trimToPotentialPreface(this.prefaceBuffer);
					return;
				}

				const prefaceData = this.prefaceBuffer.slice(prefaceIndex);
				this.prefaceBuffer = "";
				this.awaitingClientPreface = false;
				this.transport.acceptChunk(Buffer.from(prefaceData, "latin1"));
				return;
			}

			this.transport.acceptChunk(data);
		};
	}

	start() {
		if (this.session) {
			return this.session;
		}

		this.#enableRawMode();
		this.input.setEncoding?.("latin1");
		this.input.on("data", this.handleInputData);
		this.input.resume?.();
		this.output.write(encodeBootstrap());

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
		this.input.off?.("data", this.handleInputData);
		this.input.pause?.();
		this.awaitingClientPreface = true;
		this.prefaceBuffer = "";
		const session = this.session;
		this.session = null;

		if (session) {
			session.once("close", () => this.transport.shutdown());
			session.close();
		} else {
			this.transport.shutdown();
		}

		this.#disableRawMode();
	}

	#enableRawMode() {
		if (!this.raw || !this.input.isTTY || typeof this.input.setRawMode !== "function") {
			return;
		}

		const wasRaw = this.input.isRaw;
		this.input.setRawMode(true);
		this.restoreMode = () => {
			this.input.setRawMode(Boolean(wasRaw));
		};
	}

	#disableRawMode() {
		this.restoreMode?.();
		this.restoreMode = null;
	}

	static open(app, {env = process.env, stderr = process.stderr, ...options} = {}) {
		assertSupportedEnvironment(env, stderr);
		const server = new Server(app, options);
		server.start();
		return server;
	}
}
