#!/usr/bin/env bash
# Invariants for GENERATED harness workflows (system-design §7). Kept in a script
# (not inline in ci.yml) so the literal ${{ github.event }} patterns in the awk
# regex below are not misparsed as workflow expressions by actionlint.
#
#   1. `uses: ./` is forbidden EXCEPT the sanctioned ./.github/agent-setup consumer
#      composite (the toolchain escape hatch, intentionally local to the consumer).
#   2. `${{ github.event.* }}` inside a run: block is forbidden — untrusted event
#      data must flow through env + sanitize-untrusted-input (script-injection class).
set -uo pipefail
shopt -s nullglob globstar

gen=( examples/**/.github/workflows/*.yml examples/**/.github/workflows/*.yaml )
if [ ${#gen[@]} -eq 0 ]; then
  echo "No generated example workflows found; nothing to guard."
  exit 0
fi
echo "Guarding: ${gen[*]}"

status=0
EVENT_EXPR='\$\{\{[[:space:]]*github\.event\.'

# (1) local action paths
bad_local=$(grep -REn --include='*.yml' --include='*.yaml' \
     '^[[:space:]]*uses:[[:space:]]*\./' "${gen[@]}" \
     | grep -v 'uses:[[:space:]]*\./\.github/agent-setup' || true)
if [ -n "$bad_local" ]; then
  echo "$bad_local"
  echo "::error::Generated workflow uses a local action path ('uses: ./') other than ./.github/agent-setup. Reference the pinned runtime core by version instead."
  status=1
fi

# (2) github.event.* interpolated inside a run: block
for f in "${gen[@]}"; do
  awk -v file="$f" -v pat="$EVENT_EXPR" '
    { line = $0; match(line, /^ */); indent = RLENGTH }
    /^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*[|>][0-9+-]*[[:space:]]*$/ ||
    /^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*$/ { in_run = 1; run_indent = indent; next }
    /^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*[^|> ]/ {
      if (line ~ pat) { printf("%s:%d: github.event.* interpolated inside run:\n", file, NR); bad = 1 }
      in_run = 0; next
    }
    in_run == 1 {
      if (line ~ /^[[:space:]]*$/) { next }
      if (indent <= run_indent) { in_run = 0 }
      else if (line ~ pat) { printf("%s:%d: github.event.* interpolated inside run:\n", file, NR); bad = 1; next }
    }
    END { exit bad }
  ' "$f" || {
    echo "::error file=$f::Generated run: block interpolates github.event.* directly. Pass it via env and sanitize instead."
    status=1
  }
done

exit $status
