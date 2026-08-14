/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.hitorro.mesh.driver.DistributedTable;
import com.hitorro.mesh.driver.MeshDriver;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * Phase 7j — mesh-level health check exposed at {@code /actuator/health/mesh}.
 * Composes into the top-level {@code /actuator/health} status alongside the
 * default Spring Boot checks (disk space, ping, etc.), so a kubelet
 * livenessProbe or an external monitoring probe sees the mesh's readiness
 * state, not just the JVM.
 *
 * <h3>Statuses</h3>
 * <ul>
 *   <li><b>UP</b> — every declared partition has at least one eligible
 *       agent heartbeating with the right capabilities.</li>
 *   <li><b>OUT_OF_SERVICE</b> — some partitions have zero eligible
 *       agents; queries touching those partitions will fail. Non-fatal
 *       (rolling deploy, agent restart mid-flight), but K8s should stop
 *       routing traffic here.</li>
 *   <li><b>DOWN</b> — driver knows about tables but sees zero live agents
 *       at all. Every query will fail.</li>
 * </ul>
 *
 * <p>Details always include per-table partition-coverage stats so
 * operators can see which shard is missing.</p>
 */
@Component("mesh")
public class MeshHealthIndicator implements HealthIndicator {

    private final MeshDriver driver;

    public MeshHealthIndicator(MeshDriver driver) {
        this.driver = driver;
    }

    @Override
    public Health health() {
        int liveAgents = driver.agents().agentsWith(List.of("jvssql")).size();

        // Per-partition coverage: for each declared partition, count eligible
        // agents (those advertising all of the partition's requiredCapabilities).
        List<String> uncoveredPartitions = new ArrayList<>();
        int totalPartitions = 0;
        int totalTables = driver.tables().all().size();
        for (DistributedTable t : driver.tables().all()) {
            for (var p : t.partitions()) {
                totalPartitions++;
                int eligible = driver.agents().agentsWith(new ArrayList<>(p.requiredCapabilities())).size();
                if (eligible == 0) uncoveredPartitions.add(t.name() + ":" + p.key());
            }
        }

        Health.Builder b = Health.up()
                .withDetail("liveAgents", liveAgents)
                .withDetail("registeredTables", totalTables)
                .withDetail("registeredPartitions", totalPartitions)
                .withDetail("broadcastTables", driver.tables().broadcastNames().size())
                .withDetail("streamingTables", driver.tables().streamingTableNames().size());

        if (totalPartitions == 0) {
            // No tables registered at all — treat as UP (dev / warmup);
            // the driver is running, just idle.
            return b.build();
        }
        if (liveAgents == 0) {
            return Health.down()
                    .withDetail("liveAgents", 0)
                    .withDetail("registeredPartitions", totalPartitions)
                    .withDetail("reason", "no jvssql-capable agents heartbeating")
                    .build();
        }
        if (!uncoveredPartitions.isEmpty()) {
            return Health.outOfService()
                    .withDetail("liveAgents", liveAgents)
                    .withDetail("registeredPartitions", totalPartitions)
                    .withDetail("uncoveredPartitions", uncoveredPartitions)
                    .withDetail("reason", "some partitions have no eligible agents")
                    .build();
        }
        return b.build();
    }
}
