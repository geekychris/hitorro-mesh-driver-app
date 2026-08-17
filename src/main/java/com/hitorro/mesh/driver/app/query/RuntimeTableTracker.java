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
            String registeredAt) { }

    private final Map<String, Entry> byName = new LinkedHashMap<>();
    private final Path file;

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
            for (Entry e : loaded) byName.put(e.name(), e);
            log.info("runtime-tables: loaded {} entries from {}", byName.size(), file);
        } catch (Exception e) {
            log.warn("runtime-tables: load failed ({}): {}", file, e.toString());
        }
    }

    public synchronized void record(RegisterTableMessage msg, int agentsNotified) {
        byName.put(msg.name(), new Entry(
                msg.name(), msg.uri(), msg.format(), msg.typeJson(),
                msg.broadcast(), msg.partitionKey(),
                agentsNotified, Instant.now().toString()));
        persist();
    }

    public synchronized void forget(String name) {
        if (byName.remove(name) != null) persist();
    }

    public synchronized List<Entry> snapshot() {
        return new ArrayList<>(byName.values());
    }

    public synchronized int size() { return byName.size(); }

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
                    .writeValueAsBytes(new ArrayList<>(byName.values()));
            Files.write(tmp, bytes,
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            Files.move(tmp, file,
                    StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            log.warn("runtime-tables: persist failed: {}", e.toString());
        }
    }
}
