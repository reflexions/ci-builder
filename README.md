# ci-builder
Has the docker, gcp, node deps needed for building other docker containers

## Sample cloudbuild.yml

```yaml
steps:
# https://cloud.google.com/cloud-build/docs/api/reference/rest/v1/projects.builds#buildstep
- name: 'gcr.io/reflexions-ci-builder/github.com/reflexions/ci-builder:master'
  args: [ 'node', './ci/builder.js' ]
  env:
  # https://cloud.google.com/cloud-build/docs/configuring-builds/substitute-variable-values
  - 'PROJECT_ID=$PROJECT_ID'
  - 'BUILD_ID=$BUILD_ID'
  - 'COMMIT_SHA=$COMMIT_SHA'
  - 'REPO_NAME=$REPO_NAME'
  - 'BRANCH_NAME=$BRANCH_NAME'
  - 'REVISION_ID=$REVISION_ID'
  - '_GITHUB_TOKEN=$_GITHUB_TOKEN'
images: [
  'gcr.io/$PROJECT_ID/$REPO_NAME:$BRANCH_NAME',
  'gcr.io/$PROJECT_ID/$REPO_NAME:$COMMIT_SHA',
]
timeout: 1200s
```
