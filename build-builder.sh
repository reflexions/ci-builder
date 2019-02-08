#!/usr/bin/env bash
set -x #echo on

# shouldn't generally need this because it's built automatically on git push but this will do a full rebuild on demand

# note that this script assumes master branch. Might want to change that.

image=gcr.io/reflexions-ci-builder/github.com/reflexions/ci-builder:master

docker build --no-cache --pull -t $image . \
	&& docker push $image
