# -bind-mount-source and _MOUNT_NAME are a workaround
# https://gist.github.com/dmcguire81/c9e8c20248ec1f7f6cc656fbae124d4d

# note: realpath isn't always installed, so use pwd in subshell instead
script_dir="$( cd "$(dirname "$0")" >/dev/null 2>&1 ; pwd -P )" || exit 1
cd "$script_dir" || exit 1


# note: E2_HIGHCPU_32 doesn't work in cloud-build-local (but N1_HIGHCPU_32 does)
from=" machineType: 'E2_HIGHCPU_32'"
to=" machineType: 'N1_HIGHCPU_32'"
from2="  pool:"
to2="#  pool:"
from3="    name: 'projects"
to3="#    name: 'projects"

function restore_yaml() {
	# put back the original machineType
	sed -i.bak "s/$to/$from/" cloudbuild.yaml
	sed -i.bak "s/$to2/$from2/" cloudbuild.yaml
	sed -i.bak "s/$to3/$from3/" cloudbuild.yaml
	rm cloudbuild.yaml.bak
}

# trap ctrl-c and call restore_yaml()
trap restore_yaml INT

sed -i.bak "s/$from/$to/" cloudbuild.yaml
sed -i.bak "s/$from2/$to2/" cloudbuild.yaml
sed -i.bak "s/$from3/$to3/" cloudbuild.yaml
rm cloudbuild.yaml.bak

# gcloud.env.sh sets CLOUDSDK_CORE_PROJECT
source "${script_dir}/gcloud.env.sh"

export REPO_NAME=ci-builder

# we shouldn't have to "set project" when CLOUDSDK_CORE_PROJECT is set
#gcloud config set project "${CLOUDSDK_CORE_PROJECT}" || { echo "Failed to set gcloud project to ${CLOUDSDK_CORE_PROJECT}"; exit 1; }

docker pull us-central1-docker.pkg.dev/docker-with-gcloud-395321/docker-with-gcloud/docker-with-gcloud:latest

# local supports docker 1.53, but cloud build currently supports only 1.41

time cloud-build-local \
	-bind-mount-source \
	--dryrun=false \
	--substitutions REPO_NAME="${REPO_NAME}",\
BRANCH_NAME="$(git rev-parse --abbrev-ref HEAD)",\
_DOCKER_API_VERSION=$(docker version --format '{{.Server.APIVersion}}')\
	.

restore_yaml

# ding
printf '\a'
