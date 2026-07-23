#!/bin/sh
set -eu

data_dir="${C_POCKET_DATA_DIR:-/app/data}"

mkdir -p "$data_dir/media"
chown -R node:node "$data_dir"

exec su-exec node "$@"
