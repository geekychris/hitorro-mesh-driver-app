/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Wires the configured {@link PartitionPlacement} bean.
 *
 * <p>Config: {@code hitorro.mesh.runtime.placement} —
 * {@code hash} (default) / {@code round-robin} / {@code custom}
 * (if custom, a caller-supplied {@code PartitionPlacement} bean
 * must already be in the context).</p>
 */
@Configuration
public class PartitionPlacementConfig {

    @Bean
    @org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean(PartitionPlacement.class)
    public PartitionPlacement partitionPlacement(
            @Value("${hitorro.mesh.runtime.placement:hash}") String kind) {
        return switch (kind == null ? "hash" : kind.toLowerCase()) {
            case "round-robin" -> new PartitionPlacement.RoundRobin();
            case "hash"        -> new PartitionPlacement.Hash();
            default -> throw new IllegalStateException(
                    "unknown placement '" + kind + "' — supported: hash, round-robin, custom");
        };
    }
}
