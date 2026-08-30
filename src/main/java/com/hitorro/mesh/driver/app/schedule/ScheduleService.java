/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.schedule;

import com.hitorro.mesh.pipelines.model.JobSpec;
import com.hitorro.mesh.pipelines.parse.JobSpecYaml;
import com.hitorro.mesh.pipelines.runtime.JobRegistry;
import com.hitorro.mesh.pipelines.runtime.JobRunner;
import com.hitorro.mesh.pipelines.runtime.JobStatus;
import com.hitorro.mesh.pipelines.schedule.Schedule;
import com.hitorro.mesh.pipelines.schedule.TemplateSubstitution;
import com.hitorro.util.persist.JsonFileEntityStore;
import com.hitorro.util.persist.NamedTextValueStore;
import com.hitorro.util.scheduler.durable.DurableScheduler;
import com.hitorro.util.scheduler.durable.ScheduleContext;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Mesh-specific glue between the generic
 * {@link DurableScheduler} in hitorro-util and the mesh runtime:
 * substitutes {@code ${CHECKPOINT}} etc. into the schedule's YAML,
 * parses to a {@link JobSpec}, runs it through {@link JobRunner},
 * publishes the resulting {@link JobStatus} to the same
 * {@link JobRegistry} the {@code /mesh/jobs} endpoint reads from,
 * and honours a step's {@code ctx.setCheckpoint(...)} write-back.
 *
 * <p>All the "when to fire, when to catch up, how to persist,
 * maxConcurrent gating, checkpoint advance policy" behaviour lives
 * in {@link DurableScheduler} — this class supplies the action body
 * and the mesh-specific glue.</p>
 */
@Service
public class ScheduleService {

    private static final Logger log = LoggerFactory.getLogger(ScheduleService.class);

    private final JobRunner runner;
    private final JobRegistry jobRegistry;
    private final DurableScheduler<Schedule> engine;
    private final Path home;
    /** Records the most recent JobStatus per schedule for /show endpoints —
     *  DurableScheduler doesn't know about JobStatus so we keep our own map. */
    private final Map<String, JobStatus> lastStatus = new ConcurrentHashMap<>();

    public ScheduleService(JobRunner runner,
                           JobRegistry jobRegistry,
                           TaskScheduler taskScheduler,
                           @Value("${hitorro.mesh.schedule.home:#{null}}") String homeOverride) throws IOException {
        this.runner = runner;
        this.jobRegistry = jobRegistry;
        this.home = resolveHome(homeOverride);
        Files.createDirectories(this.home);

        JsonFileEntityStore<Schedule> store = new JsonFileEntityStore<>(
                this.home.resolve("schedules.json"), Schedule.class, s -> s.name);
        NamedTextValueStore checkpoints = new NamedTextValueStore(
                this.home.resolve("checkpoints"));

        this.engine = new DurableScheduler<>(store, checkpoints,
                new SpringTriggerBinder(taskScheduler),
                this::runMeshJob);
    }

    private static Path resolveHome(String override) {
        if (override != null && !override.isBlank()) return Path.of(override);
        String htData = System.getenv("HT_DATA");
        if (htData != null && !htData.isBlank()) return Path.of(htData, "schedules");
        return Path.of(System.getProperty("user.home"), ".hitorro", "schedules");
    }

    @PostConstruct
    void bootstrap() {
        log.info("scheduler: home={}  loading persisted schedules", home);
        engine.bootstrap();
    }

    @PreDestroy
    void shutdown() {
        engine.shutdown();
    }

    // ---- Action body — the one mesh-specific piece -------------------

    /**
     * Called by {@link DurableScheduler} on every trigger. Renders the
     * schedule's YAML with {@code ${CHECKPOINT}} etc, parses to
     * {@link JobSpec}, runs it, and mirrors any
     * {@link JobStatus#scheduledCheckpointOverride} onto the context
     * so the engine's checkpoint-advance policy honours it.
     *
     * <p>Throws to signal failure — the engine treats that as
     * "don't advance the checkpoint, record lastError."</p>
     */
    private void runMeshJob(ScheduleContext<Schedule> ctx) {
        Schedule s = ctx.schedule();
        String rendered = TemplateSubstitution.render(s.jobYaml, s.name, ctx.checkpoint(), ctx.now());
        JobSpec spec;
        try {
            spec = JobSpecYaml.parse(rendered);
        } catch (Exception e) {
            throw new RuntimeException("yaml: " + e.getMessage(), e);
        }
        JobStatus status = new JobStatus(
                "schedule-" + s.name + "-" + ctx.now().toEpochMilli(), spec.id());
        lastStatus.put(s.name, status);
        jobRegistry.register(status);
        log.info("scheduler [{}] run {} — checkpoint='{}'{}", s.name,
                status.jobId, ctx.checkpoint(), ctx.isCatchup() ? " (catch-up)" : "");
        try {
            runner.run(spec, status);
        } finally {
            jobRegistry.onTerminal(status);
        }
        if (status.state != JobStatus.State.SUCCEEDED) {
            throw new RuntimeException(status.state == null ? "no state" : status.state.name());
        }
        // Bubble a job-set checkpoint (from ctx.setCheckpoint in a
        // groovy-map step) up to the engine's context so it wins over
        // the default ${NOW} stamp.
        if (status.scheduledCheckpointOverride != null) {
            ctx.setCheckpoint(status.scheduledCheckpointOverride);
        }
    }

    // ---- Public API for the controller — thin delegation -------------

    public List<Schedule> list() { return engine.list(); }

    public Schedule get(String name) { return engine.get(name); }

    public Schedule save(Schedule s) throws IOException { return engine.save(s); }

    public boolean delete(String name) throws IOException {
        lastStatus.remove(name);
        return engine.delete(name);
    }

    public Schedule setEnabled(String name, boolean enabled) throws IOException {
        return engine.setEnabled(name, enabled);
    }

    public String getCheckpoint(String name) { return engine.getCheckpoint(name); }

    public void setCheckpoint(String name, String value) throws IOException {
        engine.setCheckpoint(name, value);
    }

    /** Trigger immediately. Returns the JobStatus of the fired run, or
     *  null when {@code maxConcurrent} was already hit. */
    public JobStatus runNow(String name) {
        boolean fired = engine.runNow(name);
        return fired ? lastStatus.get(name) : null;
    }

    public JobStatus lastStatus(String name) { return lastStatus.get(name); }
}
