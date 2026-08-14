/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.fasterxml.jackson.databind.JsonNode;
import com.hitorro.mesh.AgentDescriptor;
import com.hitorro.mesh.driver.DistributedTable;
import com.hitorro.mesh.driver.DistributedTableRegistry;
import com.hitorro.mesh.driver.MeshDriver;
import com.hitorro.mesh.driver.QueryDispatcher;
import com.hitorro.mesh.orion.ClusterManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Minimal REST surface for phase-1 mesh use.
 *
 * <pre>
 * POST /mesh/queries       body: {"sql": "SELECT id FROM docs WHERE lang='en'", "timeoutMs": 5000}
 *                          returns: {"queryId": "...", "assignedAgents": [...], "rowCount": N, "rows": [...]}
 *
 * GET  /mesh/agents        returns: [{"agentId":"...","capabilities":[...],"startedAtMillis":...}]
 *
 * GET  /mesh/tables        returns: [{"name":"docs","partitions":[{"key":"shard-1","requiredCapabilities":[...]}]}]
 * </pre>
 *
 * <p>Phase 1 collects the entire result set before returning. Phase 1.5 will
 * add Server-Sent Events (SSE) for streaming result rows to the client so
 * queries with big result sets don't buffer the whole thing in driver RAM.</p>
 */
@RestController
@RequestMapping("/mesh")
public class MeshRestController {

    private static final Logger log = LoggerFactory.getLogger(MeshRestController.class);

    private final MeshDriver driver;
    private final ClusterManager clusterManager;
    private final MeshMetrics metrics;
    /**
     * One thread per active SSE query — each pulls rows from the QueryHandle
     * and pushes them to the client. Kept as an unbounded pool because SSE
     * connections are long-lived; capping would just push back-pressure
     * onto the request thread. Daemon threads so shutdown doesn't hang.
     */
    private final ScheduledExecutorService sseWorkers = Executors.newScheduledThreadPool(
            Math.max(2, Runtime.getRuntime().availableProcessors()),
            r -> {
                Thread t = new Thread(r, "mesh-sse-worker");
                t.setDaemon(true);
                return t;
            });

    public MeshRestController(MeshDriver driver, ClusterManager clusterManager, MeshMetrics metrics) {
        this.driver = driver;
        this.clusterManager = clusterManager;
        this.metrics = metrics;
    }

    @PostMapping("/queries")
    public QueryResponse submit(@RequestBody QueryRequest req) throws Exception {
        long timeout = req.timeoutMs > 0 ? req.timeoutMs : 5_000;
        long tStart = System.nanoTime();
        try (QueryDispatcher.QueryHandle h = driver.dispatcher().submit(req.sql)) {
            List<JsonNode> rows = h.collect(timeout, TimeUnit.MILLISECONDS);
            metrics.submitTimerOk().record(System.nanoTime() - tStart, TimeUnit.NANOSECONDS);
            metrics.queriesOk().increment();
            metrics.rowsReturned().increment(rows.size());
            return new QueryResponse(h.queryId(), h.assignedAgents(), rows.size(), rows);
        } catch (RuntimeException e) {
            metrics.submitTimerErr().record(System.nanoTime() - tStart, TimeUnit.NANOSECONDS);
            metrics.queriesErr().increment();
            throw e;
        }
    }

