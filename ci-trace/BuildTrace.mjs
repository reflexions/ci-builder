/**
 * Records a CI build as one OpenTelemetry trace and ships it to an OTLP/HTTP
 * collector in a single POST at the end. A root span covers the whole build;
 * each `startSpan()` is a child of it, so parallel work renders as a gantt
 * chart in Tempo/Grafana. Port of marta's ci/builder/src/otel_trace.ts.
 *
 * Deliberately dependency-free: OTLP/HTTP has a JSON encoding, so `fetch` is
 * all it takes.
 *
 * Export is best-effort: `flush()` never throws, so a dead or misconfigured
 * collector can't fail a build. It is awaited, though, so an unreachable
 * collector costs up to `timeoutMs` on the way out.
 */

import { randomBytes } from "node:crypto";

const SPAN_KIND_INTERNAL = 1;
const STATUS_CODE_UNSET = 0;
const STATUS_CODE_OK = 1;
const STATUS_CODE_ERROR = 2;

// OTLP wants nanoseconds since the epoch. Date.now() only has ms resolution and
// is subject to clock steps, so anchor once and advance with the monotonic clock.
const wallClockOriginNs = BigInt(Date.now()) * 1_000_000n;
const monotonicOriginNs = process.hrtime.bigint();
const nowNs = () => wallClockOriginNs + (process.hrtime.bigint() - monotonicOriginNs);

const newSpanId = () => randomBytes(8).toString("hex");

/**
 * A Cloud Build id is a UUID: strip the dashes and it's exactly the 16 bytes a
 * trace id needs, so you can jump from a build id straight to its trace.
 * Anything else gets a random id.
 */
export const traceIdFrom = (id = "") => {
	const hex = id.replaceAll("-", "").toLowerCase();
	return /^[0-9a-f]{32}$/.test(hex) ? hex : randomBytes(16).toString("hex");
};

export const toOtlpAttributes = (attributes) =>
	Object.entries(attributes)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => ({
			key,
			value: typeof value === "boolean"
				? { boolValue: value }
				: typeof value === "number"
					? Number.isInteger(value)
						? { intValue: String(value) }
						: { doubleValue: value }
					: { stringValue: String(value) },
		}));

/**
 * @param {object} options
 * @param {string} options.name          root span name
 * @param {string} options.endpoint      collector base url; `/v1/traces` is appended
 * @param {string} [options.traceId]     e.g. the Cloud Build BUILD_ID; see traceIdFrom
 * @param {string} [options.serviceName]
 * @param {Record<string, string|number|boolean>} [options.attributes] root span attributes
 * @param {number} [options.timeoutMs]
 */
export const createBuildTrace = ({
	name,
	endpoint,
	traceId,
	serviceName = "ci-builder",
	attributes = {},
	timeoutMs,
}) => {
	traceId = traceIdFrom(traceId);
	// AbortSignal.timeout throws on NaN/negative, which would lose every export
	timeoutMs = timeoutMs > 0 ? timeoutMs : 10000;

	const makeSpan = (spanName, spanAttributes, parentSpanId) => ({
		name: spanName,
		spanId: newSpanId(),
		parentSpanId,
		startTimeUnixNano: nowNs(),
		endTimeUnixNano: undefined,
		statusCode: STATUS_CODE_UNSET,
		statusMessage: undefined,
		attributes: { ...spanAttributes },
	});

	const rootSpan = makeSpan(name, attributes, undefined);
	const spans = [ rootSpan ];

	const endSpan = (span, { error = false, message, attributes: endAttributes } = {}) => {
		// first end wins, so a late duplicate can't move the end time
		if (span.endTimeUnixNano !== undefined) {
			return;
		}
		span.endTimeUnixNano = nowNs();
		span.statusCode = error ? STATUS_CODE_ERROR : STATUS_CODE_OK;
		span.statusMessage = message;
		Object.assign(span.attributes, endAttributes);
	};

	/**
	 * Opens a child span of the build. Call `.end()` on the result when the
	 * work finishes; spans never ended are closed as errors at flush time.
	 */
	const startSpan = (spanName, spanAttributes = {}) => {
		const span = makeSpan(spanName, spanAttributes, rootSpan.spanId);
		spans.push(span);
		return {
			end: (result) => endSpan(span, result),
		};
	};

	const toOtlpSpan = (span) => ({
		traceId,
		spanId: span.spanId,
		...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
		name: span.name,
		kind: SPAN_KIND_INTERNAL,
		startTimeUnixNano: String(span.startTimeUnixNano),
		endTimeUnixNano: String(span.endTimeUnixNano),
		attributes: toOtlpAttributes(span.attributes),
		status: {
			code: span.statusCode,
			...(span.statusMessage ? { message: span.statusMessage } : {}),
		},
	});

	let flushed = false;
	/**
	 * Closes the root span and exports everything. Safe to call more than
	 * once; later calls are no-ops. Never throws.
	 * @param {"success"|"failure"} outcome
	 * @param {{ bearerToken?: string }} [options]
	 */
	const flush = async (outcome, { bearerToken } = {}) => {
		if (flushed) {
			return;
		}
		flushed = true;

		// Anything still open died mid-step. That's exactly what should show
		// in the gantt, so close it at the build's end instead of dropping it.
		for (const span of spans.slice(1)) {
			endSpan(span, { error: true, message: "still running when the build ended" });
		}
		endSpan(rootSpan, {
			error: outcome === "failure",
			attributes: { "ci.build.outcome": outcome },
		});

		const payload = {
			resourceSpans: [ {
				resource: {
					attributes: toOtlpAttributes({
						"service.name": serviceName,
						"service.namespace": "ci",
						"deployment.environment.name": "ci",
					}),
				},
				scopeSpans: [ {
					scope: { name: "ci-builder" },
					spans: spans.map(toOtlpSpan),
				} ],
			} ],
		};

		try {
			// appended, not resolved, so a path-prefixed collector (https://host/otlp) keeps its prefix.
			// Inside the try: a malformed endpoint throws here, and bad telemetry
			// config isn't worth failing a build over either.
			const url = new URL(`${endpoint.replace(/\/+$/, "")}/v1/traces`);
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				console.warn(`ci-trace: collector rejected trace (${response.status} ${response.statusText})`);
				return;
			}
			console.log(`ci-trace: exported ${spans.length} spans, trace ${traceId} → ${url.origin}`);
		}
		catch (error) {
			console.warn(`ci-trace: failed to export trace to ${endpoint}`, error);
		}
	};

	return {
		traceId,
		startSpan,
		flush,
	};
};
