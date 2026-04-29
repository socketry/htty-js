import {EventEmitter} from "node:events";

import {SESSION_STATUS} from "../HTTY.js";
import {Handoff} from "./Handoff.js";
import {terminalChunkPreview} from "./Transport.js";

export const HANDOFF_STATES = Object.freeze({
	TERMINAL: "terminal",
	BOOTSTRAP_DETECTED: "bootstrap-detected",
	CLIENT_NEGOTIATING: "client-negotiating",
	CLIENT_CONNECTED: "client-connected",
	ATTACHED: "attached",
	CLOSING: "closing",
	CLOSED: "closed",
	ERROR: "error",
});

function createDebugState() {
	return {
		chunkCount: 0,
		chunks: [],
		handoff: {
			state: HANDOFF_STATES.TERMINAL,
			lastEvent: "initialized",
			events: [],
		},
		state: {status: SESSION_STATUS.IDLE},
		document: null,
		responseText: "No response yet.",
	};
}

/**
 * Core terminal session — process-agnostic, Electron-free.
 *
 * Owns the process lifecycle (via an injected handle), data classification,
 * the HTTY handoff state machine, and debug state. Emits events for the UI
 * layer to respond to without creating any direct dependency on it.
 *
 * ── Events ────────────────────────────────────────────────────────────────
 *
 *   "terminal-data"          (text: string)        plain-text PTY output
 *   "chunk"                  (chunk: object)       raw HTTY inbound chunk (debug)
 *   "state"                  (state: object)       inner http/2 session state changed
 *   "handoff-state"          (entry: object)       handoff FSM transition recorded
 *   "document"               (payload: object|null)surface document received
 *   "response-text"          (text: string)        debug/preview text changed
 *   "title"                  (title: string)       session title changed
 *   "request-initial-surface"()                    HTTY attached and ready, no surface yet
 *   "reset"                  ()                    HTTY mode reset back to terminal
 *   "snapshot"               ()                    any snapshot-visible field changed
 *   "exit"                   ({exitCode, signal})  process exited
 *   "request-close"          ()                    session requests full UI teardown
 *
 * All events are emitted synchronously (Node.js EventEmitter semantics).
 *
 * ── Process handle interface ──────────────────────────────────────────────
 *
 *   PTY  — { onData(cb), onExit(cb), write(data), resize(cols, rows), kill() }
 *   Pipe — { onStdout(cb), onStderr(cb), onExit(cb), write(data), resize(), kill() }
 *
 * ── Invariants ────────────────────────────────────────────────────────────
 *
 * #process
 *   - Non-null from construction until the process exits or close() is called.
 *   - Set to null in #handleProcessExit() and in close().
 *   - All uses are guarded with optional chaining (#process?.X) so callers
 *     need not check liveness.
 *
 * exitInfo
 *   - null  while the process is alive or before it has been started.
 *   - { exitCode, signal } once #handleProcessExit() has fired. Immutable thereafter.
 *
 * handoffState
 *   - Always reflects the most recent HANDOFF_STATES value recorded via
 *     setHandoffState(). It is a read-only mirror of the handoff FSM for UI.
 *   - The authoritative live state is handoff.isActive / handoff.mode.
 *
 * handoff.isActive / handoff.mode
 *   - handoff.isActive === true  ⟹  raw HTTY transport is active; PTY bytes
 *     go directly to the http/2 client. Terminal input is blocked.
 *   - handoff.isActive === false ⟹  terminal mode; PTY bytes are decoded for
 *     bootstrap detection and plainText display.
 *
 * sendInterrupt() dispatch rules
 *   - showTerminalTab === false  →  emit "request-close" (hidden session teardown)
 *   - handoff.isActive === true  →  handoff.interrupt() (GOAWAY to server)
 *   - otherwise                 →  write Ctrl+C (0x03) to process stdin
 *
 * closeAfterExit / closeSurfacesOnExit
 *   - These flags are set before emitting "exit" or "request-close" so that
 *     listeners (e.g. SessionController) can read them synchronously in their
 *     "exit" handler and decide whether to call close() immediately.
 *
 * debugState.document
 *   - Set exclusively via updateDocument(), which is called by the surface
 *     layer when a document request completes. Never cleared automatically on
 *     HTTY session close — the UI is responsible for clearing it via
 *     updateDocument(null) if needed.
 *
 * "snapshot" emission contract
 *   - Emitted after any change to a field that snapshot() reads:
 *     title, handoffState, debugState.state, mode, exitInfo, document.
 *   - Listeners must treat it as a hint to re-read snapshot(), not as a diff.
 */
