/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.hitorro.mesh.RegisterTableMessage;
import com.hitorro.mesh.driver.MeshDriver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Reactive re-hash for partitioned runtime tables — spots partitions
 * whose target agent has dropped from the live set and re-assigns
 * them to a currently-alive agent via {@link PartitionPlacement}.
 *
 * <p>Called via {@code POST /mesh/queries/registered/reconcile-partitions}
 * (manual trigger for now; background polling is a follow-up). Walks
 * the {@link RuntimeTableTracker}'s partition entries, checks each
 * target against {@code driver.agents().agentsWith(["jvssql"])}, and
 * for any orphan:</p>
 * <ul>
 *   <li>If the operator supplied an explicit {@code agentId} at
 *       register-time ({@code explicitTarget=true}) — refuse to
 *       re-assign. Sticky routing was intentional; the operator gets
 *       to intervene.</li>
 *   <li>Otherwise, re-run {@link PartitionPlacement} against the
 *       current live set, publish a fresh
 *       {@link RegisterTableMessage} to the new target, update the
 *       tracker entry.</li>
 * </ul>
 *
 * <p>Result payload lists what was re-hashed, what was skipped-as-
 * explicit, what still-live (no action needed), and what couldn't be
 * re-hashed (placement returned no candidate — e.g. zero live agents).</p>
 */
@Component
public class PartitionReconciler {

    private static final Logger log = LoggerFactory.getLogger(PartitionReconciler.class);

    private final MeshDriver driver;
    private final RuntimeTableTracker tracker;
    private final PartitionPlacement placement;

    public PartitionReconciler(MeshDriver driver, RuntimeTableTracker tracker,
                               PartitionPlacement placement) {
        this.driver = driver;
        this.tracker = tracker;
        this.placement = placement;
    }

    public record Outcome(
            List<Map<String, Object>> rehashed,
            List<Map<String, Object>> skippedExplicit,
            List<Map<String, Object>> stillLive,
            List<Map<String, Object>> refused,
            List<Map<String, Object>> withinGrace) { }

    /** First-missing timestamp per agent-id — used by the grace-period
     *  filter. Reset when the agent comes back or its entries reconcile. */
    private final java.util.Map<String, Long> firstMissingAt = new java.util.concurrent.ConcurrentHashMap<>();

    /** Manual trigger — immediate re-hash on any dead target. */
    public Outcome reconcile() {
        return reconcile(0L);
    }

    /**
     * Reconcile with a grace period — only re-hash partitions whose
     * target has been continuously absent for at least {@code graceMs}.
     * A target that comes back before grace expires clears its
     * "first-missing" tracker. Used by the background poller to avoid
     * flapping on transient heartbeat gaps.
     */
    public synchronized Outcome reconcile(long graceMs) {
        // Snapshot current live jvssql agents once — every partition
        // decision uses the same reference set for consistency.
        Set<String> live = new java.util.LinkedHashSet<>();
        driver.agents().agentsWith(List.of("jvssql"))
                .forEach(a -> live.add(a.agentId()));
        long now = System.currentTimeMillis();
        // Clear first-missing marks for agents that are back.
        firstMissingAt.keySet().retainAll(
                firstMissingAt.keySet().stream().filter(id -> !live.contains(id)).toList());

        List<Map<String, Object>> rehashed = new ArrayList<>();
        List<Map<String, Object>> skippedExplicit = new ArrayList<>();
        List<Map<String, Object>> stillLive = new ArrayList<>();
        List<Map<String, Object>> refused = new ArrayList<>();
        List<Map<String, Object>> withinGrace = new ArrayList<>();

        for (RuntimeTableTracker.Entry e : tracker.snapshot()) {
            // Only partitioned entries need reactive re-hash — broadcast
            // tables install on every agent, no per-partition target.
            if (e.broadcast() || e.targetAgentId() == null) continue;

            if (live.contains(e.targetAgentId())) {
                stillLive.add(entryMap(e, e.targetAgentId(), "target still alive"));
                continue;
            }
            if (e.explicitTarget()) {
                skippedExplicit.add(entryMap(e, e.targetAgentId(),
                        "operator-pinned to dead agent; won't auto-reassign"));
                continue;
            }
            // Grace-period check: if this is the first pass where the
            // target is missing, mark it and wait. Only re-hash when
            // it's been continuously absent for graceMs.
            if (graceMs > 0) {
                long firstAt = firstMissingAt.computeIfAbsent(e.targetAgentId(), k -> now);
                if (now - firstAt < graceMs) {
                    Map<String, Object> row = entryMap(e, e.targetAgentId(), "within grace period");
                    row.put("missingForMs", now - firstAt);
                    row.put("graceMs", graceMs);
                    withinGrace.add(row);
                    continue;
                }
            }
            // Re-hash. Placement runs on the CURRENT live set — new
            // assignments respect the strategy operator picked at boot.
            Map<String, String> assigned = placement.assign(
                    e.name(), List.of(e.partitionKey()), new ArrayList<>(live));
            String newTarget = assigned.get(e.partitionKey());
            if (newTarget == null) {
                refused.add(entryMap(e, e.targetAgentId(),
                        "no live agent to re-hash onto"));
                continue;
            }
            RegisterTableMessage msg = new RegisterTableMessage(
                    e.name(), e.typeJson(), e.uri(), e.format(),
                    /*broadcast=*/false, e.partitionKey(),
                    /*sourceConfig=*/null, newTarget);
            driver.publishRegisterTable(msg);
            // Tracker: forget the old entry (with the dead agent) then
            // record fresh with the new target.
            tracker.forget(e.name(), e.partitionKey());
            tracker.record(msg, 1, newTarget, /*explicitTarget=*/false);
            Map<String, Object> row = entryMap(e, e.targetAgentId(), "re-hashed");
            row.put("newTarget", newTarget);
            rehashed.add(row);
            firstMissingAt.remove(e.targetAgentId());   // reconciled — clear the mark
            log.info("re-hash: {} pk={} was on {} (dead) → now on {}",
                    e.name(), e.partitionKey(), e.targetAgentId(), newTarget);
        }
        return new Outcome(rehashed, skippedExplicit, stillLive, refused, withinGrace);
    }

    private static Map<String, Object> entryMap(RuntimeTableTracker.Entry e,
                                                String currentTarget, String reason) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", e.name());
        m.put("partitionKey", e.partitionKey());
        m.put("uri", e.uri());
        m.put("currentTarget", currentTarget);
        m.put("reason", reason);
        return m;
    }
}
