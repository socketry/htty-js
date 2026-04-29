export const DEFAULT_AUTHORITY = "htty.local";
export const HTTP2_CLIENT_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

export function sanitizePrefaceInput(text) {
	return text
		.replaceAll(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function trimToPotentialPreface(buffer) {
	for (let index = 0; index < buffer.length; index += 1) {
		const suffix = buffer.slice(index);
		if (HTTP2_CLIENT_PREFACE.startsWith(suffix)) {
			return suffix;
		}
	}

	return "";
}

export function normalizeRequestHeaders({path = "/", method = "GET", headers = {}} = {}) {
	const normalized = {
		":method": method.toUpperCase(),
		":path": path,
		":scheme": "http",
		":authority": DEFAULT_AUTHORITY,
	};

	for (const [key, value] of Object.entries(headers)) {
		normalized[String(key).toLowerCase()] = value;
	}

	return normalized;
}

export function sanitizeResponseHeaders(headers) {
	const normalized = {};

	for (const [key, value] of Object.entries(headers)) {
		if (!key.startsWith(":")) {
			normalized[key] = Array.isArray(value) ? value.join(", ") : String(value);
		}
	}

	return normalized;
}

export function normalizeApplicationResponse(response) {
	if (typeof response === "string") {
		return {
			status: 200,
			headers: {"content-type": "text/plain; charset=utf-8"},
			body: response,
		};
	}

	if (response instanceof Uint8Array || Buffer.isBuffer(response)) {
		return {
			status: 200,
			headers: {"content-type": "application/octet-stream"},
			body: response,
		};
	}

	const {
		status = 200,
		headers = {},
		body = "",
	} = response ?? {};

	return {status, headers, body};
}

export function readRequestBody(stream, {encoding = "utf8"} = {}) {
	return new Promise((resolve, reject) => {
		const chunks = [];

		stream.on("data", (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});

		stream.on("end", () => {
			const body = Buffer.concat(chunks);
			resolve(encoding ? body.toString(encoding) : body);
		});

		stream.on("error", reject);
	});
}
