#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
exec docker run --rm -it --network host --user 1000:1000 \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:size=16m,mode=1777 \
  -e PERCH_CLI_AUTH_DIR=/data -e PERCH_LOGIN_PORT=18081 \
  -v "$project_dir/data:/data" \
  perchai-2api:local node bin/perchai-2api.js login "$@"
