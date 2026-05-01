import {normalizeApplicationResponse, readRequestBody} from "./HTTP.js";
import {Server} from "./Server.js";

/**
 * Small request/response adapter on top of Server.
 *
 * Applications receive normalized method/path/header/body fields and return a
 * response object. This is convenience API only; HTTY itself still carries
 * ordinary HTTP/2 streams.
 */
export class Application {
	constructor(app, {requestEncoding = "utf8", transport, onClose} = {}) {
		this.app = app;
		this.requestEncoding = requestEncoding;
		this.server = new Server(this.handleStream.bind(this), {transport, onClose});
	}

	async handleStream(stream, headers) {
		const body = await readRequestBody(stream, {encoding: this.requestEncoding});
		const response = normalizeApplicationResponse(await this.app({
			method: String(headers[":method"] || "GET"),
			path: String(headers[":path"] || "/"),
			headers,
			body,
			stream,
			session: stream.session,
		}));

		stream.respond({
			":status": response.status,
			...response.headers,
		});

		stream.end(response.body);
	}

	start() {
		return this.server.start();
	}

	close(options) {
		return this.server.close(options);
	}

	get session() {
		return this.server.session;
	}

	static open(app, {requestEncoding = "utf8", ...options} = {}) {
		const application = Object.create(Application.prototype);
		application.app = app;
		application.requestEncoding = requestEncoding;
		application.server = Server.open(application.handleStream.bind(application), options);
		return application;
	}
}
