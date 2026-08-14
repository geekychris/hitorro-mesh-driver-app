/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.hitorro.mesh.driver.MeshDriver;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Micrometer instrumentation for the mesh driver. All meters are prefixed
 * {@code mesh_}. Scraped via {@code /actuator/prometheus} when the
 * Prometheus registry is on the classpath.
 *
 * <h3>Meters</h3>
 * <ul>
 *   <li>{@code mesh_queries_total{outcome}} — counter, tagged {@code ok} or {@code error}</li>
 *   <li>{@code mesh_query_duration_seconds{outcome}} — timer histogram, per query submit</li>
 *   <li>{@code mesh_rows_returned_total} — counter of result rows delivered to clients</li>
 *   <li>{@code mesh_agents_live} — gauge — live jvssql-capable agent count</li>
 *   <li>{@code mesh_tables_registered} — gauge — number of distributed tables</li>
 *   <li>{@code mesh_broadcast_tables_registered} — gauge — number of broadcast tables</li>
 * </ul>
 *
 * <p>Standard JVM meters ({@code jvm_*}, {@code process_*},
 * {@code system_cpu_usage}, {@code http_server_requests_seconds}) come
 * for free via Spring Boot Actuator + Micrometer.</p>
 */
@Component
public class MeshMetrics {

    private final Timer submitTimerOk;
    private final Timer submitTimerErr;
    private final Counter queriesOk;
    private final Counter queriesErr;
    private final Counter rowsReturned;

    public MeshMetrics(MeterRegistry registry, MeshDriver driver) {
        this.queriesOk = Counter.builder("mesh.queries")
                .tag("outcome", "ok")
                .description("distributed queries that returned a result")
                .register(registry);
        this.queriesErr = Counter.builder("mesh.queries")
                .tag("outcome", "error")
                .description("distributed queries that errored (plan-time or runtime)")
                .register(registry);
        this.submitTimerOk = Timer.builder("mesh.query.duration")
                .tag("outcome", "ok")
                .description("wall-clock time from submit to full result set")
                .publishPercentileHistogram()
                .register(registry);
        this.submitTimerErr = Timer.builder("mesh.query.duration")
                .tag("outcome", "error")
                .publishPercentileHistogram()
                .register(registry);
        this.rowsReturned = Counter.builder("mesh.rows.returned")
                .description("total result rows delivered to clients (across all queries)")
                .register(registry);

        // Gauges pull straight from the driver's live state — cheap, always fresh.
        registry.gauge("mesh.agents.live", driver,
                d -> d.agents().agentsWith(List.of("jvssql")).size());
        registry.gauge("mesh.tables.registered", driver,
                d -> d.tables().all().size());
        registry.gauge("mesh.broadcast.tables.registered", driver,
                d -> d.tables().broadcastNames().size());
    }

    Timer submitTimerOk()   { return submitTimerOk; }
    Timer submitTimerErr()  { return submitTimerErr; }
    Counter queriesOk()     { return queriesOk; }
    Counter queriesErr()    { return queriesErr; }
    Counter rowsReturned()  { return rowsReturned; }
}