export class Session extends EventEmitter {
	#process;

	constructor(process, options = {}) {
		super();

		this.#process = process;
		this.id = options.id;
		this.command = options.command ?? "";
		this.args = options.args ? [...options.args] : [];
		this.cwd = options.cwd ?? "";
		this.usePty = options.usePty !== false;
		this.showTerminalTab = options.showTerminalTab !== false;
		this.title = options.title ?? "";
		this.defaultTitle = options.defaultTitle ?? options.title ?? "";
		this.debugState = createDebugState();
		this.exitInfo = null;
		this.handoffState = HANDOFF_STATES.TERMINAL;
		this.handoffEventCount = 0;
		this.closeAfterExit = false;
		this.closeSurfacesOnExit = false;

		this.handoff = new Handoff({
			write: (chunk) => this.#process?.write(chunk),
			onSessionCreated: (session, prev) => this.#onHttySessionCreated(session, prev),
			onSessionState: (session, state) => this.#onHttySessionState(session, state),
			onReset: () => this.#onHttyReset(),
		});

		this.#attachProcessListeners();
	}

	// ── Backward-compatible accessors ──────────────────────────────────────

	get httySession() { return this.handoff.session; }
	get mode() { return this.handoff.mode; }

	get commandLine() {
		return [this.command, ...this.args].filter(Boolean).join(" ");
	}

	// ── Snapshots ──────────────────────────────────────────────────────────

	snapshot(isActive = false) {
		return {
			id: this.id,
			title: this.title,
			command: this.command,
			commandLine: this.commandLine,
			args: [...this.args],
			cwd: this.cwd,
			showTerminalTab: this.showTerminalTab,
			httyHandoffState: this.handoffState,
			state: {...this.debugState.state},
			mode: this.handoff.mode,
			hasDocument: Boolean(this.debugState.document),
			exitInfo: this.exitInfo,
			isActive,
		};
	}

	snapshotDebugState() {
		return {
			sessionId: this.id,
			title: this.title,
			commandLine: this.commandLine,
			chunkCount: this.debugState.chunkCount,
			chunks: [...this.debugState.chunks],
			handoff: structuredClone(this.debugState.handoff),
			state: {...this.debugState.state},
			mode: this.handoff.mode,
			document: this.debugState.document ? structuredClone(this.debugState.document) : null,
			responseText: this.debugState.responseText,
			exitInfo: this.exitInfo,
		};
	}

	// ── State updates (callable from outside for surface-driven changes) ───

	updateDocument(payload) {
		this.debugState.document = payload ? structuredClone(payload) : null;
		this.emit("document", payload);
		this.emit("snapshot");
	}

	updateResponseText(text) {
		this.debugState.responseText = text;
		this.emit("response-text", text);
	}

	updateState(state) {
		this.debugState.state = {...state};
		this.emit("state", state);
		this.emit("snapshot");
	}

	updateTitle(title) {
		if (this.title === title) return;
		this.title = title;
		this.emit("title", title);
		this.emit("snapshot");
	}

	// ── Mode control ───────────────────────────────────────────────────────

	isRawHttyTransportActive() {
		return this.handoff.isActive;
	}

	setMode(mode) {
		const prev = this.handoff.mode;
		this.handoff.setMode(mode);
		const next = this.handoff.mode;

		if (prev !== next) {
			this.emit("snapshot");
		}

		return next;
	}

	// ── Input & interrupts ─────────────────────────────────────────────────

	sendInput(data) {
		if (this.handoff.mode === "htty") return false;
		this.#process?.write(data);
		return true;
	}

	sendInterrupt() {
		if (!this.#process) {
			return false;
		}

		if (!this.showTerminalTab) {
			this.closeAfterExit = true;
			this.closeSurfacesOnExit = true;
			this.emit("request-close");
			return true;
		}

		if (this.handoff.isActive) {
			// Send GOAWAY — the server calls setRawMode(false) on receipt,
			// restoring ISIG on the PTY so the shell regains normal mode.
			this.handoff.interrupt();
			this.emit("snapshot");
			return true;
		}

		this.#process.write("\u0003");
		return true;
	}

	resize(cols, rows) {
		this.#process?.resize(cols, rows);
	}

