#!/bin/bash
# Golden REST test for the mesh apps (driver + agent), against responses recorded from main on
# Jackson 2 (main/main-*.jsonl.gz, 7 runs of main @ f212b1c driver / cced689 agent, HiTorro 3.x).
#
#   src/test/golden/run.sh <driver.jar> <agent.jar>
#
# Starts NATS (docker), two agents serving NDJSON partitions and the driver, makes 107 requests
# (every controller: queries, SSE, explain, tables, broadcast tables, schedules incl. java.time
# fields, storage, catalog, datasets, fleet, logs, search, federated retrieval/KV, write + batch
# write and the files they write, the driver's runtime-tables.json and the agents' journals,
# actuator, error bodies) and compares with the main recordings. A record identical across all
# main runs must match byte for byte after masking run-dependent values (run-day timestamps keep
# their format, epoch ms near now, query ids, durations, pids, ports, the work dir); a record whose
# key/element order varies across main runs (Map.of, hash sets) is compared order-insensitively.
# GOLDEN_DEPLOYED=1 starts the apps as the hitorro-mesh Helm chart and cloud-stack's deploy/mesh overlay do
# (--spring.config.location replacing application.yml, plus the overlay's env) and compares with main
# recorded the same way (main-deployed/); on 4.0.0 before the fix this crashed or wrote Jackson 3's format.
# Requires python3, docker (DOCKER_HOST), java 21. Exit code 0 = identical.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
python3 "$here/mesh_golden.py" --driver-cp "$1" --agent-cp "$2" --out "$work/new.jsonl" --work "$work/w"
if [ "${GOLDEN_DEPLOYED:-}" = 1 ]; then
  python3 "$here/golden_compare.py" "$(ls "$here"/main-deployed/main-*.jsonl.gz | paste -sd, -)" "$work/new.jsonl" \
    --order-from="$(ls "$here"/main/main-*.jsonl.gz | paste -sd, -)"
else
  python3 "$here/golden_compare.py" "$(ls "$here"/main/main-*.jsonl.gz | paste -sd, -)" "$work/new.jsonl"
fi
