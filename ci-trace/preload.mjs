/**
 * Build-time tracing for every repo that runs on this image, with no code in
 * the repo itself. The image sets NODE_OPTIONS=--import=<this file>, so it
 * loads before the repo's ci/builder entry point.
 *
 * Runs for every build on this image, no per-repo switch. It wraps
 * child_process.spawn and records a span for each docker build / push / pull /
 * run / compose and gsutil call, then exports one trace for the
 * whole build when node is about to exit. A process that ran none of those
 * commands (any other node script in the image) exports nothing.
 *
 * Env:
 *   CI_TRACE_OTLP_ENDPOINT        collector base url. Set in the Dockerfile for
 *                                 everyone; empty = off everywhere.
 *   CI_TRACE_OTLP_TOKEN           bearer token. If unset, read from Secret Manager:
 *   CI_TRACE_OTLP_TOKEN_SECRET    secret name, default otel-ingress-bearer-token
 *   CI_TRACE_SERVICE_NAME         default REPO_NAME
 *   CI_TRACE_EXPORT_TIMEOUT_MS    default 10000
 * Root span attributes come from the usual Cloud Build env: BUILD_ID,
 * PROJECT_ID, REPO_NAME, BRANCH_NAME, COMMIT_SHA.
 *
 * Span names/attributes are built from a few parsed fields (subcommand,
 * --target, tags, image) and never from raw argv: builders pass secrets as
 * --build-arg values.
 *
 * Every node process in the image loads this file, so nothing here may throw.
 */

import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
import { promisify } from "node:util";
import { createBuildTrace } from "./BuildTrace.mjs";

const env = process.env;

/** Value of `--flag value` or `--flag=value`, for every occurrence. */
const flagValues = (args, ...flags) => args.flatMap((arg, i) => {
	if (flags.includes(arg)) {
		return args[i + 1] === undefined ? [] : [ args[i + 1] ];
	}
	const flag = flags.find((f) => arg.startsWith(`${f}=`));
	return flag ? [ arg.slice(flag.length + 1) ] : [];
});

/**
 * Which spawned commands become spans, and what they're called.
 * @returns {{ name: string, attributes: Record<string, string> } | null}
 */
export const describeCommand = (command, args) => {
	const program = basename(String(command));

	if (program === "docker") {
		// `docker buildx build` is the same as `docker build` for our purposes
		const rest = args[0] === "buildx" ? args.slice(1) : args;
		const subcommand = rest[0];
		switch (subcommand) {
			case "build": {
				const target = flagValues(rest, "--target")[0];
				const tags = flagValues(rest, "--tag", "-t");
				return {
					name: `docker build ${target ?? tags[0] ?? ""}`.trim(),
					attributes: { "docker.target": target, "docker.tags": tags.join(" ") },
				};
			}
			case "push":
			case "pull": {
				const image = rest.at(-1);
				return { name: `docker ${subcommand} ${image}`, attributes: { "docker.image": image } };
			}
			case "run": {
				const container = flagValues(rest, "--name")[0];
				return { name: `docker run ${container ?? ""}`.trim(), attributes: { "docker.container": container } };
			}
			case "compose": {
				const action = rest.slice(1).find((arg) => !arg.startsWith("-"));
				return { name: `docker compose ${action ?? ""}`.trim(), attributes: {} };
			}
			default:
				return null;
		}
	}

	if (program === "gsutil") {
		const action = args.find((arg) => !arg.startsWith("-"));
		return { name: `gsutil ${action ?? ""}`.trim(), attributes: {} };
	}

	return null;
};

const readTokenFromSecretManager = async () => {
	const secret = env.CI_TRACE_OTLP_TOKEN_SECRET || "otel-ingress-bearer-token";
	try {
		const { stdout } = await promisify(childProcess.execFile)(
			"gcloud",
			[ "secrets", "versions", "access", "latest", `--secret=${secret}` ],
			{ timeout: 15000 },
		);
		return stdout.trim();
	}
	catch (error) {
		console.warn(`ci-trace: couldn't read secret ${secret}; exporting without a token`, error.message);
		return undefined;
	}
};

const start = () => {
	// children (e.g. a node script the builder spawns) inherit NODE_OPTIONS;
	// they're part of this build's trace already, so they stay inert
	env.CI_TRACE_ACTIVE = "1";

	const trace = createBuildTrace({
		name: `ci build ${env.REPO_NAME ?? ""}@${env.BRANCH_NAME ?? ""}`,
		endpoint: env.CI_TRACE_OTLP_ENDPOINT,
		traceId: env.BUILD_ID,
		serviceName: env.CI_TRACE_SERVICE_NAME || env.REPO_NAME || "ci-builder",
		timeoutMs: parseInt(env.CI_TRACE_EXPORT_TIMEOUT_MS, 10),
		attributes: {
			"ci.system": "cloud-build",
			"ci.build.id": env.BUILD_ID,
			"ci.project.id": env.PROJECT_ID,
			"vcs.repository.name": env.REPO_NAME,
			"vcs.ref.head.name": env.BRANCH_NAME,
			"vcs.ref.head.revision": env.COMMIT_SHA,
		},
	});

	let recordedSpans = 0;
	const originalSpawn = childProcess.spawn;
	childProcess.spawn = function (command, args, ...rest) {
		const child = originalSpawn.call(this, command, args, ...rest);
		try {
			const described = describeCommand(command, Array.isArray(args) ? args.map(String) : []);
			if (described) {
				recordedSpans++;
				const span = trace.startSpan(described.name, described.attributes);
				child.once("error", (error) => span.end({ error: true, message: error.message }));
				child.once("exit", (code, signal) => span.end({
					error: code !== 0,
					attributes: { "process.exit_code": code ?? undefined, "process.signal": signal ?? undefined },
				}));
			}
		}
		catch (error) {
			console.warn("ci-trace: failed to record span", error);
		}
		return child;
	};
	// make `import { spawn } from "node:child_process"` see the wrapper too
	syncBuiltinESMExports();

	// beforeExit (not exit) because export is async. The builders set
	// process.exitCode rather than calling process.exit(), so this fires.
	let exporting = false;
	process.on("beforeExit", async () => {
		if (exporting || recordedSpans === 0) {
			return;
		}
		exporting = true;
		const bearerToken = env.CI_TRACE_OTLP_TOKEN || await readTokenFromSecretManager();
		await trace.flush(process.exitCode ? "failure" : "success", { bearerToken });
	});
};

if (env.CI_TRACE_OTLP_ENDPOINT && !env.CI_TRACE_ACTIVE) {
	try {
		start();
	}
	catch (error) {
		console.warn("ci-trace: disabled, failed to start", error);
	}
}
