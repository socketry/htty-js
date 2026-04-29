import {Application} from "../HTTY.js";

const app = ({method, path}) => ({
	status: 200,
	headers: {"content-type": "text/html; charset=utf-8"},
	body: `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>HTTY Browser Demo</title>
		<style>
			:root {
				color-scheme: dark;
				font-family: "Avenir Next", "Helvetica Neue", sans-serif;
			}

			body {
				margin: 0;
				min-height: 100vh;
				padding: 32px;
				background:
					radial-gradient(circle at top left, rgba(253, 160, 133, 0.28), transparent 24%),
					radial-gradient(circle at top right, rgba(246, 211, 101, 0.2), transparent 22%),
					linear-gradient(180deg, #0b1220 0%, #08101b 100%);
				color: #ecf3ff;
			}

			main {
				max-width: 760px;
				padding: 28px;
				border-radius: 28px;
				background: rgba(9, 17, 31, 0.82);
				border: 1px solid rgba(148, 163, 184, 0.18);
				backdrop-filter: blur(24px);
				box-shadow: 0 24px 80px rgba(0, 0, 0, 0.34);
			}

			p {
				color: #9fb0c8;
				line-height: 1.6;
			}

			.badge {
				display: inline-flex;
				padding: 6px 10px;
				border-radius: 999px;
				background: rgba(246, 211, 101, 0.14);
				color: #f6d365;
				letter-spacing: 0.12em;
				text-transform: uppercase;
				font-size: 12px;
			}

			.card {
				margin-top: 24px;
				padding: 18px;
				border-radius: 18px;
				background: rgba(5, 11, 21, 0.92);
				border: 1px solid rgba(148, 163, 184, 0.14);
			}
		</style>
	</head>
	<body>
		<main>
			<div class="badge">HTTY Browser Demo</div>
			<h1>Attached browser surface over a normal terminal session.</h1>
			<p>This page is served by a plain HTTP/2 application running inside the command process. Chimera keeps the terminal visible and mounts this document alongside it once the HTTY session becomes ready.</p>
			<div class="card">
				<strong>Request:</strong> ${method} ${path}
			</div>
		</main>
	</body>
</html>`,
});

Application.open(app);