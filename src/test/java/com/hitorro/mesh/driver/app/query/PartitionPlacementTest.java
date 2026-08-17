/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** Tests for the two shipped {@link PartitionPlacement} strategies. */
class PartitionPlacementTest {

    private static final PartitionPlacement HASH = new PartitionPlacement.Hash();
    private static final PartitionPlacement RR   = new PartitionPlacement.RoundRobin();

    @Test
    void hash_assignsEveryPartition() {
        Map<String, String> m = HASH.assign("t",
                List.of("a", "b", "c", "d"),
                List.of("agent-us", "agent-eu"));
        assertThat(m).hasSize(4);
        assertThat(m.values()).allMatch(v -> v.equals("agent-us") || v.equals("agent-eu"));
    }

    @Test
    void hash_isDeterministic_sameInputsSameOutput() {
        Map<String, String> a = HASH.assign("t", List.of("na", "eu", "asia"),
                List.of("agent-us", "agent-eu"));
        Map<String, String> b = HASH.assign("t", List.of("na", "eu", "asia"),
                List.of("agent-us", "agent-eu"));
        assertThat(a).isEqualTo(b);
    }

    @Test
    void hash_sortsAgentsForStableAssignmentAcrossDriverRestarts() {
        // Even if the caller passes agents in a different order, the sort
        // step means the same (table, key) always lands on the same agent.
        Map<String, String> a = HASH.assign("t", List.of("na", "eu"),
                List.of("agent-us", "agent-eu"));
        Map<String, String> b = HASH.assign("t", List.of("na", "eu"),
                List.of("agent-eu", "agent-us"));
        assertThat(a).isEqualTo(b);
    }

    @Test
    void hash_spreadsAcrossAgents_notAllToOne() {
        Map<String, String> m = HASH.assign("t",
                List.of("k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"),
                List.of("agent-us", "agent-eu", "agent-ap"));
        // With 8 partitions across 3 agents, at least each agent should
        // hold >= 1. (Not perfect uniformity — hash may skew — but
        // "everyone gets something" is the smoke test.)
        long distinct = m.values().stream().distinct().count();
        assertThat(distinct).isEqualTo(3);
    }

    @Test
    void hash_emptyLiveAgents_returnsEmptyMap() {
        assertThat(HASH.assign("t", List.of("a"), List.of())).isEmpty();
    }

    @Test
    void roundRobin_distributesEvenly() {
        Map<String, String> m = RR.assign("t",
                List.of("a", "b", "c", "d"),
                List.of("agent-us", "agent-eu"));
        assertThat(m).containsEntry("a", "agent-eu")   // sorted: agent-eu, agent-us; index 0
                     .containsEntry("b", "agent-us")   // index 1
                     .containsEntry("c", "agent-eu")   // index 0
                     .containsEntry("d", "agent-us");  // index 1
    }

    @Test
    void roundRobin_singleAgent_allToSame() {
        Map<String, String> m = RR.assign("t", List.of("a", "b", "c"),
                List.of("only-agent"));
        assertThat(m).allSatisfy((k, v) -> assertThat(v).isEqualTo("only-agent"));
    }

    @Test
    void roundRobin_emptyLiveAgents_returnsEmptyMap() {
        assertThat(RR.assign("t", List.of("a"), List.of())).isEmpty();
    }
}
