FROM quay.io/centos/centos:stream9 as base

ENV LANG en_US.utf8

# putting && on next line, because then it's more obvious that

RUN printf "\
[google-cloud-sdk]\n\
name=Google Cloud SDK\n\
baseurl=https://packages.cloud.google.com/yum/repos/cloud-sdk-el9-\$basearch\n\
enabled=1\n\
gpgcheck=1\n\
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
# setup_18.x installs the nodejs repo but not node itself
# gcloud needs `which` during install and runtime
# disable redhat's container-tools and use docker-ce instead
# no longer installing the separate docker-compose binary (prefer the `docker compose` plugin instead,
# which is available from the docker:latest image)
# do we actually need google-cloud-sdk here? it's giant.. We do use gsutil though
# trace-unhandled helps with debugging ERR_UNHANDLED_REJECTION
RUN touch /var/lib/rpm/* \
	&& dnf -y upgrade --setopt=deltarpm=false \
	&& dnf -y install \
		which \
	&& curl --silent --location https://rpm.nodesource.com/setup_18.x | bash - \
	&& dnf -y install \
		docker-ce \
		docker-compose-plugin \
		google-cloud-sdk \
		kubectl \
		nodejs \
	&& gcloud auth configure-docker \
	&& npm install -g trace-unhandled \
	&& dnf clean all
