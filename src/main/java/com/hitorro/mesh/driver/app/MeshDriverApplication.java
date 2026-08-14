/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hitorro.jsontypesystem.Type;
import com.hitorro.mesh.InMemoryMeshTransport;
import com.hitorro.mesh.MeshTransport;
import com.hitorro.mesh.driver.DistributedTable;
import com.hitorro.mesh.driver.DistributedTableRegistry;
import com.hitorro.mesh.driver.MeshDriver;
import com.hitorro.mesh.nats.NatsMeshTransport;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;

import java.util.List;
import java.util.Set;

/**
 * Runnable Spring Boot mesh driver.
 *
 * <p>Wires a {@link MeshTransport} (NATS or in-memory), builds a
 * {@link MeshDriver}, populates the {@link DistributedTableRegistry} from
 * config, and stands up REST endpoints via {@link MeshRestController}.</p>
 *
 * <p>Same JAR works whether NATS runs on the same box (dev) or across a
 * cluster (prod). Transport pluggability is the point.</p>
 */
@SpringBootApplication
@EnableConfigurationProperties({ DriverProperties.class, ClusterManagerProperties.class })
@org.springframework.context.annotation.Import(ClusterManagerAutoConfig.class)
public class MeshDriverApplication implements DisposableBean {

    private static final Logger log = LoggerFactory.getLogger(MeshDriverApplication.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private MeshTransport transport;
    private MeshDriver driver;

    public static void main(String[] args) {
        SpringApplication.run(MeshDriverApplication.class, args);
    }

    @Bean
    public MeshTransport meshTransport(DriverProperties props) {
        return switch (props.getTransport()) {
            case NATS -> {
                com.hitorro.mesh.nats.NatsSecurity sec = props.getNatsSecurity() == null
                        ? com.hitorro.mesh.nats.NatsSecurity.none()
                        : props.getNatsSecurity().toSecurity();
                log.info("mesh: driver opening NATS transport to {} (tls={}, auth={})",
                        props.getNatsUrl(),
                        sec.requiresTls() || props.getNatsUrl().startsWith("tls://"),
                        describeAuth(sec));
                yield NatsMeshTransport.openUrl(props.getNatsUrl(), sec);
            }
            case INMEMORY -> {
                log.info("mesh: driver using in-memory transport (single-JVM mode)");
                yield new InMemoryMeshTransport();
            }
        };
    }

    private static String describeAuth(com.hitorro.mesh.nats.NatsSecurity sec) {
        if (sec.credentialsFile() != null && !sec.credentialsFile().isBlank()) return "creds-file";
        if (sec.token() != null && !sec.token().isBlank()) return "token";
        if (sec.username() != null && !sec.username().isBlank()) return "user/pass";
        return "none";
    }

    @Bean
    public MeshDriver meshDriver(MeshTransport transport,
                                 DriverProperties props,
                                 ResourceLoader loader) throws Exception {
        this.transport = transport;
        DistributedTableRegistry registry = new DistributedTableRegistry();

        for (DriverProperties.TableConfig tc : props.getTables()) {
            Type type = new Type();
            Resource typeRes = loader.getResource(tc.getTypeJsonResource());
            try (var in = typeRes.getInputStream()) {
                type.init(MAPPER.readTree(in));
            }
            List<DistributedTable.Partition> parts = tc.getPartitions().stream()
                    .map(pc -> new DistributedTable.Partition(
                            pc.getKey(),
                            Set.copyOf(pc.getRequiredCapabilities()),
                            pc.getApproxRowCount()))
                    .toList();
            registry.register(new BasicDistributedTable(tc.getName(), type, parts));
            log.info("mesh: registered table {} with {} partition(s)", tc.getName(), parts.size());
        }
        for (String bc : props.getBroadcastTables()) {
            registry.registerBroadcast(bc);
            log.info("mesh: registered broadcast table {} (must exist on every agent)", bc);
        }

        MeshDriver d = new MeshDriver(transport, registry, props.getAgentExpiry().toMillis());
        d.dispatcher().withShuffleWidth(props.getShuffleWidth());
        d.start();
        this.driver = d;
        log.info("mesh: driver online, agent-expiry={}ms, shuffle-width={} ({})",
                props.getAgentExpiry().toMillis(),
                props.getShuffleWidth(),
                props.getShuffleWidth() > 0 ? "distributed combiner" : "combiner-at-driver");
        return d;
    }

    @Override
    public void destroy() {
        if (driver != null) driver.close();
        if (transport != null) transport.close();
    }

    private record BasicDistributedTable(String name, Type type, List<DistributedTable.Partition> partitions)
            implements DistributedTable {}
}
