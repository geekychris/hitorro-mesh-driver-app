/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.hitorro.mesh.RegisterTableMessage;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Driver-side memory of runtime table registrations, so the UI can list
 * "tables you registered this session" without walking every agent.
 * Populated by {@link QueryWriteController} on write-with-register and
 * drained by the mesh rest controller on unregister; queried by
 * {@code GET /mesh/tables/runtime}.
 *
 * <p>Not durable — driver restart clears it. Agents keep their own
 * durable journal (see {@code RuntimeTableJournal} in the agent-app),
 * so tables continue to be queryable across a driver bounce; this
 * tracker is purely a listing aid.</p>
 */
@Component
public class RuntimeTableTracker {

    public record Entry(
            String name,
            String uri,
            String format,
            String typeJson,
            boolean broadcast,
            String partitionKey,
            int agentsNotified,
            String registeredAt) { }

    private final Map<String, Entry> byName = new LinkedHashMap<>();

    public synchronized void record(RegisterTableMessage msg, int agentsNotified) {
        byName.put(msg.name(), new Entry(
                msg.name(), msg.uri(), msg.format(), msg.typeJson(),
                msg.broadcast(), msg.partitionKey(),
                agentsNotified, Instant.now().toString()));
    }

    public synchronized void forget(String name) {
        byName.remove(name);
    }

    public synchronized List<Entry> snapshot() {
        return new ArrayList<>(byName.values());
    }

    public synchronized int size() { return byName.size(); }
}
