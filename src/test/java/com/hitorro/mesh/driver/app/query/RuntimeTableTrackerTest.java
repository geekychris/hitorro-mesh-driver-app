/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.hitorro.mesh.RegisterTableMessage;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Unit tests for {@link RuntimeTableTracker}'s disk-persistence layer.
 * Uses the test-only file ctor so we don't clobber the operator's real
 * {@code ~/.hitorro/driver/runtime-tables.json}.
 */
class RuntimeTableTrackerTest {

    private static RegisterTableMessage msg(String name) {
        return new RegisterTableMessage(name,
                "{\"name\":\"" + name + "\",\"fields\":[]}",
                "file:/x/" + name + ".ndjson",
                "ndjson", true, null);
    }

    @Test
    void newTracker_isEmpty(@TempDir Path tmp) {
        RuntimeTableTracker t = new RuntimeTableTracker(tmp.resolve("t.json"));
        assertThat(t.size()).isZero();
        assertThat(t.snapshot()).isEmpty();
    }

    @Test
    void record_persistsToDiskImmediately(@TempDir Path tmp) throws IOException {
        Path file = tmp.resolve("t.json");
        RuntimeTableTracker t = new RuntimeTableTracker(file);
        t.record(msg("alpha"), 3);

        assertThat(Files.exists(file)).isTrue();
        assertThat(Files.readString(file)).contains("alpha").contains("\"agentsNotified\" : 3");
    }

    @Test
    void loadOnBoot_restoresPreviousState(@TempDir Path tmp) {
        Path file = tmp.resolve("t.json");
        // First "process" — record two entries, drop instance.
        {
            RuntimeTableTracker t = new RuntimeTableTracker(file);
            t.record(msg("alpha"), 2);
            t.record(msg("beta"), 5);
        }
        // Second "process" — construct, invoke load(), verify state is back.
        RuntimeTableTracker t2 = new RuntimeTableTracker(file);
        t2.load();
        List<RuntimeTableTracker.Entry> snap = t2.snapshot();
        assertThat(snap).extracting(RuntimeTableTracker.Entry::name)
                .containsExactly("alpha", "beta");
        assertThat(snap.get(1).agentsNotified()).isEqualTo(5);
    }

    @Test
    void forget_removesEntryAndPersists(@TempDir Path tmp) throws IOException {
        Path file = tmp.resolve("t.json");
        RuntimeTableTracker t = new RuntimeTableTracker(file);
        t.record(msg("alpha"), 1);
        t.record(msg("beta"), 1);
        t.forget("alpha");

        assertThat(t.snapshot()).extracting(RuntimeTableTracker.Entry::name)
                .containsExactly("beta");
        // Disk reflects the drop too — subsequent boot must not resurrect alpha.
        assertThat(Files.readString(file)).doesNotContain("alpha");
    }

    @Test
    void forget_ofUnknownName_isNoop(@TempDir Path tmp) {
        RuntimeTableTracker t = new RuntimeTableTracker(tmp.resolve("t.json"));
        t.record(msg("alpha"), 1);
        t.forget("never-added");
        assertThat(t.snapshot()).hasSize(1);
    }

    @Test
    void reRecord_overwritesAgentsNotified(@TempDir Path tmp) {
        RuntimeTableTracker t = new RuntimeTableTracker(tmp.resolve("t.json"));
        t.record(msg("alpha"), 2);
        t.record(msg("alpha"), 5);   // same name, updated count
        assertThat(t.snapshot()).hasSize(1);
        assertThat(t.snapshot().get(0).agentsNotified()).isEqualTo(5);
    }

    @Test
    void missingFile_loadIsNoop(@TempDir Path tmp) {
        RuntimeTableTracker t = new RuntimeTableTracker(tmp.resolve("does-not-exist.json"));
        t.load();
        assertThat(t.size()).isZero();
    }

    @Test
    void corruptFile_loadDoesNotThrow(@TempDir Path tmp) throws IOException {
        Path file = tmp.resolve("t.json");
        Files.writeString(file, "not-valid-json-{{{");
        RuntimeTableTracker t = new RuntimeTableTracker(file);
        t.load();  // Logs a warn, state stays empty.
        assertThat(t.size()).isZero();
    }
}
