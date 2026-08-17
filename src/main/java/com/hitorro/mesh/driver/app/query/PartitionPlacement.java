/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Decides which agent(s) hold which partition of a runtime-registered
 * distributed table. Pluggable so operators can pick the rule that
 * matches their workload.
 *
 * <p>Two ship out of the box: {@link Hash} (consistent-hash, default —
 * spreads partitions evenly across live agents with deterministic
 * assignment for the same {@code tableName + partitionKey}), and
 * {@link RoundRobin} (simple index-mod-N).</p>
 *
 * <p>Selected via {@code hitorro.mesh.runtime.placement} — see
 * {@code PlacementConfig}. Custom placements land as Spring beans of
 * type {@link PartitionPlacement} named {@code custom}; the
 * config value {@code custom} then wires them in.</p>
 */
public interface PartitionPlacement {

    /**
     * Assign each partition to exactly one agent from the live set.
     * If {@code liveAgents} is empty, returns an empty map — callers
     * should refuse the register with a clear error.
     */
    Map<String, String> assign(String tableName,
                               List<String> partitionKeys,
                               List<String> liveAgents);

    /** Consistent-hash on {@code hash(tableName + "|" + partitionKey)}
     *  mod live-agent-count. Deterministic — a re-register with the
     *  same input picks the same agent (when the agent set is stable). */
    final class Hash implements PartitionPlacement {
        @Override
        public Map<String, String> assign(String tableName,
                                          List<String> partitionKeys,
                                          List<String> liveAgents) {
            Map<String, String> out = new LinkedHashMap<>();
            if (liveAgents.isEmpty()) return out;
            List<String> sorted = new ArrayList<>(liveAgents);
            Collections.sort(sorted);   // stable ordering across driver restarts
            for (String pk : partitionKeys) {
                int idx = Math.floorMod((tableName + "|" + pk).hashCode(), sorted.size());
                out.put(pk, sorted.get(idx));
            }
            return out;
        }
    }

    /** Round-robin over the sorted live-agent list — simplest even
     *  distribution, doesn't preserve assignments across changes to
     *  the agent set. */
    final class RoundRobin implements PartitionPlacement {
        @Override
        public Map<String, String> assign(String tableName,
                                          List<String> partitionKeys,
                                          List<String> liveAgents) {
            Map<String, String> out = new LinkedHashMap<>();
            if (liveAgents.isEmpty()) return out;
            List<String> sorted = new ArrayList<>(liveAgents);
            Collections.sort(sorted);
            int i = 0;
            for (String pk : partitionKeys) {
                out.put(pk, sorted.get(i % sorted.size()));
                i++;
            }
            return out;
        }
    }
}
