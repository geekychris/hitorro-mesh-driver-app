/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Optional background loop that periodically calls
 * {@link PartitionReconciler#reconcile(long)} with a grace period, so
 * partitioned tables self-heal when a target agent drops out.
 *
 * <p>Off by default — set {@code hitorro.mesh.runtime.reconcile.enabled=true}
 * to activate. Two knobs:</p>
 * <ul>
 *   <li>{@code hitorro.mesh.runtime.reconcile.interval-ms} — how often
 *       the poller fires. Default 30s.</li>
 *   <li>{@code hitorro.mesh.runtime.reconcile.grace-ms} — how long a
 *       target must be continuously absent before re-hash triggers.
 *       Default 15s (matches the default agent-expiry so we don't
 *       flap during a heartbeat blip).</li>
 * </ul>
 *
 * <p>Bounded logging: only writes an INFO line when it actually
 * re-hashes something. Reconciles that find nothing to do stay quiet
 * to keep operator logs uncluttered.</p>
 */
@Component
@ConditionalOnProperty(prefix = "hitorro.mesh.runtime.reconcile", name = "enabled",
        havingValue = "true", matchIfMissing = false)
public class PartitionReconcilerPoller {

    private static final Logger log = LoggerFactory.getLogger(PartitionReconcilerPoller.class);

    private final PartitionReconciler reconciler;
    private final long graceMs;

    public PartitionReconcilerPoller(PartitionReconciler reconciler,
                                     @Value("${hitorro.mesh.runtime.reconcile.grace-ms:15000}") long graceMs) {
        this.reconciler = reconciler;
        this.graceMs = graceMs;
        log.info("partition-reconciler-poller: enabled (grace={}ms)", graceMs);
    }

    /**
     * Fires every {@code interval-ms} (default 30s). {@code fixedDelayString}
     * so the poll cadence is measured from finish-of-last to start-of-next
     * (avoids overlap when a reconcile takes >interval).
     */
    @Scheduled(fixedDelayString = "${hitorro.mesh.runtime.reconcile.interval-ms:30000}")
    public void poll() {
        try {
            var out = reconciler.reconcile(graceMs);
            int changed = out.rehashed().size();
            int refused = out.refused().size();
            if (changed > 0 || refused > 0) {
                log.info("partition-reconciler-poller: re-hashed {}, refused {} (skippedExplicit={}, withinGrace={}, stillLive={})",
                        changed, refused, out.skippedExplicit().size(),
                        out.withinGrace().size(), out.stillLive().size());
            }
        } catch (Exception e) {
            log.warn("partition-reconciler-poller: iteration failed: {}", e.toString());
        }
    }
}
