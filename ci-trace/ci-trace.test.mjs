// Run with: node --test ci-trace/ci-trace.test.mjs
// Also run during the image build (see Dockerfile), so a broken preload never ships.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createBuildTrace } from "./BuildTrace.mjs";
import { buildkitCacheCounter, describeCommand } from "./preload.mjs";

// real `docker build --progress plain` output (trimmed): base 2/2 cached, final 1/2 and 2/2 ran
const BUILDKIT_OUTPUT = `#1 [internal] load build definition from Dockerfile
#1 DONE 0.0s
#5 [base 1/2] FROM docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
#5 DONE 0.0s
#6 [base 2/2] RUN echo one
#6 CACHED
#7 [final 1/2] RUN echo two-8612
#7 0.087 two-8612
#7 DONE 0.1s
#8 [final 2/2] COPY Dockerfile /x
#8 DONE 0.0s
#9 exporting to image
#9 DONE 0.0s
`;

const preload = fileURLToPath(new URL("./preload.mjs", import.meta.url));

const startCollector = async () => {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => body += chunk);
		req.on("end", () => {
			requests.push({ url: req.url, auth: req.headers.authorization, body });
			res.end("{}");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { requests, server, url: `http://127.0.0.1:${server.address().port}` };
};

/** A temp dir with fake docker/gsutil, and a "builder" script that uses them. */
const fakeBuild = () => {
	const dir = mkdtempSync(join(tmpdir(), "ci-trace-"));
	const bin = (name, script) => {
		writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`);
		chmodSync(join(dir, name), 0o755);
	};
	// `docker push` of anything ending in :broken fails
	writeFileSync(join(dir, "buildkit.txt"), BUILDKIT_OUTPUT);
	bin("docker", `
		case "$1 $2" in
			"version --format") echo "27.0.1 27.0.2"; exit 0;;
			"buildx version") echo "github.com/docker/buildx v0.17.1 1234abc"; exit 0;;
		esac
		[ "$1" = build ] && cat "${dir}/buildkit.txt" >&2
		case "$*" in *:broken) exit 1;; esac
		exit 0`);
	bin("gsutil", "exit 0");
	writeFileSync(join(dir, "builder.mjs"), `
		import { spawn } from "node:child_process";
		// read the output like the real builders do (they pipe it to log files)
		const run = (cmd, args) => new Promise((resolve) => {
			const child = spawn(cmd, args);
			child.stdout.resume();
			child.stderr.resume();
			child.on("close", resolve);
		});
		await Promise.all([
			run("docker", [ "build", "--target", "production", "--tag", "repo/frontend:main", "--cache-from", "a", "--cache-from", "b", "--build-arg", "NOVA_LICENSE_KEY=hunter2", "." ]),
			run("docker", [ "build", "--target=production-b2b", "-t", "repo/b2b:main", "--no-cache", "." ]),
		]);
		await run("docker", [ "push", "repo/frontend:broken" ]);
		await run("docker", [ "login", "-u", "x", "-p", "hunter2" ]);
		await run("gsutil", [ "-m", "cp", "log.txt", "gs://bucket/" ]);
		await run("node", [ "-e", "process.exit(0)" ]);
		process.exitCode = 1;
	`);
	return dir;
};

// the fake builder exits 1 on purpose (a failed build), so take the output either way
const runBuild = (dir, extraEnv) => promisify(execFile)("node", [ join(dir, "builder.mjs") ], {
	timeout: 30000,
	env: {
		PATH: `${dir}:${process.env.PATH}`,
		NODE_OPTIONS: `--import=${preload}`,
		BUILD_ID: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
		REPO_NAME: "cubic-test",
		BRANCH_NAME: "main",
		...extraEnv,
	},
}).catch((error) => {
	assert.equal(error.code, 1, `builder should exit 1, got ${error.code}: ${error.stderr}`);
	return error;
});

test("a build exports one trace with a span per docker/gsutil call", async () => {
	const collector = await startCollector();
	const { stdout } = await runBuild(fakeBuild(), { CI_TRACE_OTLP_ENDPOINT: `${collector.url}/otlp/`, CI_TRACE_OTLP_TOKEN: "baked-token" });
	collector.server.close();

	assert.match(stdout, /ci-trace: exported 5 spans/);
	assert.equal(collector.requests.length, 1, "child node process must not export its own trace");
	const { url, auth, body } = collector.requests[0];
	assert.equal(url, "/otlp/v1/traces");
	assert.equal(auth, "Bearer baked-token");
	assert.ok(!body.includes("hunter2"), "raw argv (build args, passwords) must never be exported");

	const payload = JSON.parse(body);
	const [ resource ] = payload.resourceSpans;
	assert.deepEqual(resource.resource.attributes.find((a) => a.key === "service.name").value, { stringValue: "cubic-test" });

	const spans = resource.scopeSpans[0].spans;
	const byName = Object.fromEntries(spans.map((span) => [ span.name, span ]));
	assert.deepEqual(Object.keys(byName).sort(), [
		"ci build cubic-test@main",
		"docker build production",
		"docker build production-b2b",
		"docker push repo/frontend:broken",
		"gsutil cp",
	]);
	const root = byName["ci build cubic-test@main"];
	assert.equal(root.traceId, "0a1b2c3d4e5f60718293a4b5c6d7e8f9");
	assert.equal(root.status.code, 2, "exitCode 1 marks the build failed");
	assert.equal(byName["docker build production"].parentSpanId, root.spanId);
	assert.equal(byName["docker build production"].status.code, 1);
	assert.equal(byName["docker push repo/frontend:broken"].status.code, 2);
	for (const span of spans) {
		assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
	}

	const attrs = (span) => Object.fromEntries(span.attributes.map(({ key, value }) => [ key, Object.values(value)[0] ]));
	const production = attrs(byName["docker build production"]);
	assert.equal(production["docker.cache_from.count"], "2");
	assert.equal(production["docker.no_cache"], false);
	assert.equal(production["docker.builder"], "buildkit");
	assert.equal(production["docker.cache.steps.cached"], "1");
	assert.equal(production["docker.cache.steps.total"], "3");
	assert.equal(attrs(byName["docker build production-b2b"])["docker.no_cache"], true);

	const rootAttrs = attrs(root);
	assert.equal(rootAttrs["docker.cache.steps.cached"], "2", "totals across both builds");
	assert.equal(rootAttrs["docker.cache.steps.total"], "6");
	assert.equal(rootAttrs["docker.cache.hit_ratio"], 2 / 6);
	assert.equal(rootAttrs["docker.client.version"], "27.0.1");
	assert.equal(rootAttrs["docker.server.version"], "27.0.2");
	assert.equal(rootAttrs["docker.buildx.version"], "v0.17.1");
	assert.equal(rootAttrs["process.runtime.version"], process.version);
	assert.ok(Number(rootAttrs["host.cpu.count"]) > 0);
	assert.equal(rootAttrs["host.name"], hostname());
	assert.ok(Number(rootAttrs["host.memory.total_bytes"]) > 0);
});

test("inert with no endpoint", async () => {
	const { stdout, stderr } = await runBuild(fakeBuild(), {});
	assert.doesNotMatch(stdout + stderr, /ci-trace/);
});

test("a node process that runs no docker/gsutil exports nothing", async () => {
	const collector = await startCollector();
	await promisify(execFile)("node", [ "-e", "1" ], {
		env: { ...process.env, NODE_OPTIONS: `--import=${preload}`, CI_TRACE_OTLP_ENDPOINT: collector.url, CI_TRACE_ACTIVE: "" },
	});
	collector.server.close();
	assert.equal(collector.requests.length, 0);
});

test("cache counter handles output split mid-line", () => {
	const counter = buildkitCacheCounter();
	for (let i = 0; i < BUILDKIT_OUTPUT.length; i += 7) {
		counter.write(BUILDKIT_OUTPUT.slice(i, i + 7));
	}
	assert.deepEqual(counter.result(), { cached: 1, total: 3 });
});

test("describeCommand ignores commands we don't time", () => {
	assert.equal(describeCommand("docker", [ "login", "-p", "secret" ]), null);
	assert.equal(describeCommand("curl", [ "https://api.github.com" ]), null);
	assert.equal(describeCommand("/usr/bin/docker", [ "buildx", "build", "--target", "x", "." ]).name, "docker build x");
});

test("unreachable collector or bad config never throws", async () => {
	for (const endpoint of [ "http://127.0.0.1:1", "not a url" ]) {
		const trace = createBuildTrace({ name: "x", endpoint, timeoutMs: NaN });
		trace.startSpan("a");
		await trace.flush("success");
	}
});
