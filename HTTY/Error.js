export class HTTYError extends Error {
}

export class UnsupportedError extends HTTYError {
}

export class DisabledError extends UnsupportedError {
}

export function assertSupportedEnvironment(env = process.env, stderr = process.stderr) {
	switch (env?.HTTY) {
		case "0":
			throw new DisabledError("HTTY is disabled!");
		case undefined:
			stderr?.write?.("HTTY is not supported by this environment, visit https://htty.dev for more information.\n");
			throw new UnsupportedError("HTTY is not supported by this environment");
		default:
			return;
	}
}
