/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hitorro.mesh.RegisterTableMessage;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Driver-side memory of runtime table registrations, so the UI can list
 * "tables you registered here" without walking every agent. Populated
 * by {@link QueryWriteController} on write-with-register and drained
 * by the mesh rest controller on unregister; queried by
 * {@code GET /mesh/queries/registered}.
 *
 * <p>Durable — the full snapshot is persisted atomically to
 * {@code ${hitorro.driver.home}/runtime-tables.json} (default
 * {@code ~/.hitorro/driver/runtime-tables.json}) on every mutation.
 * On boot the file is read + parsed, so the UI panel is populated
 * from the moment the driver comes up. Agents keep their own journals
 * for the actual data, so nothing gets lost even if the driver-side
 * file is deleted — the tracker just rebuilds as new writes arrive.</p>
 */
@Component
public class RuntimeTableTracker {

    private static final Logger log = LoggerFactory.getLogger(RuntimeTableTracker.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public record Entry(
            String name,
            String uri,
            String format,
            String typeJson,
            boolean broadcast,
            String partitionKey,
            int agentsNotified,
            String registeredAt,
            /** Target agent for per-partition registrations. null for
             *  broadcast + non-partitioned distributed. */
            String targetAgentId,
            /** True when the operator supplied an explicit agentId on
             *  register — reconciler will NOT re-hash these on drop. */
            boolean explicitTarget) {

        /** 8-arg back-compat ctor for on-disk snapshots from earlier
         *  driver versions — null targetAgentId, explicitTarget=false. */
        public Entry(String name, String uri, String format, String typeJson,
                     boolean broadcast, String partitionKey,
                     int agentsNotified, String registeredAt) {
            this(name, uri, format, typeJson, broadcast, partitionKey,
                 agentsNotified, registeredAt, null, false);
        }
    }

    /** Keyed by name (broadcast) or name+"@"+partitionKey (partitioned).
     *  Multiple partitions of the same table live as distinct entries — the
     *  previous "keyed by name only" scheme silently overwrote them. */
    private final Map<String, Entry> byKey = new LinkedHashMap<>();
    private final Path file;

    private static String key(String name, String partitionKey) {
        return partitionKey == null ? name : name + "@" + partitionKey;
    }

    public RuntimeTableTracker() {
        String home = System.getProperty("hitorro.driver.home",
                System.getProperty("user.home") + "/.hitorro/driver");
        this.file = Path.of(home, "runtime-tables.json");
    }

    /** Test-friendly ctor. */
    RuntimeTableTracker(Path file) { this.file = file; }

    @PostConstruct
    public synchronized void load() {
        if (!Files.exists(file)) return;
        try {
            String json = Files.readString(file, StandardCharsets.UTF_8);
            List<Entry> loaded = MAPPER.readValue(json, new TypeReference<List<Entry>>() {});
            for (Entry e : loaded) byKey.put(key(e.name(), e.partitionKey()), e);
            log.info("runtime-tables: loaded {} entries from {}", byKey.size(), file);
        } catch (Exception e) {
            log.warn("runtime-tables: load failed ({}): {}", file, e.toString());
        }
    }

    /** Back-compat overload — no explicit target-agent info. */
    public synchronized void record(RegisterTableMessage msg, int agentsNotified) {
        record(msg, agentsNotified, /*targetAgentId=*/null, /*explicitTarget=*/false);
    }

    /** Full record — used by register-partitioned to preserve
     *  targetAgentId + whether the operator supplied it explicitly. */
    public synchronized void record(RegisterTableMessage msg, int agentsNotified,
                                    String targetAgentId, boolean explicitTarget) {
        Entry e = new Entry(
                msg.name(), msg.uri(), msg.format(), msg.typeJson(),
                msg.broadcast(), msg.partitionKey(),
                agentsNotified, Instant.now().toString(),
                targetAgentId, explicitTarget);
        byKey.put(key(msg.name(), msg.partitionKey()), e);
        persist();
    }

    /** Drop every entry for the given table name (all partitions). */
    public synchronized void forget(String name) {
        boolean any = byKey.keySet().removeIf(k -> k.equals(name) || k.startsWith(name + "@"));
        if (any) persist();
    }

    /** Drop a specific (name, partitionKey) entry — used by the
     *  reconciler when re-hashing to a new target. */
    public synchronized void forget(String name, String partitionKey) {
        if (byKey.remove(key(name, partitionKey)) != null) persist();
    }

    public synchronized List<Entry> snapshot() {
        return new ArrayList<>(byKey.values());
    }

    public synchronized int size() { return byKey.size(); }

    /** Atomic-rename write: serialise the current snapshot to a .tmp
     *  sibling and move it into place. Crash-safe — either the old
     *  file survives or the new one takes over, never a half-written
     *  state. Called on every mutation; state is small (kilobytes) so
     *  full-rewrite cost is negligible. */
    private void persist() {
        try {
            Path parent = file.getParent();
            if (parent != null) Files.createDirectories(parent);
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            byte[] bytes = MAPPER.writerWithDefaultPrettyPrinter()
                    .writeValueAsBytes(new ArrayList<>(byKey.values()));
            Files.write(tmp, bytes,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            Files.move(tmp, file,
                    StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            log.warn("runtime-tables: persist failed: {}", e.toString());
        }
    }
}
