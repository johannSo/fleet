#!/usr/bin/env bash
# Builds fleet-agent for every machine the fleet has: static linux/amd64 and linux/arm64.
#
#   ./build.sh          build bin/fleet-agent-{amd64,arm64} and bin/BUILD
#   ./build.sh --hash   print the build id only
#
# The build id is a hash of the agent's sources (Go files and collectors, not tests),
# so the same sources always give the same id and agents only update when the
# agent actually changed. The panel compares it with each agent's id and pushes an
# update to the ones that differ.
set -euo pipefail
cd "$(dirname "$0")"

BUILD=$(find . -path ./bin -prune -o -type f \( -name '*.go' ! -name '*_test.go' -o -name '*.sh' ! -name build.sh -o -name go.mod -o -name go.sum \) -print \
  | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-12)
if [[ "${1:-}" == "--hash" ]]; then echo "$BUILD"; exit 0; fi

GO=$(command -v go) || { echo "go not found on PATH" >&2; exit 1; }
VERSION=$(sed -n 's/^\tversion = "\(.*\)"$/\1/p' main.go)
mkdir -p bin
for ARCH in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$ARCH "$GO" build -trimpath -ldflags "-s -w -X main.build=$BUILD" -o "bin/fleet-agent-$ARCH.new" .
  mv -f "bin/fleet-agent-$ARCH.new" "bin/fleet-agent-$ARCH"
done
echo "$BUILD" > bin/BUILD
echo "fleet-agent $VERSION, build $BUILD: $(cd bin && ls fleet-agent-* | tr '\n' ' ')"
