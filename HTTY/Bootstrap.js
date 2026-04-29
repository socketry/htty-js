const ESC = "\u001b";
const DCS = `${ESC}P`;
const ST = `${ESC}\\`;

export const HTTY_BOOTSTRAP_IDENTIFIER = Object.freeze({
	intermediates: "+",
	final: "H",
});

function decodeBootstrapPayload(data) {
	const normalizedMode = String(data ?? "").trim().toLowerCase();
	return normalizedMode === "raw" ? {mode: "raw"} : null;
}

export function encodeBootstrap() {
	return `${DCS}${HTTY_BOOTSTRAP_IDENTIFIER.intermediates}${HTTY_BOOTSTRAP_IDENTIFIER.final}raw${ST}`;
}

export function decodeBootstrap(data) {
	return decodeBootstrapPayload(data);
}

export class BootstrapDecoder {
	constructor() {
		this.buffer = "";
	}

	push(chunk) {
		this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1");

		let plainText = "";
		let beforeBootstrap = "";
		let afterBootstrap = "";
		const bootstraps = [];
		let cursor = 0;
		let sawBootstrap = false;

		while (cursor < this.buffer.length) {
			const start = this.buffer.indexOf(DCS, cursor);

			if (start === -1) {
				const trailing = this.buffer.slice(cursor);
				plainText += trailing;
				if (sawBootstrap) {
					afterBootstrap += trailing;
				} else {
					beforeBootstrap += trailing;
				}
				this.buffer = "";
				return {plainText, beforeBootstrap, afterBootstrap, bootstraps};
			}

			const segment = this.buffer.slice(cursor, start);
			plainText += segment;
			if (sawBootstrap) {
				afterBootstrap += segment;
			} else {
				beforeBootstrap += segment;
			}

			const end = this.buffer.indexOf(ST, start + DCS.length);
			if (end === -1) {
				this.buffer = this.buffer.slice(start);
				return {plainText, beforeBootstrap, afterBootstrap, bootstraps};
			}

			const payload = this.buffer.slice(start + DCS.length, end);
			const bootstrap = this.#decodeBootstrap(payload);
			if (bootstrap) {
				bootstraps.push(bootstrap);
				sawBootstrap = true;
			} else {
				const literal = this.buffer.slice(start, end + ST.length);
				plainText += literal;
				if (sawBootstrap) {
					afterBootstrap += literal;
				} else {
					beforeBootstrap += literal;
				}
			}

			cursor = end + ST.length;
		}

		this.buffer = "";
		return {plainText, beforeBootstrap, afterBootstrap, bootstraps};
	}

	#decodeBootstrap(payload) {
		const identifier = `${HTTY_BOOTSTRAP_IDENTIFIER.intermediates}${HTTY_BOOTSTRAP_IDENTIFIER.final}`;
		if (!payload.startsWith(identifier)) {
			return null;
		}

		return decodeBootstrap(payload.slice(identifier.length));
	}
}
