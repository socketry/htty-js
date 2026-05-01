import {EventEmitter} from "node:events";
import {StringDecoder} from "node:string_decoder";

import {SESSION_STATUS} from "../HTTY.js";
import {Handoff} from "./Handoff.js";

/**
 * Core terminal session — process-agnostic, Electron-free.
 *
 * Owns the process lifecycle (via an injected handle), data classification,
 * and the HTTY handoff state machine. Emits events for the UI layer to respond
 * to without creating any direct dependency on it.
 *
 * ── Events ────────────────────────────────────────────────────────────────
 *
 *   "terminal-data"          (text: string)        plain-text PTY output
 *   "state"                  (state: object)       inner http/2 session state changed
 *   "attached"               ()                    HTTY client is ready
 *   "detached"               ()                    returned to terminal mode
 *   "title"                  (title: string)       session title changed
 *   "reset"                  ()                    HTTY mode reset back to terminal
 *   "snapshot"               ()                    any snapshot-visible field changed
 *   "exit"                   ({exitCode, signal})  process exited
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
 * isHttyActive() / mode
 *   - isHttyActive() === true  ⟹  HTTY transport is active; PTY bytes go
 *     directly to the http/2 client. Terminal input is blocked.
 *   - isHttyActive() === false ⟹  terminal mode; PTY bytes are decoded for
 *     bootstrap detection and plain-text display.
 *
 * sendInterrupt() dispatch rules
 *   - isHttyActive() === true  →  send GOAWAY to the HTTY server
 *   - otherwise               →  write Ctrl+C (0x03) to process stdin
 *
 * "snapshot" emission contract
 *   - Emitted after any change to a field that snapshot() reads:
 *     title, state, mode, exitInfo.
 *   - Listeners must treat it as a hint to re-read snapshot(), not as a diff.
 */
export class Session extends EventEmitter {
	#process;
	#handoff;
	#terminalDecoder = new StringDecoder("utf8");

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
		this.state = {status: SESSION_STATUS.IDLE};
		this.exitInfo = null;

		this.#handoff = new Handoff({
			write: (chunk) => this.#process?.write(chunk),
			onSessionCreated: (session, prev) => this.#onHttySessionCreated(session, prev),
			onSessionState: (session, state) => this.#onHttySessionState(session, state),
			onReset: () => this.#onHttyReset(),
		});

		this.#attachProcessListeners();
	}

	// ── Public state accessors ─────────────────────────────────────────────

	get client() { return this.#handoff.session; }
	get mode() { return this.#handoff.mode; }

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
			state: {...this.state},
			mode: this.#handoff.mode,
			exitInfo: this.exitInfo,
			isActive,
		};
	}

	// ── State updates ──────────────────────────────────────────────────────

	updateState(state) {
		this.state = {...state};
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

	isHttyActive() {
		return this.#handoff.isActive;
	}

	setMode(mode) {
		const prev = this.#handoff.mode;
		this.#handoff.setMode(mode);
		const next = this.#handoff.mode;

		if (prev !== next) {
			this.emit("snapshot");
		}

		return next;
	}

	// ── Input & interrupts ─────────────────────────────────────────────────

	sendInput(data) {
		if (this.#handoff.mode === "htty") return false;
		this.#process?.write(data);
		return true;
	}

	sendInterrupt() {
		if (!this.#process) {
			return false;
		}

		if (this.#handoff.isActive) {
			// Send GOAWAY while keeping the client alive long enough to receive
			// the server's GOAWAY response and restore terminal mode cleanly.
			this.#handoff.interrupt();
			this.emit("snapshot");
			return true;
		}

		this.#process.write("\u0003");
		return true;
	}

	resize(cols, rows) {
		this.#process?.resize(cols, rows);
	}

	close() {
		this.#handoff.close();

		if (this.#process) {
			const proc = this.#process;
			this.#process = null;
			proc.kill();
		}
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
		const {plainText, rawData, activateRaw} = this.#handoff.classify(data);

		if (plainText) {
			this.emit("terminal-data", this.#terminalDecoder.write(Buffer.from(plainText, "latin1")));
		}

		if (activateRaw) {
			const trailing = this.#terminalDecoder.end();
			if (trailing) {
				this.emit("terminal-data", trailing);
			}
			this.#handoff.activate();
		}

		if (rawData) {
			const {forwardedData, terminalData} = this.#handoff.handleChunk(rawData);
			
			if (terminalData?.length) {
				this.emit("terminal-data", this.#terminalDecoder.write(Buffer.from(terminalData)));
			}
		}
	}

	#handleProcessExit(exitCode, signal) {
		this.exitInfo = {exitCode, signal};
		this.#handoff.close();
		this.#process = null;

		this.emit("exit", {exitCode, signal});
		this.emit("snapshot");
	}

	// ── Handoff callbacks ──────────────────────────────────────────────────

	#onHttySessionCreated(_session, _previousSession) {
	}

	#onHttySessionState(_session, state) {
		this.updateState(state);

		if (state.status === SESSION_STATUS.ATTACHED && state.phase === "ready") {
			this.emit("attached");
		}
	}

	#onHttyReset() {
		if (!this.#process) return;

		this.emit("detached");
		this.emit("reset");
		this.emit("snapshot");
	}
}
