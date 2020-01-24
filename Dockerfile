FROM centos:8

ENV LANG en_US.utf8

# putting && on next line, because then it's more obvious that
# the new line is a separate command

RUN printf "\
[yarn]\n\
name=Yarn Repository\n\
baseurl=https://dl.yarnpkg.com/rpm/\n\
enabled=1\n\
gpgcheck=1\n\
gpgkey=https://dl.yarnpkg.com/rpm/pubkey.gpg\n\
" > /etc/yum.repos.d/yarn.repo

RUN printf "\
[google-cloud-sdk]\n\
name=Google Cloud SDK\n\
baseurl=https://packages.cloud.google.com/yum/repos/cloud-sdk-el8-x86_64\n\
enabled=1\n\
gpgcheck=1\n\
gpgkey=https://packages.cloud.google.com/yum/doc/yum-key.gpg,https://packages.cloud.google.com/yum/doc/rpm-package-key.gpg\n\
" > /etc/yum.repos.d/google-cloud-sdk.repo

# the touch is per https://bugzilla.redhat.com/show_bug.cgi?id=1213602
# it's needed for every dnf operation when the host is using overlayfs (like macs and GCR)
# setup_10.x installs the nodejs repo but not node itself
# gcloud needs `which` during install and runtime
RUN touch /var/lib/rpm/* \
	&& dnf -y upgrade --setopt=deltarpm=false \
	&& dnf -y install \
		which \
	&& curl --silent --location https://rpm.nodesource.com/setup_13.x | bash - \
	&& dnf -y install \
		buildah \
		google-cloud-sdk \
		kubectl \
		nodejs \
		podman \
		yarn \
	&& gcloud auth configure-docker \
	&& dnf clean all