	requestInterruptAfterLastSurfaceClosed() {
		this.closeAfterExit = true;
		this.closeSurfacesOnExit = false;

		if (this.exitInfo || !this.#process) return false;

		return this.sendInterrupt();
	}

	close() {
		this.setHandoffState(HANDOFF_STATES.CLOSED, "session-close", {
			hasExitInfo: Boolean(this.exitInfo),
		});

		this.handoff.close();

		if (this.#process) {
			const proc = this.#process;
			this.#process = null;
			proc.kill();
		}
	}

	// ── Handoff state ──────────────────────────────────────────────────────

	setHandoffState(state, event, details = {}) {
		const nextState = state || HANDOFF_STATES.TERMINAL;
		const entry = {
			index: ++this.handoffEventCount,
			state: nextState,
			event,
			...details,
		};

		this.handoffState = nextState;
		this.debugState.handoff.state = nextState;
		this.debugState.handoff.lastEvent = event;
		this.debugState.handoff.events.unshift(entry);

		while (this.debugState.handoff.events.length > 20) {
			this.debugState.handoff.events.pop();
		}

		this.emit("handoff-state", entry);
	}

	// ── Process listener setup ─────────────────────────────────────────────

	#attachProcessListeners() {
		const onData = (data) => this.#handleTerminalData(data);
		const onExit = ({exitCode, signal}) => this.#handleProcessExit(exitCode, signal);

		if (this.usePty) {
			this.#process.onData(onData);
		} else {
			this.#process.onStdout(onData);
			this.#process.onStderr((data) => {
				const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
				this.emit("terminal-data", text);
			});
		}

		this.#process.onExit(onExit);
	}

	// ── Data routing ───────────────────────────────────────────────────────

	#handleTerminalData(data) {
		const {plainText, rawData, activateRaw} = this.handoff.classify(data);

		if (plainText) {
			this.emit("terminal-data", plainText);
		}

		if (activateRaw) {
			this.setHandoffState(HANDOFF_STATES.BOOTSTRAP_DETECTED, "bootstrap-detected", {
				hasExistingHttySession: Boolean(this.handoff.session),
				httyStatus: this.handoff.session?.status ?? SESSION_STATUS.IDLE,
			});
			this.handoff.activate();
		}

		if (rawData) {
			// handoff.session is guaranteed non-null here: classify() only
			// returns rawData when httyActive = (session !== null).
			this.handoff.session.handleChunk(rawData);
			const chunk = {direction: "inbound", ...terminalChunkPreview(rawData, "latin1")};
			this.debugState.chunkCount += 1;
			this.debugState.chunks.unshift(chunk);
			while (this.debugState.chunks.length > 12) this.debugState.chunks.pop();
			this.emit("chunk", chunk);
		}
	}

	#handleProcessExit(exitCode, signal) {
		this.exitInfo = {exitCode, signal};
		this.handoff.close();
		this.#process = null;

		if (!this.showTerminalTab) {
			this.closeAfterExit = true;
		}

		this.emit("exit", {exitCode, signal});
		this.emit("snapshot");
	}

	// ── Handoff callbacks ──────────────────────────────────────────────────

	#onHttySessionCreated(_session, _previousSession) {
		// Subclasses or owners may listen to "handoff-state" for richer logging.
	}

	#onHttySessionState(_session, state) {
		switch (state.status) {
			case SESSION_STATUS.NEGOTIATING:
				this.setHandoffState(HANDOFF_STATES.CLIENT_NEGOTIATING, "client-negotiating", {httyState: state});
				break;
			case SESSION_STATUS.ATTACHED:
				this.setHandoffState(
					state.phase === "ready" ? HANDOFF_STATES.ATTACHED : HANDOFF_STATES.CLIENT_CONNECTED,
					state.phase === "ready" ? "client-ready" : "client-connected",
					{httyState: state},
				);
				break;
			case SESSION_STATUS.CLOSING:
				this.setHandoffState(HANDOFF_STATES.CLOSING, "client-closing", {httyState: state});
				break;
			case SESSION_STATUS.CLOSED:
				this.setHandoffState(HANDOFF_STATES.CLOSED, "client-closed", {httyState: state});
				break;
			case SESSION_STATUS.ERROR:
				this.setHandoffState(HANDOFF_STATES.ERROR, "client-error", {httyState: state});
				break;
		}

		this.updateState(state);

		if (state.status === SESSION_STATUS.ATTACHED && state.phase === "ready" && this.showTerminalTab !== false) {
			this.emit("request-initial-surface");
		}
	}

	#onHttyReset() {
		// Only signal to the UI layer for visible PTY sessions. Hidden demo
		// sessions manage their own teardown.
		if (!this.#process || !this.showTerminalTab) return;

		this.emit("reset");
		this.emit("snapshot");
	}
}
