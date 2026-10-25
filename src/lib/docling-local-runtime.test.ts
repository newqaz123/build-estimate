import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url);

/** True when `command` can be spawned on this machine (not ENOENT). */
function commandAvailable(command: string, args: string[]): boolean {
	const result = spawnSync(command, args, { stdio: "ignore" });
	return !result.error;
}

/**
 * The reuse tests drive scripts/dev-docling.sh, which needs bash, lsof and
 * curl. Skip (rather than fail) on machines without them, e.g. minimal
 * Linux containers or Windows without Git Bash.
 */
const missingScriptTools = [
	["bash", ["-c", "true"]],
	["lsof", ["-v"]],
	["curl", ["--version"]],
].filter(([command, args]) => !commandAvailable(command as string, args as string[]))
	.map(([command]) => command as string);
const scriptToolsSkip = missingScriptTools.length > 0
	? `requires ${missingScriptTools.join(", ")} (not available on this machine)`
	: false;

/**
 * Launch a real temporary HTTP server as a separate Node child process on a
 * random localhost port. Returns helpers to run the script against it and to
 * tear it down. No new dependency — uses node:child_process and node:events.
 */
async function withFakeServer(
	payload: Record<string, string>,
	action: (port: number) => Promise<void>,
): Promise<void> {
	// The child prints its chosen port to stdout, then serves the payload.
	const child = spawn("node", ["-e", `
		const http = require("http");
		const server = http.createServer((req, res) => {
			if (req.url === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(${JSON.stringify(JSON.stringify(payload))});
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		server.listen(0, "127.0.0.1", () => {
			process.stdout.write(String(server.address().port));
		});
		process.on("SIGTERM", () => { server.close(); process.exit(0); });
	`]);

	let portBuf = "";
	child.stdout.on("data", (chunk: Buffer) => { portBuf += chunk.toString(); });

	try {
		// Wait for the child to print its port.
		await once(child.stdout, "readable");
		const port = Number.parseInt(portBuf, 10);
		assert.ok(Number.isInteger(port) && port > 0, "child must print a valid port");

		await action(port);
	} finally {
		child.kill("SIGTERM");
	}
}

/**
 * Run scripts/dev-docling.sh against the given port with a definitely-missing
 * uvicorn, proving healthy reuse happens before the executable check.
 * Resolves with { code, stdout, stderr }.
 */
function runScript(port: number): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["scripts/dev-docling.sh"], {
			env: {
				...process.env,
				DOCLING_PORT: String(port),
				DOCLING_UVICORN: "/definitely/missing/uvicorn",
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.on("close", (code: number | null) => {
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

test("local Docling command and example endpoint use the application default port", () => {
	const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
		scripts?: Record<string, string>;
	};
	const envExample = readFileSync(".env.example", "utf8");
	const devDoclingScript = readFileSync("scripts/dev-docling.sh", "utf8");

	assert.equal(
		packageJson.scripts?.["dev:docling"],
		"bash scripts/dev-docling.sh",
	);
	assert.match(devDoclingScript, /DOCLING_HOST:-127\.0\.0\.1/);
	assert.match(devDoclingScript, /DOCLING_PORT:-5001/);
	assert.match(devDoclingScript, /\/health/);
	assert.match(
		devDoclingScript,
		/--app-dir py-sidecar main:app --host "\$HOST" --port "\$PORT"/,
	);
	assert.match(envExample, /^DOCLING_ENDPOINT=http:\/\/localhost:5001$/m);

	// The reuse path must validate Docling identity, not just HTTP 2xx.
	assert.match(devDoclingScript, /"parser":"docling"/);
	assert.match(devDoclingScript, /"status":"ok"/);

	// Healthy-process reuse must appear before the venv-executable guard,
	// so a valid running sidecar can be reused even without a local venv.
	const reuseIdx = devDoclingScript.indexOf("already running");
	const venvCheckIdx = devDoclingScript.indexOf('! -x "$UVICORN"');
	assert.ok(
		reuseIdx > -1 && venvCheckIdx > -1 && reuseIdx < venvCheckIdx,
		"healthy reuse must precede the uvicorn executable check",
	);
});

test("identity-checked reuse: both markers present exits 0", { skip: scriptToolsSkip }, async () => {
	await withFakeServer({ status: "ok", parser: "docling" }, async (port) => {
		const result = await runScript(port);
		assert.equal(result.code, 0, `expected exit 0; stderr: ${result.stderr}`);
		assert.match(result.stdout, /already running/);
	});
});

test("identity-checked reuse: status-only marker is rejected (exit 48)", { skip: scriptToolsSkip }, async () => {
	await withFakeServer({ status: "ok", parser: "other" }, async (port) => {
		const result = await runScript(port);
		assert.equal(result.code, 48, `expected exit 48; stdout: ${result.stdout}`);
		assert.match(result.stderr, /not healthy Docling/);
	});
});

test("identity-checked reuse: parser-only marker is rejected (exit 48)", { skip: scriptToolsSkip }, async () => {
	await withFakeServer({ status: "bad", parser: "docling" }, async (port) => {
		const result = await runScript(port);
		assert.equal(result.code, 48, `expected exit 48; stdout: ${result.stdout}`);
		assert.match(result.stderr, /not healthy Docling/);
	});
});
