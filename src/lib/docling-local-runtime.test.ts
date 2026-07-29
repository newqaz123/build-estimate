import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
	assert.match(devDoclingScript, /HOST="127\.0\.0\.1"/);
	assert.match(devDoclingScript, /PORT="5001"/);
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
