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
 * Besides timings, the root span carries what the build ran on (machine,
 * cloud location, tool versions; see environment.mjs) and BuildKit cache hit
 * totals. Each docker build span carries its cache flags and cache hits.
 *
 * Env:
 *   CI_TRACE_OTLP_ENDPOINT        collector base url. Set in the Dockerfile for
 *                                 everyone; empty = off everywhere.
 *   CI_TRACE_OTLP_TOKEN           bearer token, baked into the image at build time so
 *                                 builds in client infra can report too. It can only
 *                                 write traces; rotate it by rebuilding the image.
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
import { createBuildTrace } from "./BuildTrace.mjs";
import { collectEnvironment } from "./environment.mjs";

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
 * Counts Dockerfile steps in BuildKit `--progress plain` output that were
 * CACHED vs actually run. Step lines look like `#6 [base 2/2] RUN echo one`
 * and are followed by `#6 CACHED`, or by `#6 DONE 0.1s` / `#6 ERROR ...` when
 * they ran. FROM always reports DONE, so it isn't counted.
 */
export const buildkitCacheCounter = () => {
	const steps = new Map(); // vertex id -> "pending" | "cached" | "ran"
	let partial = "";
	const readLine = (line) => {
		const step = /^#(\d+) \[[^\]]*\d+\/\d+\] (\S+)/.exec(line);
		if (step) {
			if (step[2] !== "FROM") {
				steps.set(step[1], "pending");
			}
			return;
		}
		const status = /^#(\d+) (CACHED|DONE|ERROR)\b/.exec(line);
		if (status && steps.get(status[1]) === "pending") {
			steps.set(status[1], status[2] === "CACHED" ? "cached" : "ran");
		}
	};
	return {
		write: (chunk) => {
			const lines = (partial + chunk).split("\n");
			// cap so a huge line without a newline can't grow memory
			partial = lines.pop().slice(-65536);
			lines.forEach((line) => readLine(line.trimEnd()));
		},
		result: () => {
			readLine(partial.trimEnd());
			partial = "";
			const states = [ ...steps.values() ];
			return {
				cached: states.filter((state) => state === "cached").length,
				total: states.filter((state) => state !== "pending").length,
			};
		},
	};
};

/**
 * Sees a child's output as the builder reads it, without consuming it or
 * changing the stream's mode (adding a 'data' listener would switch it to
 * flowing and could drop output the builder hasn't attached to yet).
 */
const tapOutput = (stream, write) => {
	if (!stream) {
		return;
	}
	const emit = stream.emit;
	stream.emit = function (event, chunk, ...rest) {
		if (event === "data") {
			try {
				write(String(chunk));
			}
			catch {
				// never let tracing break the builder's output
			}
		}
		return emit.call(this, event, chunk, ...rest);
	};
};

/**
 * Which spawned commands become spans, and what they're called.
 * @returns {{ name: string, attributes: Record<string, string|number|boolean>, isBuild?: boolean } | null}
 */
export const describeCommand = (command, args, options = {}) => {
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
					attributes: {
						"docker.target": target,
						"docker.tags": tags.join(" "),
						"docker.no_cache": rest.includes("--no-cache"),
						"docker.cache_from.count": flagValues(rest, "--cache-from").length,
						"docker.platform": flagValues(rest, "--platform").join(","),
						// BuildKit is the default since docker 23; only DOCKER_BUILDKIT=0 turns it off
						"docker.builder": (options.env ?? process.env).DOCKER_BUILDKIT === "0" ? "legacy" : "buildkit",
					},
					isBuild: true,
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
	const cacheTotals = { cached: 0, total: 0 };
	const originalSpawn = childProcess.spawn;
	childProcess.spawn = function (command, args, ...rest) {
		const child = originalSpawn.call(this, command, args, ...rest);
		try {
			// spawn(command, options) has no args array
			const options = Array.isArray(args) ? rest[0] : args;
			const described = describeCommand(command, Array.isArray(args) ? args.map(String) : [], options ?? {});
			if (described) {
				recordedSpans++;
				const span = trace.startSpan(described.name, described.attributes);
				const cache = described.isBuild ? buildkitCacheCounter() : undefined;
				if (cache) {
					// plain progress goes to stderr, but read both
					tapOutput(child.stdout, cache.write);
					tapOutput(child.stderr, cache.write);
				}
				child.once("error", (error) => span.end({ error: true, message: error.message }));
				// close, not exit: by then the output (and so the cache counts) is complete
				child.once("close", (code, signal) => {
					const { cached, total } = cache?.result() ?? { cached: 0, total: 0 };
					cacheTotals.cached += cached;
					cacheTotals.total += total;
					span.end({
						error: code !== 0,
						attributes: {
							"process.exit_code": code ?? undefined,
							"process.signal": signal ?? undefined,
							...(total > 0
								? {
									"docker.cache.steps.cached": cached,
									"docker.cache.steps.total": total,
									"docker.cache.hit_ratio": cached / total,
								}
								: {}),
						},
					});
				});
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
		const environment = await collectEnvironment().catch(() => ({}));
		await trace.flush(process.exitCode ? "failure" : "success", {
			bearerToken: env.CI_TRACE_OTLP_TOKEN,
			attributes: {
				...environment,
				...(cacheTotals.total > 0
					? {
						"docker.cache.steps.cached": cacheTotals.cached,
						"docker.cache.steps.total": cacheTotals.total,
						"docker.cache.hit_ratio": cacheTotals.cached / cacheTotals.total,
					}
					: {}),
			},
		});
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
