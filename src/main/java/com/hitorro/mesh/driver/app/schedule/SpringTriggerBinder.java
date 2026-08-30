/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.schedule;

import com.hitorro.util.scheduler.durable.TriggerBinder;
import org.springframework.scheduling.TaskScheduler;
import org.springframework.scheduling.support.CronTrigger;
import org.springframework.scheduling.support.PeriodicTrigger;

import java.time.Duration;
import java.util.concurrent.ScheduledFuture;

/**
 * {@link TriggerBinder} over Spring's {@link TaskScheduler}. Used by
 * the mesh driver-app because it already has a scheduler bean wired
 * for other purposes (job progress polling, sink flush timers).
 * Callers who don't have Spring on hand can use util's
 * {@link com.hitorro.util.scheduler.durable.SimpleSchedulerTriggerBinder}
 * instead.
 */
public final class SpringTriggerBinder implements TriggerBinder {

    private final TaskScheduler scheduler;

    public SpringTriggerBinder(TaskScheduler scheduler) { this.scheduler = scheduler; }

    @Override
    public CancelHandle bindCron(String name, String cronExpr, Runnable body) {
        ScheduledFuture<?> f = scheduler.schedule(body, new CronTrigger(cronExpr));
        return () -> { if (f != null) f.cancel(false); };
    }

    @Override
    public CancelHandle bindInterval(String name, long seconds, Runnable body) {
        PeriodicTrigger pt = new PeriodicTrigger(Duration.ofSeconds(Math.max(1, seconds)));
        pt.setFixedRate(true);
        pt.setInitialDelay(Duration.ofSeconds(Math.max(1, seconds)));
        ScheduledFuture<?> f = scheduler.schedule(body, pt);
        return () -> { if (f != null) f.cancel(false); };
    }
}
