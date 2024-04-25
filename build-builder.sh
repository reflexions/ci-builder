#!/usr/bin/env bash
set -x #echo on

# shouldn't generally need this because it's built automatically on git push but this will do a full rebuild on demand

push=${PUSH-0} # by default don't push. Pass PUSH=1 env var to push.
no_cache=${NO_CACHE---no-cache} # by default don't use cache. Pass NO_CACHE= env var to enable caching

echo "pushing?: $push"
echo "no cache?: $no_cache"

# for legacy usages:
image1=gcr.io/reflexions-ci-builder/github.com/reflexions/ci-builder:master
# prefer main (it's what CI builds)
image2=gcr.io/reflexions-ci-builder/github.com/reflexions/ci-builder:main
# artifact registry (preferred)
image3=us-central1-docker.pkg.dev/reflexions-ci-builder/ci-builder/ci-builder:main
# historical releases
image4=us-central1-docker.pkg.dev/reflexions-ci-builder/ci-builder/ci-builder:$(date +"%Y-%m-%d")

docker build $no_cache --pull \
	-t $image1 \
	-t $image2 \
	-t $image3 \
	-t $image4 \
	. || exit 1

if [[ "$push" == "1" ]]; then
	docker push $image1 || { echo "push $image1 failed"; exit 1; }
	docker push $image2 || { echo "push $image2 failed"; exit 1; }
	docker push $image3 || { echo "push $image3 failed"; exit 1; }
	docker push $image4 || { echo "push $image4 failed"; exit 1; }
fi
