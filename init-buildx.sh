#!/usr/bin/env bash
set -e

# The default buildx builder uses the docker driver, which doesn't support
# multi-platform builds. Create a docker-container builder for build-builder.sh
# to use. Safe to re-run; skips creation if the builder already exists.

builder_name=${BUILDER_NAME-multiarch}

if docker buildx inspect "$builder_name" >/dev/null 2>&1; then
	echo "buildx builder '$builder_name' already exists"
else
	docker buildx create --name "$builder_name" --driver docker-container
fi

docker buildx use "$builder_name"
docker buildx inspect --bootstrap "$builder_name"
