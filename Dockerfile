# this mirrors quay.io/centos/centos:stream10
# use the cubic-kubernetes/sync-docker-image-mirror/sync-centos-mirror.sh script to keep this in sync
FROM us-central1-docker.pkg.dev/reflexions-cubic/centos-mirror/centos10/stream10:latest AS base

ENV LANG=en_US.utf8

# putting && on next line, because then it's more obvious that

RUN printf "\
[google-cloud-sdk]\n\
name=Google Cloud SDK\n\
# centos10 not supported yet\n\
#baseurl=https://packages.cloud.google.com/yum/repos/cloud-sdk-el\$releasever-\$basearch\n\
baseurl=https://packages.cloud.google.com/yum/repos/cloud-sdk-el9-\$basearch\n\
enabled=1\n\
# Google isn't signing their package correctly :-/\n\
#gpgcheck=1\n\
gpgcheck=0\n\
gpgkey=https://packages.cloud.google.com/yum/doc/yum-key.gpg,https://packages.cloud.google.com/yum/doc/rpm-package-key.gpg\n\
" > /etc/yum.repos.d/google-cloud-sdk.repo

# the only enabled repo in https://download.docker.com/linux/centos/docker-ce.repo
# there's also a fedora version at https://download.docker.com/linux/fedora/docker-ce.repo
# have to escape the $ before basearch and releasever with \
RUN printf "\
[docker-ce-stable]\n\
name=Docker CE Stable - \$basearch\n\
baseurl=https://download.docker.com/linux/centos/\$releasever/\$basearch/stable\n\
enabled=1\n\
gpgcheck=1\n\
gpgkey=https://download.docker.com/linux/centos/gpg\n\
" > /etc/yum.repos.d/docker-ce.repo

# the touch is per https://bugzilla.redhat.com/show_bug.cgi?id=1213602
# it's needed for every dnf operation when the host is using overlayfs (like macs and GCR)
#
# setup_{version}.x installs the nodejs repo but not node itself
#
# disable redhat's container-tools and use docker-ce instead
#
# no longer installing the separate docker-compose binary (prefer the `docker compose` plugin instead,
# which is available from the docker:latest image)
#
# do we actually need google-cloud-sdk here? it's giant.. We do use gsutil though
#  -> yes, we use it for uploading logs and downloading cms exports for playwright
# from https://cloud.google.com/sdk/docs/downloads-docker there's
#	also gcr.io/google.com/cloudsdktool/google-cloud-cli:latest, but that's > 1GB
#	there's also gcr.io/google.com/cloudsdktool/google-cloud-cli:slim, but we'd have to install stuff into it
#	could build our own docker image out of that, but then that's kinda what this image is
#	either way we'd have to update our CI code to launch docker to run gsutil instead of running the bin directly
# here's how we might install it manually:
#	&& latest_gcloud_version=$(dnf list google-cloud-cli | tail -n 1 | awk -F '[ ]+' '{ print $2 }' | awk -F '[-]' '{ print $1 }') \
#	&& curl "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${latest_gcloud_version}-linux-$(uname -m).tar.gz" -o google-cloud-cli.tar.gz \
#	&& tar zxf google-cloud-cli.tar.gz \
#
# no longer include trace-unhandled, as it hasn't had a release in years, and node now has --trace-uncaught
# we used to use trace-unhandled to help with debugging ERR_UNHANDLED_REJECTION
#
# don't need source-map-support because the scripts we run aren't compiled
#
# git is installed to silence warning: with buildx: git was not found in the system. Current commit information was not captured by the build
#
# google-cloud-sdk/RELEASE_NOTES is 1mb that we don't need
RUN touch /var/lib/rpm/* \
	&& dnf -y upgrade --setopt=deltarpm=false --nodocs \
	&& curl --silent --location https://rpm.nodesource.com/setup_23.x | bash - \
	&& dnf -y install --nodocs \
		docker-ce \
		docker-compose-plugin \
		git \
		google-cloud-cli \
		nodejs \
	&& gcloud auth configure-docker \
	&& gcloud auth configure-docker us-central1-docker.pkg.dev \
	&& npm install -g \
		google-artifactregistry-auth \
	&& rm -f /usr/lib64/google-cloud-sdk/RELEASE_NOTES \
	&& dnf clean all

# I didn't bother breaking up the above into multiple RUN statements because of the need to
# run touch /var/lib/rpm/* each time we dnf install. If we do end up doing that, then use this:
#FROM us-central1-docker.pkg.dev/reflexions-cubic/centos-mirror/centos10/stream10:latest AS flattened
#COPY --from=base / /
