import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);

let packageRoot;

try {
	packageRoot = path.dirname(require.resolve("node-pty/package.json"));
} catch {
	process.exit(0);
}

const helper = path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");

if (fs.existsSync(helper)) {
	fs.chmodSync(helper, 0o755);
}
