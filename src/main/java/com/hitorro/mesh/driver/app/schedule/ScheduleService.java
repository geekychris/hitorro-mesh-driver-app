/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.schedule;

import com.hitorro.mesh.pipelines.model.JobSpec;
import com.hitorro.mesh.pipelines.parse.JobSpecYaml;
import com.hitorro.mesh.pipelines.runtime.JobRunner;
import com.hitorro.mesh.pipelines.runtime.JobStatus;
import com.hitorro.mesh.pipelines.schedule.CheckpointStore;
import com.hitorro.mesh.pipelines.schedule.Schedule;
import com.hitorro.mesh.pipelines.schedule.ScheduleStore;
import com.hitorro.mesh.pipelines.schedule.TemplateSubstitution;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.support.CronTrigger;
import org.springframework.scheduling.support.PeriodicTrigger;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Durable scheduler for mesh pipeline jobs. On boot, reads persisted
 * {@link Schedule}s from disk, catches up any that missed their window
 * while the process was down, then registers a cron / interval trigger
 * for each enabled entry. Every trigger fires a single job run via
 * {@link JobRunner} — the checkpoint stored per-schedule is substituted
 * into the job YAML as {@code ${CHECKPOINT}} so the job knows where to
 * pick up.
 *
 * <h3>Catch-up policy</h3>
 * On boot, for each enabled schedule with a cadence: if
 * {@code now > lastSuccessAt + interval + catchupGraceSeconds}, one
 * make-up run fires immediately. A week-long outage against an hourly
 * schedule = one make-up run, not 168 — because the job's own filter
 * (backed by {@code ${CHECKPOINT}}) covers the full window.
 *
 * <h3>Concurrency</h3>
 * Each schedule has a {@code maxConcurrent} cap. In-flight counters
 * gate the trigger; if the previous run hasn't finished when the next
 * cron tick arrives, the tick is dropped (with a log line).
 */
@Service
public class ScheduleService {

    private static final Logger log = LoggerFactory.getLogger(ScheduleService.class);

    private final ScheduleStore store;
    private final CheckpointStore checkpoints;
    private final JobRunner runner;
    private final com.hitorro.mesh.pipelines.runtime.JobRegistry jobRegistry;
    private final TaskScheduler taskScheduler;
    private final Map<String, ScheduledFuture<?>> triggers = new ConcurrentHashMap<>();
    private final Map<String, AtomicInteger>       inflight = new ConcurrentHashMap<>();
    /** Records the most recent JobStatus per schedule for /show endpoints. */
    private final Map<String, JobStatus>            lastStatus = new ConcurrentHashMap<>();
    private final Path home;

    public ScheduleService(JobRunner runner,
                           com.hitorro.mesh.pipelines.runtime.JobRegistry jobRegistry,
                           TaskScheduler taskScheduler,
                           @Value("${hitorro.mesh.schedule.home:#{null}}") String homeOverride) throws IOException {
        this.runner = runner;
        this.jobRegistry = jobRegistry;
        this.taskScheduler = taskScheduler;
        this.home = resolveHome(homeOverride);
        Files.createDirectories(this.home);
        this.store = new ScheduleStore(this.home);
        this.checkpoints = new CheckpointStore(this.home);
    }

    private static Path resolveHome(String override) {
        if (override != null && !override.isBlank()) return Path.of(override);
        String htData = System.getenv("HT_DATA");
        if (htData != null && !htData.isBlank()) return Path.of(htData, "schedules");
        return Path.of(System.getProperty("user.home"), ".hitorro", "schedules");
    }

    @PostConstruct
    void bootstrap() {
        List<Schedule> all = store.all();
        log.info("scheduler: home={}  loaded {} schedule(s)", home, all.size());
        for (Schedule s : all) {
            hydrateCheckpoint(s);
            if (shouldCatchUp(s)) {
                log.info("scheduler: [{}] catching up (last success at {})",
                        s.name, s.lastSuccessAt);
                trigger(s, /*catchup*/true);
            }
            if (s.enabled) armTrigger(s);
        }
    }

    @PreDestroy
    void shutdown() {
        for (ScheduledFuture<?> f : triggers.values()) f.cancel(false);
        triggers.clear();
    }

    // ---- Public API for the controller -------------------------------

    public List<Schedule> list() {
        List<Schedule> out = store.all();
        for (Schedule s : out) hydrateCheckpoint(s);
        return out;
    }

    public Schedule get(String name) {
        Schedule s = store.get(name).orElseThrow(() -> new IllegalArgumentException("no schedule: " + name));
        hydrateCheckpoint(s);
        return s;
    }

