#!/usr/bin/env bash
set -x #echo on

# shouldn't generally need this because it's built automatically on git push but this will do a full rebuild on demand

# for legacy usages:
image1=gcr.io/reflexions-ci-builder/github.com/reflexions/ci-builder:master
# prefer main (it's what CI builds)
image2=gcr.io/reflexions-ci-builder/github.com/reflexions/ci-builder:main

docker build --no-cache --pull -t $image1 -t $image2 . || exit 1
docker push $image1 || exit 1
docker push $image2 || exit 1
