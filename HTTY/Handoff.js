import {BootstrapDecoder, Client, SESSION_STATUS} from "../HTTY.js";

// Pre-encoded HTTP/2 GOAWAY(NO_ERROR) frame — 17 bytes.
// Written directly to the PTY by interrupt() so the server receives the
// close signal immediately, without going through the http/2 client's own
// close() path (which would destroy the session and drop the server's reply).
const GOAWAY_NO_ERROR_FRAME = Buffer.from([
	0x00, 0x00, 0x08,        // payload length = 8
	0x07,                    // type = GOAWAY
	0x00,                    // flags
	0x00, 0x00, 0x00, 0x00,  // stream id = 0
	0x00, 0x00, 0x00, 0x00,  // last-stream-id = 0
	0x00, 0x00, 0x00, 0x00,  // error-code = NO_ERROR (0)
]);

function classifyTerminalData({data, decoder, httyActive}) {
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

/**
 * Manages the HTTY protocol handoff within a terminal session.
 *
 * Internal module: this class is tested directly inside the package, but it is
 * not exposed as a package subpath. Integrations should use Session instead.
 *
 * All side-effects are delivered via injected callbacks.
 *
 * ── Lifecycle ─────────────────────────────────────────────────────────────
 *
 *   TERMINAL  (#session = null)
 *     ↓  bootstrap sequence detected in PTY stdout
 *   HTTY  (#session = live Client)
 *     ↓  interrupt() — caller requests graceful HTTY shutdown
 *        → sends GOAWAY to the server; #session stays non-null so that the
 *          server's bytes (including its own GOAWAY response) keep flowing
 *          through the same http/2 client rather than arriving as garbage
 *          in the next session.
 *     ↓  server sends GOAWAY back
 *        → #session is nullified immediately (GOAWAY is the PTY-level close
 *          signal; we cannot close stdin/stdout directly)
 *   TERMINAL  (#session = null, ready for next bootstrap)
 *
 * ── Invariants ────────────────────────────────────────────────────────────
 *
 *   #session !== null  ⟺  HTTY mode is active
 *     classify() routes all PTY bytes as rawData when #session !== null,
 *     and scans for the bootstrap sequence when #session === null.
 *
 *   At most one session at a time.
 *     activate() is only ever called after #session has been nullified, so
 *     there is never a window where two sessions exist simultaneously.
 *
 *   GOAWAY is the close signal.
 *     #session is nullified on the server's GOAWAY (SESSION_STATUS.CLOSING,
 *     phase "goaway"), not when the http/2 session eventually emits "close".
 *     This means server teardown bytes that arrive after GOAWAY (e.g. the
 *     trailing GOAWAY(INTERNAL_ERROR) some servers emit from transport
 *     shutdown) land when #session === null and are treated as terminal text.
 */
export class Handoff {
	#write;            // (chunk: Buffer) => void — write raw bytes to the PTY
	#onSessionState;   // (session, state) => void — http2 session state changed
	#onSessionCreated; // (session, previousSession) => void — new session created
	#onReset;          // () => void — returned to terminal mode after GOAWAY

	#decoder = new BootstrapDecoder();
	#session = null;
	#mode = "terminal";
	#closing = false;
	#frameBuffer = Buffer.alloc(0);

	constructor({write, onSessionState, onSessionCreated, onReset} = {}) {
		this.#write = write;
		this.#onSessionState = onSessionState;
		this.#onSessionCreated = onSessionCreated;
		this.#onReset = onReset;
	}

	// ── State ──────────────────────────────────────────────────────────────

	// true when a remote server is connected (#session !== null).
	get isActive() { return this.#session !== null; }
	get mode() { return this.#mode; }
	get session() { return this.#session; }

	// ── Data classification ────────────────────────────────────────────────

	/**
	 * Classify a raw chunk from the PTY.
	 *
	 * When a session is live: all bytes → rawData (bypass bootstrap scanner).
	 * When no session:        bytes go through BootstrapDecoder to find bootstrap.
	 */
	classify(data) {
		return classifyTerminalData({data, decoder: this.#decoder, httyActive: this.#session !== null});
	}
	
	handleChunk(chunk) {
		if (!this.#session) {
			return {forwardedData: null, terminalData: chunk};
		}
		
		const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "latin1");
		this.#frameBuffer = this.#frameBuffer.length > 0 ? Buffer.concat([this.#frameBuffer, data]) : data;
		
		const frames = [];
		let offset = 0;
		
		while (offset + 9 <= this.#frameBuffer.length) {
			const length = (this.#frameBuffer[offset] << 16) | (this.#frameBuffer[offset + 1] << 8) | this.#frameBuffer[offset + 2];
			const type = this.#frameBuffer[offset + 3];
			const streamId = this.#frameBuffer.readUInt32BE(offset + 5) & 0x7fffffff;
			const frameEnd = offset + 9 + length;
			
			if (frameEnd > this.#frameBuffer.length) {
				break;
			}
			
			if (type === 0x07 && streamId === 0) {
				const session = this.#session;
				const forwardedData = frames.length > 0 ? Buffer.concat(frames) : Buffer.alloc(0);
				const terminalData = this.#frameBuffer.subarray(frameEnd);
				
				if (forwardedData.length > 0) {
					session.handleChunk(forwardedData);
				}
				
				this.#resetSession(session);
				
				return {forwardedData, terminalData};
			}
			
			frames.push(this.#frameBuffer.subarray(offset, frameEnd));
			offset = frameEnd;
		}
		
		this.#frameBuffer = this.#frameBuffer.subarray(offset);
		const forwardedData = frames.length > 0 ? Buffer.concat(frames) : null;
		
		if (forwardedData) {
			this.#session.handleChunk(forwardedData);
		}
		
		return {forwardedData, terminalData: null};
	}

	// ── Transitions ────────────────────────────────────────────────────────

	/**
	 * Activate HTTY mode after a bootstrap sequence has been detected.
	 * Precondition: #session === null (called only from terminal mode).
	 */
	activate() {
		this.#mode = "htty";
		this.#closing = false;
		this.#frameBuffer = Buffer.alloc(0);
		this.#createSession();
		this.#session.start();
		return this.#session;
	}

	/**
	 * Send GOAWAY to the server — that's all.
	 *
	 * The GOAWAY frame is written directly to the PTY as raw bytes. The http/2
	 * client session is intentionally left alive so it can still receive and
	 * process the server's GOAWAY response through the normal data path.
	 * #session is nullified by the state handler when the server's GOAWAY
	 * arrives, which is the only correct moment to restore terminal mode.
	 *
	 * Bypassing Client.close() is deliberate: close() destroys the
	 * session immediately (Node.js http2 tears down the socket on close()), so
	 * the server's GOAWAY would arrive on a destroyed transport and be silently
	 * dropped — leaving #session non-null indefinitely.
	 */
	interrupt() {
		if (this.#session) {
			if (this.#closing) {
				return;
			}
			
			this.#closing = true;
			try { this.#write?.(GOAWAY_NO_ERROR_FRAME); } catch { /* ignore */ }
		}
	}

	/**
	 * UI-driven mode switch. Switching to terminal is blocked while a session
	 * is live (would conflict with the active http/2 transport).
	 */
	setMode(mode) {
		const next = mode === "htty" ? "htty" : "terminal";
		if (next === "terminal" && this.#session !== null) {
			return this.#mode;
		}

		this.#mode = next;
		return this.#mode;
	}

	/**
	 * Hard close — called when the entire session (tab/window) is being torn
	 * down. Destroys the session immediately without a GOAWAY exchange (the
	 * process is about to be killed anyway).
	 */
	close() {
		const session = this.#session;
		this.#session = null;
		this.#mode = "terminal";
		this.#closing = false;
		this.#frameBuffer = Buffer.alloc(0);
		try { session?.client?.destroy(); } catch { /* ignore */ }
		try { session?.transport?.destroy(); } catch { /* ignore */ }
	}

	// ── Private ────────────────────────────────────────────────────────────

	#createSession() {
		const previousSession = this.#session;

		const session = new Client((chunk) => {
			this.#write?.(chunk);
		});

		this.#session = session;
		this.#onSessionCreated?.(session, previousSession);

		session.on("state", (state) => {
			this.#onSessionState?.(session, state);

			// The server's GOAWAY is the PTY-level connection close signal.
			// Null the session immediately so any bytes arriving after this
			// (including the server's transport teardown) are terminal text,
			// not fed to a stale http/2 client.
			if (state.status === SESSION_STATUS.CLOSING && state.phase === "goaway") {
				if (this.#session === session) {
					this.#resetSession(session);
				}
				return;
			}

			// Fallback: session closed or errored without a prior GOAWAY
			// (e.g. transport EOF when the process exits, or a protocol error).
			if (state.status === SESSION_STATUS.CLOSED || state.status === SESSION_STATUS.ERROR) {
				if (this.#session === session) {
					this.#resetSession(session);
				}
			}
		});

		return session;
	}
	
	#resetSession(session) {
		this.#session = null;
		this.#mode = "terminal";
		this.#closing = false;
		this.#frameBuffer = Buffer.alloc(0);
		try { session.client?.destroy(); } catch { /* ignore */ }
		this.#onReset?.();
	}
}
