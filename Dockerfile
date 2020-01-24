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

# the only enabled repo in https://download.docker.com/linux/fedora/docker-ce.repo
# centos version: https://download.docker.com/linux/centos/docker-ce.repo
# have to escape the $ before basearch and releasever with \
# 7 is correct here -- there's no 8 version yet
# using --nobest only because we have to..
RUN printf "\
[docker-ce-stable]\n\
name=Docker CE Stable - \$basearch\n\
baseurl=https://download.docker.com/linux/centos/7/\$basearch/stable\n\
enabled=1\n\
gpgcheck=1\n\
gpgkey=https://download.docker.com/linux/centos/gpg\n\
" > /etc/yum.repos.d/docker-ce.repo

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
		--nobest \
		docker-ce \
	&& dnf -y install \
		google-cloud-sdk \
		kubectl \
		nodejs \
		yarn \
	&& gcloud auth configure-docker \
	&& dnf clean all