    /**
     * Server-Sent Events variant: yields one {@code data:} event per row as
     * soon as it arrives at the driver. Composes naturally with the phase-6a
     * streaming source (agents keep publishing rows, driver keeps forwarding
     * them to the client) AND with batch queries (client receives rows in
     * arrival order, then a {@code complete} event when the query ends).
     *
     * <p>Client disconnect closes the {@link QueryDispatcher.QueryHandle}
     * (unsubscribes from the result subject). For batch queries this just
     * stops the client from receiving more rows — agents still finish their
     * work. Cancel-through-to-agents (interrupting long-running streams)
     * ships in phase 6c.2.</p>
     *
     * <pre>
     * curl -N 'http://localhost:8085/mesh/queries/stream?sql=SELECT+id+FROM+docs'
     * </pre>
     *
     * @param sql        query text (URL-encoded)
     * @param timeoutMs  emitter timeout — how long we wait between rows before
     *                   the SSE connection is considered dead. Default 5 minutes.
     */
    @GetMapping(value = "/queries/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@RequestParam("sql") String sql,
                             @RequestParam(name = "timeoutMs", defaultValue = "300000") long timeoutMs) {
        SseEmitter emitter = new SseEmitter(timeoutMs);
        QueryDispatcher.QueryHandle handle;
        try {
            handle = driver.dispatcher().submit(sql);
        } catch (RuntimeException e) {
            // Send the error as an SSE event and close — the caller sees a proper
            // 200 with a machine-readable event rather than a raw 400 body.
            try {
                emitter.send(SseEmitter.event().name("error").data(Map.of("error", e.getMessage())));
                emitter.complete();
            } catch (Exception ignored) {}
            return emitter;
        }

        // Send an initial "opened" event with query metadata — clients can
        // use this to correlate rows with the query and know which agents
        // are participating.
        try {
            emitter.send(SseEmitter.event().name("opened").data(Map.of(
                    "queryId", handle.queryId(),
                    "assignedAgents", handle.assignedAgents())));
        } catch (Exception e) {
            handle.close();
            return emitter;
        }

        // Client-disconnect / timeout hooks — close the handle so we don't
        // keep the result subscription alive for a dead client. If the source
        // is streaming this doesn't stop the agents (phase 6c.2 will), but
        // it stops the driver from receiving further rows.
        emitter.onCompletion(handle::close);
        emitter.onTimeout(() -> { handle.close(); emitter.complete(); });
        emitter.onError(t -> handle.close());

        long sseStart = System.nanoTime();
        // Background worker: pull rows, push events. One row per SSE event.
        sseWorkers.submit(() -> {
            long rowCount = 0;
            try {
                while (true) {
                    JsonNode row = handle.nextRow(timeoutMs, TimeUnit.MILLISECONDS);
                    if (row == null) break;
                    emitter.send(SseEmitter.event().name("row").data(row));
                    rowCount++;
                }
                emitter.send(SseEmitter.event().name("complete")
                        .data(Map.of("queryId", handle.queryId(), "rowCount", rowCount)));
                emitter.complete();
                metrics.submitTimerOk().record(System.nanoTime() - sseStart, TimeUnit.NANOSECONDS);
                metrics.queriesOk().increment();
                metrics.rowsReturned().increment(rowCount);
            } catch (java.io.IOException ioe) {
                // Client disconnected mid-send — normal; not an error.
                handle.close();
                emitter.complete();
                metrics.submitTimerOk().record(System.nanoTime() - sseStart, TimeUnit.NANOSECONDS);
                metrics.queriesOk().increment();
                metrics.rowsReturned().increment(rowCount);
            } catch (Throwable t) {
                try {
                    emitter.send(SseEmitter.event().name("error").data(Map.of("error", t.getMessage())));
                } catch (Exception ignored) {}
                handle.close();
                emitter.completeWithError(t);
                metrics.submitTimerErr().record(System.nanoTime() - sseStart, TimeUnit.NANOSECONDS);
                metrics.queriesErr().increment();
            }
        });

        return emitter;
    }

    @GetMapping("/agents")
    public List<AgentDescriptor> agents() {
        return driver.agents().agentsWith(List.of("jvssql"));
    }

    /**
     * Merged view: for each declared+live agent, report its status.
     * <ul>
     *   <li>{@code HEALTHY}   — declared and heartbeating</li>
     *   <li>{@code MISSING}   — declared but no heartbeat (dead or not yet up)</li>
     *   <li>{@code ORPHAN}    — heartbeating but not declared (rogue / stale config)</li>
     * </ul>
     * When no platform bridge is configured, everything shows as ORPHAN
     * (or nothing shows, if no agents heartbeat). Set
     * {@code hitorro.mesh.driver.cluster=orion|k8s} to enable the enrichment.
     */
    @GetMapping("/cluster")
    public Map<String, Object> cluster() {
        Set<ClusterManager.DeclaredAgent> declared = clusterManager.declaredAgents();
        List<AgentDescriptor> live = driver.agents().agentsWith(List.of("jvssql"));
        Set<String> declaredNames = new HashSet<>();
        for (var d : declared) declaredNames.add(d.name());
        Set<String> liveNames = new HashSet<>();
        for (var l : live) liveNames.add(l.agentId());

        List<Map<String, Object>> combined = new java.util.ArrayList<>();
        // Every declared agent first — HEALTHY if it heartbeats, MISSING if not.
        for (var d : declared) {
            String status = liveNames.contains(d.name()) ? "HEALTHY" : "MISSING";
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", d.name());
            entry.put("status", status);
            entry.put("declaredCapabilities", d.declaredCapabilities());
            entry.put("nodeName", d.nodeName());
            clusterManager.consoleUrl(d.name()).ifPresent(u -> entry.put("consoleUrl", u.toString()));
            combined.add(entry);
        }
        // Live agents not in the declared set — ORPHAN.
        for (var l : live) {
            if (declaredNames.contains(l.agentId())) continue;
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", l.agentId());
            entry.put("status", "ORPHAN");
            entry.put("declaredCapabilities", Set.of());
            entry.put("liveCapabilities", l.capabilities());
            combined.add(entry);
        }
        return Map.of(
                "platform", clusterManager.platform(),
                "agents", combined);
    }

    @GetMapping("/tables")
    public List<Map<String, Object>> tables() {
        return driver.tables().all().stream()
                .map(t -> Map.<String, Object>of(
                        "name", t.name(),
                        "partitions", t.partitions()))
                .toList();
    }

    public record QueryRequest(String sql, long timeoutMs) {}

    public record QueryResponse(String queryId, List<String> assignedAgents, int rowCount, List<JsonNode> rows) {}

    public DistributedTableRegistry registry() { return driver.tables(); }

    // ------------------------------------------------------------------
    // GlobalExceptionHandler covers IllegalArgumentException (bad SQL,
    // unknown table, phase-1 unsupported aggregate) → 400 Bad Request.

    @ExceptionHandler({ IllegalArgumentException.class, IllegalStateException.class })
    @ResponseStatus(org.springframework.http.HttpStatus.BAD_REQUEST)
    public Map<String, String> badRequest(RuntimeException e) {
        return Map.of("error", e.getMessage());
    }
}
