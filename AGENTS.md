# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Builds the `ci-builder` Docker image: a CentOS Stream 10 base with the docker CLI (plus buildx and compose plugins), gcloud CLI, and Node.js — the toolchain other projects' Cloud Build pipelines use as their build step image (e.g. running `node ./ci/builder.js`). Multi-arch (linux/amd64 + linux/arm64), pushed to `us-central1-docker.pkg.dev/reflexions-ci-builder/ci-builder/ci-builder`.

## Commands

```bash
# One-time setup: create the docker-container buildx builder that
# multi-arch builds require (idempotent)
./init-buildx.sh

# Local multi-arch build (no push)
./build-builder.sh

# Build and push (tags :main and :YYYY-MM-DD)
PUSH=1 ./build-builder.sh

# Disable build cache
NO_CACHE=--no-cache ./build-builder.sh

# Run cloudbuild.yaml locally via cloud-build-local
./cloud-build-local.sh
```

There are no linters. `node --test ci-trace/ci-trace.test.mjs` tests the build tracer, and the Dockerfile also runs it during the image build. Normal releases happen automatically: Cloud Build runs `cloudbuild.yaml` on git push, and only pushes the image when the branch is `main`.

## Architecture / gotchas

- **Dockerfile**: single large `RUN` layer on purpose — every `dnf` operation needs a preceding `touch /var/lib/rpm/*` (overlayfs bug, see comment in file), so steps aren't split into separate layers. The base image and CentOS packages come from a project-local Artifact Registry mirror (`centos-mirror`). Yum repos for gcloud and docker-ce are written inline via `printf`.
- **cloudbuild.yaml**: build steps use a custom `docker-with-gcloud` image rather than `gcr.io/cloud-builders/docker` because GCB's bundled docker is too old for buildx; `_DOCKER_API_VERSION` substitution exists to pin the client API version against the old GCB daemon. Multi-arch builds need the qemu/binfmt + `buildx create` steps that precede the build. Runs on a private worker pool (`e2-highmem-8`) with a 75-min timeout because the multi-arch build is slow.
- **cloud-build-local.sh**: temporarily rewrites `cloudbuild.yaml` with `sed` (swaps machineType, comments out the worker pool — neither works locally) and restores it afterward, including on Ctrl-C. If a run dies hard, check that `cloudbuild.yaml` wasn't left modified.
- **gcloud.env.sh**: sets `CLOUDSDK_CORE_PROJECT=reflexions-ci-builder`; sourced by `cloud-build-local.sh`.
- **ci-trace/**: build-time tracing for every repo on this image. The Dockerfile sets `NODE_OPTIONS=--import=/opt/ci-trace/preload.mjs`, so every node process loads it, and tracing runs for every build, with no per-repo switch. The collector url is `CI_TRACE_OTLP_ENDPOINT`, set in the Dockerfile; empty = off everywhere. When on, it wraps `child_process.spawn`, records a span per `docker build/push/pull/run/compose` and `gsutil` call, and exports one OTLP trace (trace id = `BUILD_ID`) on `beforeExit`, but only if it recorded at least one span, so other node scripts in the image export nothing. The token comes from `CI_TRACE_OTLP_TOKEN`, or from Secret Manager (`CI_TRACE_OTLP_TOKEN_SECRET`, default `otel-ingress-bearer-token`). The preload must never throw, since it runs in every node process; span names come from parsed fields, never raw argv, because builders pass secrets as build args.
