#!/usr/bin/env bash
set -x #echo on

# shouldn't generally need this because it's built automatically on git push but this will do a full rebuild on demand

# for legacy usages:
image1=gcr.io/reflexions-ci-builder/github.com/reflexions/ci-builder:master
# prefer main (it's what CI builds)
image2=gcr.io/reflexions-ci-builder/github.com/reflexions/ci-builder:main
# artifact registry
image3=us-central1-docker.pkg.dev/reflexions-ci-builder/ci-builder/ci-builder:main

no_cache=--no-cache
no_cache=

docker build $no_cache --pull \
	-t $image1 \
	-t $image2 \
	-t $image3 \
	. || exit 1
docker push $image1 || exit 1
docker push $image2 || exit 1
docker push $image3 || exit 1
