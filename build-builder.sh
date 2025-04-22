#!/usr/bin/env bash
set -x #echo on

# shouldn't generally need this because it's built automatically on git push but this will do a full rebuild on demand

push=${PUSH-0} # by default don't push. Pass PUSH=1 env var to push.
no_cache=${NO_CACHE-} # by default use cache. Pass NO_CACHE=--no-cache env var to disable caching

echo "pushing?: $push"
echo "no cache?: $no_cache"

image1=us-central1-docker.pkg.dev/reflexions-ci-builder/ci-builder/ci-builder:main
# historical releases
image2=us-central1-docker.pkg.dev/reflexions-ci-builder/ci-builder/ci-builder:$(date +"%Y-%m-%d")

platform="linux/amd64,linux/arm64"

if [[ "$push" == "1" ]]; then
	push_arg='--push'
else
	push_arg=''
fi

set -x # echo on
exec docker buildx build $no_cache --pull \
	--progress plain \
	$push_arg \
	--platform "${platform}" \
	-t "$image1" \
	-t "$image2" \
	.
