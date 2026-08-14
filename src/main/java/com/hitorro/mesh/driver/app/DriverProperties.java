/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.hitorro.mesh.nats.NatsSecurityProperties;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * <pre>
 * hitorro:
 *   mesh:
 *     driver:
 *       transport: nats                      # nats | inmemory
 *       nats-url: nats://mesh.local:4222
 *       agent-expiry: 15s                    # after this without heartbeat, agent is "dead"
 *       tables:                              # bootstrap set of distributed tables
 *         - name: docs
 *           type-json-resource: classpath:types/docs.json
 *           partitions:
 *             - key: shard-1
 *               required-capabilities: [jvssql, partition:docs:shard-1]
 *             - key: shard-2
 *               required-capabilities: [jvssql, partition:docs:shard-2]
 * </pre>
 *
 * <p>Tables can also be registered at runtime via {@code POST /mesh/tables} —
 * useful for interactive sessions where the topology changes.</p>
 */
@ConfigurationProperties(prefix = "hitorro.mesh.driver")
public class DriverProperties {

    private Transport transport = Transport.NATS;
    private String natsUrl = "nats://localhost:4222";
    /**
     * TLS + authentication config for the NATS transport. Empty by default —
     * see {@link NatsSecurityProperties} for the knobs. Set the same block
     * on every mesh agent for a coherent secured cluster.
     */
    private NatsSecurityProperties natsSecurity = new NatsSecurityProperties();
    private Duration agentExpiry = Duration.ofSeconds(15);
    private List<TableConfig> tables = new ArrayList<>();

    /**
     * Distributed-combiner width for GROUP BY queries. 0 = combiner-at-driver
     * (phase-2 behavior, deterministic, no coordination overhead). N &gt; 0 =
     * distributed combine across up to N combine-worker tasks. Clamped to the
     * number of live jvssql-capable agents at query time. See
     * {@code QueryDispatcher.withShuffleWidth}.
     */
    private int shuffleWidth = 0;

    /**
     * Names of broadcast tables the mesh knows about. Driver's planner
     * allows JOINs against these; every agent is expected to pre-load them
     * via its {@code hitorro.mesh.agent.broadcast-tables} config. Phase 4a.
     */
    private List<String> broadcastTables = new ArrayList<>();

    public enum Transport { NATS, INMEMORY }

    public Transport getTransport() { return transport; }
    public void setTransport(Transport transport) { this.transport = transport; }

    public String getNatsUrl() { return natsUrl; }
    public void setNatsUrl(String natsUrl) { this.natsUrl = natsUrl; }

    public NatsSecurityProperties getNatsSecurity() { return natsSecurity; }
    public void setNatsSecurity(NatsSecurityProperties natsSecurity) { this.natsSecurity = natsSecurity; }

    public Duration getAgentExpiry() { return agentExpiry; }
    public void setAgentExpiry(Duration agentExpiry) { this.agentExpiry = agentExpiry; }

    public List<TableConfig> getTables() { return tables; }
    public void setTables(List<TableConfig> tables) { this.tables = tables; }

    public int getShuffleWidth() { return shuffleWidth; }
    public void setShuffleWidth(int shuffleWidth) { this.shuffleWidth = shuffleWidth; }

    public List<String> getBroadcastTables() { return broadcastTables; }
    public void setBroadcastTables(List<String> broadcastTables) { this.broadcastTables = broadcastTables; }

    public static class TableConfig {
        private String name;
        private String typeJsonResource;
        private List<PartitionConfig> partitions = new ArrayList<>();

        public String getName() { return name; }
        public void setName(String name) { this.name = name; }

        public String getTypeJsonResource() { return typeJsonResource; }
        public void setTypeJsonResource(String v) { this.typeJsonResource = v; }

        public List<PartitionConfig> getPartitions() { return partitions; }
        public void setPartitions(List<PartitionConfig> p) { this.partitions = p; }
    }

    public static class PartitionConfig {
        private String key;
        private List<String> requiredCapabilities = new ArrayList<>();
        private long approxRowCount = -1;

        public String getKey() { return key; }
        public void setKey(String key) { this.key = key; }

        public List<String> getRequiredCapabilities() { return requiredCapabilities; }
        public void setRequiredCapabilities(List<String> v) { this.requiredCapabilities = v; }

        public long getApproxRowCount() { return approxRowCount; }
        public void setApproxRowCount(long v) { this.approxRowCount = v; }
    }
}
