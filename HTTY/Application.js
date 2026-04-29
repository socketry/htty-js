import {assertSupportedEnvironment} from "./Error.js";
import {normalizeApplicationResponse, readRequestBody} from "./HTTP.js";
import {Server} from "./Server.js";

export class Application {
	constructor(app, {requestEncoding = "utf8", ...options} = {}) {
		this.app = app;
		this.requestEncoding = requestEncoding;
		this.server = new Server(this.handleStream.bind(this), options);
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

	static open(app, {env = process.env, stderr = process.stderr, ...options} = {}) {
		assertSupportedEnvironment(env, stderr);
		const application = new Application(app, options);
		application.start();
		return application;
	}
}