    public Schedule save(Schedule s) throws IOException {
        Schedule saved = store.put(s);
        if (s.checkpoint != null) checkpoints.put(s.name, s.checkpoint);
        rebindTrigger(saved);
        return saved;
    }

    public boolean delete(String name) throws IOException {
        ScheduledFuture<?> t = triggers.remove(name);
        if (t != null) t.cancel(false);
        boolean removed = store.remove(name);
        checkpoints.remove(name);
        lastStatus.remove(name);
        return removed;
    }

    public Schedule setEnabled(String name, boolean enabled) throws IOException {
        Schedule s = store.update(name, x -> x.enabled = enabled);
        rebindTrigger(s);
        return s;
    }

    public String getCheckpoint(String name) {
        return checkpoints.get(name).orElse("");
    }

    public void setCheckpoint(String name, String value) throws IOException {
        // Explicit set — persist both the checkpoint file and cache the
        // last value onto the Schedule so /show reflects it immediately.
        store.update(name, s -> s.checkpoint = value);
        checkpoints.put(name, value == null ? "" : value);
    }

    public JobStatus runNow(String name) {
        Schedule s = store.get(name).orElseThrow(() -> new IllegalArgumentException("no schedule: " + name));
        return trigger(s, /*catchup*/false);
    }

    public JobStatus lastStatus(String name) { return lastStatus.get(name); }

    // ---- Trigger management ------------------------------------------

    private void rebindTrigger(Schedule s) {
        ScheduledFuture<?> prev = triggers.remove(s.name);
        if (prev != null) prev.cancel(false);
        if (s.enabled) armTrigger(s);
    }

    private void armTrigger(Schedule s) {
        Runnable task = () -> {
            try { trigger(s, /*catchup*/false); }
            catch (Exception e) { log.warn("scheduler [{}] tick failed: {}", s.name, e.getMessage()); }
        };
        try {
            ScheduledFuture<?> f;
            if (s.cron != null && !s.cron.isBlank()) {
                f = taskScheduler.schedule(task, new CronTrigger(s.cron));
                log.info("scheduler: [{}] armed cron='{}'", s.name, s.cron);
            } else if (s.intervalSeconds != null && s.intervalSeconds > 0) {
                PeriodicTrigger pt = new PeriodicTrigger(Duration.ofSeconds(s.intervalSeconds));
                pt.setFixedRate(true);
                pt.setInitialDelay(Duration.ofSeconds(s.intervalSeconds));
                f = taskScheduler.schedule(task, pt);
                log.info("scheduler: [{}] armed interval={}s", s.name, s.intervalSeconds);
            } else {
                log.info("scheduler: [{}] manual-only (no cron/interval)", s.name);
                return;
            }
            triggers.put(s.name, f);
        } catch (Exception e) {
            log.warn("scheduler [{}] failed to arm trigger: {}", s.name, e.getMessage());
        }
    }

    private boolean shouldCatchUp(Schedule s) {
        if (!s.enabled) return false;
        if (s.lastSuccessAt == null) return false;   // never ran → let normal trigger fire
        long intervalSec = s.cron != null && !s.cron.isBlank()
                ? estimateCronIntervalSec(s.cron)
                : (s.intervalSeconds == null ? 0 : s.intervalSeconds);
        if (intervalSec <= 0) return false;
        Instant nextExpected = s.lastSuccessAt.plusSeconds(intervalSec + Math.max(0, s.catchupGraceSeconds));
        return Instant.now().isAfter(nextExpected);
    }

    /** Best-effort cron interval estimation. Reasonable for hourly / daily
     *  jobs; conservative for complex crons (returns 60s so catch-up is
     *  triggered on any reasonable downtime). */
    private long estimateCronIntervalSec(String cron) {
        try {
            CronTrigger t = new CronTrigger(cron);
            Instant seed = Instant.now().plusSeconds(1);
            Instant d1 = t.nextExecution(new SimpleTriggerContext(seed));
            if (d1 == null) return 60;
            Instant d2 = t.nextExecution(new SimpleTriggerContext(d1));
            if (d2 == null) return 60;
            return Duration.between(d1, d2).getSeconds();
        } catch (Exception e) { return 60; }
    }

    /** Trigger a run. Enforces maxConcurrent — dropped ticks log + return null. */
    private JobStatus trigger(Schedule s, boolean catchup) {
        AtomicInteger n = inflight.computeIfAbsent(s.name, k -> new AtomicInteger());
        if (n.get() >= Math.max(1, s.maxConcurrent)) {
            log.warn("scheduler [{}] tick dropped — {} in flight (max {})", s.name, n.get(), s.maxConcurrent);
            return null;
        }
        n.incrementAndGet();
        try {
            return doTrigger(s, catchup);
        } finally { n.decrementAndGet(); }
    }

