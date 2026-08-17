/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.hitorro.mesh.AgentDescriptor;
import com.hitorro.mesh.InMemoryMeshTransport;
import com.hitorro.mesh.RegisterTableMessage;
import com.hitorro.mesh.driver.DistributedTableRegistry;
import com.hitorro.mesh.driver.LiveAgentRegistry;
import com.hitorro.mesh.driver.MeshDriver;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests the reactive re-hash logic in {@link PartitionReconciler}.
 * Uses an {@link InMemoryMeshTransport}-backed {@link MeshDriver}
 * with a mocked live-agent set (LiveAgentRegistry is populated via
 * synthetic heartbeats — no real agent needed).
 */
class PartitionReconcilerTest {

    /** Push a HeartbeatMessage through the InMemory transport so
     *  LiveAgentRegistry sees an "alive" agent for the test. */
    private static void announceAgent(InMemoryMeshTransport t, String agentId) {
        var desc = new AgentDescriptor(agentId, Set.of("jvssql"), System.currentTimeMillis());
        var hb = new com.hitorro.mesh.HeartbeatMessage(desc, System.currentTimeMillis(), 0);
        t.publish(com.hitorro.mesh.Subjects.heartbeat(agentId),
                com.hitorro.mesh.Codecs.encode(hb));
    }

    private static RegisterTableMessage partitionMsg(String name, String pk, String uri) {
        return new RegisterTableMessage(name,
                "{\"name\":\"" + name + "\",\"fields\":[]}",
                uri, "ndjson",
                /*broadcast=*/false, pk, /*sourceConfig=*/null, /*targetAgentId=*/null);
    }

    @Test
    void livePartition_needsNoReconcile(@TempDir Path tmp) throws Exception {
        InMemoryMeshTransport t = new InMemoryMeshTransport();
        MeshDriver driver = new MeshDriver(t, new DistributedTableRegistry(), 30_000);
        driver.start();
        announceAgent(t, "agent-us");
        Thread.sleep(50);   // let the heartbeat land

        RuntimeTableTracker tr = new RuntimeTableTracker(tmp.resolve("t.json"));
        tr.record(partitionMsg("world_pop", "na", "file:/na.ndjson"),
                1, "agent-us", false);

        PartitionReconciler r = new PartitionReconciler(driver, tr, new PartitionPlacement.Hash());
        var out = r.reconcile();

        assertThat(out.stillLive()).hasSize(1);
        assertThat(out.rehashed()).isEmpty();
        assertThat(out.skippedExplicit()).isEmpty();
        assertThat(out.refused()).isEmpty();
        driver.close();
        t.close();
    }

    @Test
    void deadPartition_isRehashedToLiveAgent(@TempDir Path tmp) throws Exception {
        InMemoryMeshTransport t = new InMemoryMeshTransport();
        MeshDriver driver = new MeshDriver(t, new DistributedTableRegistry(), 30_000);
        driver.start();
        // Only agent-eu is live — agent-us in tracker is dead.
        announceAgent(t, "agent-eu");
        Thread.sleep(50);

        RuntimeTableTracker tr = new RuntimeTableTracker(tmp.resolve("t.json"));
        tr.record(partitionMsg("world_pop", "na", "file:/na.ndjson"),
                1, "agent-us", /*explicit=*/false);

        PartitionReconciler r = new PartitionReconciler(driver, tr, new PartitionPlacement.Hash());
        var out = r.reconcile();

        assertThat(out.rehashed()).hasSize(1);
        assertThat(out.rehashed().get(0)).containsEntry("newTarget", "agent-eu");
        assertThat(tr.snapshot().get(0).targetAgentId()).isEqualTo("agent-eu");
        driver.close();
        t.close();
    }

    @Test
    void explicitTarget_isNotRehashed_evenWhenDead(@TempDir Path tmp) throws Exception {
        InMemoryMeshTransport t = new InMemoryMeshTransport();
        MeshDriver driver = new MeshDriver(t, new DistributedTableRegistry(), 30_000);
        driver.start();
        announceAgent(t, "agent-eu");
        Thread.sleep(50);

        RuntimeTableTracker tr = new RuntimeTableTracker(tmp.resolve("t.json"));
        tr.record(partitionMsg("shards", "a", "file:/a.ndjson"),
                1, "agent-us", /*explicit=*/true);   // operator-pinned

        var out = new PartitionReconciler(driver, tr, new PartitionPlacement.Hash()).reconcile();

        assertThat(out.skippedExplicit()).hasSize(1);
        assertThat(out.rehashed()).isEmpty();
        // Tracker still points at the dead agent — operator intervenes.
        assertThat(tr.snapshot().get(0).targetAgentId()).isEqualTo("agent-us");
        driver.close();
        t.close();
    }

    @Test
    void noLiveAgents_refusesRehash(@TempDir Path tmp) throws Exception {
        InMemoryMeshTransport t = new InMemoryMeshTransport();
        MeshDriver driver = new MeshDriver(t, new DistributedTableRegistry(), 30_000);
        driver.start();
        // No heartbeats — live set empty.

        RuntimeTableTracker tr = new RuntimeTableTracker(tmp.resolve("t.json"));
        tr.record(partitionMsg("world_pop", "na", "file:/na.ndjson"),
                1, "agent-us", /*explicit=*/false);

        var out = new PartitionReconciler(driver, tr, new PartitionPlacement.Hash()).reconcile();

        assertThat(out.refused()).hasSize(1);
        assertThat(out.rehashed()).isEmpty();
        driver.close();
        t.close();
    }

    @Test
    void broadcastEntries_areIgnored(@TempDir Path tmp) throws Exception {
        InMemoryMeshTransport t = new InMemoryMeshTransport();
        MeshDriver driver = new MeshDriver(t, new DistributedTableRegistry(), 30_000);
        driver.start();
        announceAgent(t, "agent-eu");
        Thread.sleep(50);

        RuntimeTableTracker tr = new RuntimeTableTracker(tmp.resolve("t.json"));
        // Broadcast: partitionKey=null, targetAgentId=null → not partitioned
        RegisterTableMessage bcast = new RegisterTableMessage("world_pop",
                "{\"name\":\"world_pop\",\"fields\":[]}",
                "file:/all.ndjson", "ndjson",
                /*broadcast=*/true, null);
        tr.record(bcast, 2);

        var out = new PartitionReconciler(driver, tr, new PartitionPlacement.Hash()).reconcile();
        assertThat(out.rehashed()).isEmpty();
        assertThat(out.stillLive()).isEmpty();
        assertThat(out.refused()).isEmpty();
        driver.close();
        t.close();
    }
}
