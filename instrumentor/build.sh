#!/usr/bin/env bash
# Builds gradle/libs/kuikly-devtools-instrumentor.jar from instrumentor/.
#
# The jar is packed into the npm tarball (`prepack`) so consumers never need a JVM build step.
# This script is only for rebuilding the instrumentor itself.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

GRADLE_BIN="${GRADLE_BIN:-}"
if [[ -z "$GRADLE_BIN" ]]; then
  if [[ -x "$HERE/gradlew" ]]; then
    GRADLE_BIN="$HERE/gradlew"
  elif command -v gradle >/dev/null 2>&1; then
    GRADLE_BIN="gradle"
  elif [[ -x "$HERE/../../gradlew" ]]; then
    # Nested-in-a-Kuikly-repo layout (legacy).
    GRADLE_BIN="$HERE/../../gradlew"
  else
    echo "error: no gradle found. Install Gradle, or set GRADLE_BIN." >&2
    exit 1
  fi
fi

echo "[kuikly-devtools] building instrumentor with $GRADLE_BIN"
"$GRADLE_BIN" --project-dir "$HERE" test fatJar "$@"

echo "[kuikly-devtools] jar -> $(cd "$HERE/../gradle/libs" && pwd)/kuikly-devtools-instrumentor.jar"