    private JobStatus doTrigger(Schedule s, boolean catchup) {
        Instant now = Instant.now();
        String checkpoint = checkpoints.get(s.name).orElse(s.checkpoint == null ? "" : s.checkpoint);
        String rendered = TemplateSubstitution.render(s.jobYaml, s.name, checkpoint, now);
        JobSpec spec;
        try {
            spec = JobSpecYaml.parse(rendered);
        } catch (Exception e) {
            log.warn("scheduler [{}] YAML parse failed: {}", s.name, e.getMessage());
            recordFailure(s, now, "yaml: " + e.getMessage());
            return null;
        }
        JobStatus status = new JobStatus("schedule-" + s.name + "-" + now.toEpochMilli(), spec.id());
        lastStatus.put(s.name, status);
        // Publish to the same JobRegistry the /mesh/jobs endpoint reads
        // from — otherwise scheduler-invoked runs are invisible in the
        // Jobs tab / history and the only failure signal is the row's
        // lastError field. onTerminal in finally so the entry ends up
        // in the persistent job history log too.
        jobRegistry.register(status);
        log.info("scheduler [{}] run {} — checkpoint='{}'{}", s.name,
                status.jobId, checkpoint, catchup ? " (catch-up)" : "");
        try {
            runner.run(spec, status);
            recordRunOutcome(s, now, status);
        } catch (Throwable t) {
            log.warn("scheduler [{}] run failed: {}", s.name, t.getMessage());
            recordFailure(s, now, t.getMessage());
        } finally {
            jobRegistry.onTerminal(status);
        }
        return status;
    }

    private void recordRunOutcome(Schedule s, Instant runStart, JobStatus status) {
        boolean success = status.state == JobStatus.State.SUCCEEDED;
        try {
            store.update(s.name, x -> {
                x.lastRunAt = runStart;
                x.totalRuns++;
                if (success) {
                    x.lastSuccessAt = runStart;
                    x.successfulRuns++;
                    x.lastError = null;
                } else {
                    x.lastFailureAt = runStart;
                    x.lastError = status.state == null ? "no state" : status.state.name();
                }
            });
            // Advance the checkpoint only on success. Precedence:
            //   1. Job-provided override (a step called ctx.setCheckpoint) —
            //      wins over everything; that's the whole point of the API.
            //   2. External /checkpoint PUT mid-run — leave whatever the
            //      operator set alone.
            //   3. Default: stamp runStart (ISO instant) — the time-cursor
            //      case that works for "WHERE ts > ${CHECKPOINT}" jobs.
            if (success) {
                String current = checkpoints.get(s.name).orElse("");
                Schedule fresh = store.get(s.name).orElse(null);
                boolean externallyChanged = fresh != null && fresh.checkpoint != null
                        && !fresh.checkpoint.equals(current);
                String jobOverride = status.scheduledCheckpointOverride;
                if (jobOverride != null) {
                    checkpoints.put(s.name, jobOverride);
                    store.update(s.name, x -> x.checkpoint = jobOverride);
                } else if (!externallyChanged) {
                    String advance = runStart.toString();
                    checkpoints.put(s.name, advance);
                    store.update(s.name, x -> x.checkpoint = advance);
                }
            }
        } catch (IOException e) {
            log.warn("scheduler [{}] failed to persist run outcome: {}", s.name, e.getMessage());
        }
    }

    private void recordFailure(Schedule s, Instant when, String err) {
        try {
            store.update(s.name, x -> {
                x.lastRunAt = when;
                x.lastFailureAt = when;
                x.lastError = err;
                x.totalRuns++;
            });
        } catch (IOException e) {
            log.warn("scheduler [{}] failed to persist failure: {}", s.name, e.getMessage());
        }
    }

    private void hydrateCheckpoint(Schedule s) {
        checkpoints.get(s.name).ifPresent(v -> s.checkpoint = v);
    }

    // Local shim so we don't drag in a Spring package we don't otherwise use.
    private static final class SimpleTriggerContext
            implements org.springframework.scheduling.TriggerContext {
        private final Instant lastCompletion;
        SimpleTriggerContext(Instant lastCompletion) { this.lastCompletion = lastCompletion; }
        @Override public Instant lastScheduledExecution() { return lastCompletion; }
        @Override public Instant lastActualExecution()    { return lastCompletion; }
        @Override public Instant lastCompletion()         { return lastCompletion; }
    }
}
