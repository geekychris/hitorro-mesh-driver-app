/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.hitorro.mesh.RegisterTableMessage;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests the tracker's multi-partition keying. Fixes a latent bug where
 * per-partition register overwrote entries because keys were name-only.
 */
class RuntimeTableTrackerPartitionedTest {

    private static RegisterTableMessage partitionMsg(String name, String pk, String targetAgent) {
        return new RegisterTableMessage(name,
                "{\"name\":\"" + name + "\",\"fields\":[]}",
                "file:/x/" + name + "-" + pk + ".ndjson",
                "ndjson",
                /*broadcast=*/false, pk, /*sourceConfig=*/null, targetAgent);
    }

    @Test
    void multiplePartitions_sameTable_areSeparateEntries(@TempDir Path tmp) {
        RuntimeTableTracker t = new RuntimeTableTracker(tmp.resolve("t.json"));
        t.record(partitionMsg("world_pop", "na", "agent-us"), 1, "agent-us", false);
        t.record(partitionMsg("world_pop", "eu", "agent-eu"), 1, "agent-eu", false);

        assertThat(t.size()).isEqualTo(2);
        assertThat(t.snapshot()).extracting(RuntimeTableTracker.Entry::partitionKey)
                .containsExactly("na", "eu");
    }

    @Test
    void targetAgentId_isRecordedAndPersists(@TempDir Path tmp) throws IOException {
        Path file = tmp.resolve("t.json");
        RuntimeTableTracker t = new RuntimeTableTracker(file);
        t.record(partitionMsg("shards", "a", "agent-us"), 1, "agent-us", true);

        RuntimeTableTracker.Entry e = t.snapshot().get(0);
        assertThat(e.targetAgentId()).isEqualTo("agent-us");
        assertThat(e.explicitTarget()).isTrue();
        // Load-back preserves both fields.
        assertThat(Files.readString(file)).contains("\"targetAgentId\" : \"agent-us\"")
                                          .contains("\"explicitTarget\" : true");
    }

    @Test
    void forgetByNameAndPartitionKey_removesOnly_theSpecificEntry(@TempDir Path tmp) {
        RuntimeTableTracker t = new RuntimeTableTracker(tmp.resolve("t.json"));
        t.record(partitionMsg("world_pop", "na", "agent-us"), 1, "agent-us", false);
        t.record(partitionMsg("world_pop", "eu", "agent-eu"), 1, "agent-eu", false);
        t.record(partitionMsg("world_pop", "asia", "agent-us"), 1, "agent-us", false);

        t.forget("world_pop", "eu");

        assertThat(t.snapshot()).hasSize(2);
        assertThat(t.snapshot()).extracting(RuntimeTableTracker.Entry::partitionKey)
                .containsExactly("na", "asia");
    }

    @Test
    void forgetByName_removes_everyPartitionOfThatTable(@TempDir Path tmp) {
        RuntimeTableTracker t = new RuntimeTableTracker(tmp.resolve("t.json"));
        t.record(partitionMsg("world_pop", "na", "agent-us"), 1, "agent-us", false);
        t.record(partitionMsg("world_pop", "eu", "agent-eu"), 1, "agent-eu", false);
        t.record(partitionMsg("other", "x", "agent-us"), 1, "agent-us", false);

        t.forget("world_pop");

        assertThat(t.snapshot()).hasSize(1);
        assertThat(t.snapshot().get(0).name()).isEqualTo("other");
    }

    @Test
    void broadcastAndPartitioned_coexistUnderTheirOwnKeys(@TempDir Path tmp) {
        RuntimeTableTracker t = new RuntimeTableTracker(tmp.resolve("t.json"));
        // Broadcast: partitionKey=null → key = "world_pop"
        RegisterTableMessage bcast = new RegisterTableMessage("world_pop",
                "{\"name\":\"world_pop\",\"fields\":[]}",
                "file:/all.ndjson", "ndjson",
                /*broadcast=*/true, null);
        t.record(bcast, 2);
        // Partitioned: same name, pk=na
        t.record(partitionMsg("world_pop", "na", "agent-us"), 1, "agent-us", false);

        assertThat(t.size()).isEqualTo(2);
    }

    @Test
    void loadBack_restoresAllPartitionEntries(@TempDir Path tmp) {
        Path file = tmp.resolve("t.json");
        // First "process" — record two partitions, drop instance.
        {
            RuntimeTableTracker t = new RuntimeTableTracker(file);
            t.record(partitionMsg("world_pop", "na", "agent-us"), 1, "agent-us", false);
            t.record(partitionMsg("world_pop", "eu", "agent-eu"), 1, "agent-eu", false);
        }
        RuntimeTableTracker t2 = new RuntimeTableTracker(file);
        t2.load();
        assertThat(t2.size()).isEqualTo(2);
        assertThat(t2.snapshot()).extracting(RuntimeTableTracker.Entry::targetAgentId)
                .containsExactly("agent-us", "agent-eu");
    }
}
