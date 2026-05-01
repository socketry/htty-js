import {Application} from "../HTTY.js";

const app = ({method, path}) => ({
	status: 200,
	headers: {"content-type": "text/html; charset=utf-8"},
	body: `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>HTTY Styled Browser Demo</title>
		<style>
			:root {
				color-scheme: dark;
				font-family: "Iowan Old Style", "Palatino Linotype", serif;
			}

			body {
				margin: 0;
				min-height: 100vh;
				padding: 32px;
				background:
					linear-gradient(135deg, rgba(255, 163, 102, 0.18), transparent 40%),
					linear-gradient(225deg, rgba(125, 211, 252, 0.16), transparent 36%),
					#07111c;
				color: #eef6ff;
			}

			main {
				max-width: 820px;
				padding: 32px;
				border-radius: 24px;
				background: rgba(8, 16, 28, 0.86);
				border: 1px solid rgba(148, 163, 184, 0.18);
				box-shadow: 0 28px 90px rgba(0, 0, 0, 0.34);
			}

			.badge {
				display: inline-flex;
				padding: 6px 11px;
				border-radius: 999px;
				background: rgba(125, 211, 252, 0.14);
				color: #7dd3fc;
				font: 600 12px/1.2 "IBM Plex Sans", sans-serif;
				letter-spacing: 0.1em;
				text-transform: uppercase;
			}

			code {
				font-family: "IBM Plex Mono", monospace;
				font-size: 0.95rem;
				color: #f7c59f;
			}
		</style>
	</head>
	<body>
		<main>
			<div class="badge">HTTY Styled Demo</div>
			<h1>The terminal session switched from DCS bootstrap to plain h2c bytes.</h1>
			<p>This demo page was served after the process emitted a DCS bootstrap and handed the terminal connection over to HTTY transport.</p>
			<p><strong>Request:</strong> <code>${method} ${path}</code></p>
		</main>
	</body>
</html>`,
});

Application.open(app);
