/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.storage;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * REST surface for storage-layer inspection. See {@link StorageService}
 * for what's returned.
 *
 * <ul>
 *   <li>{@code GET /mesh/storage} — backend + dataset presence + sizes</li>
 *   <li>{@code GET /mesh/storage/browse?path=…} — list entries under a
 *       storage path. {@code path} defaults to the datasets root. Accepts
 *       both bare paths ({@code datasets/geonames-cities500/}) and
 *       explicit URIs ({@code s3://hitorro/datasets/}, {@code file:/…}).
 *       When bare, resolves against the S3 bucket if S3 is configured,
 *       else against {@code HITORRO_DATASETS_HOME}.</li>
 * </ul>
 */
@RestController
@RequestMapping("/mesh/storage")
public class StorageController {

    private final StorageService storage;

    public StorageController(StorageService storage) {
        this.storage = storage;
    }

    @GetMapping
    public Map<String, Object> summary() {
        return storage.summary();
    }

    @GetMapping("/browse")
    public ResponseEntity<Map<String, Object>> browse(
            @RequestParam(name = "path", defaultValue = "") String path) {
        try {
            return ResponseEntity.ok(storage.browse(path));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }

    /**
     * Head-of-file preview — first {@code lines} lines (default 20, capped
     * at 500) or {@code bytes} bytes (default 16KB, capped at 256KB),
     * whichever comes first. Parquet files return their Avro schema
     * instead of raw bytes.
     */
    @GetMapping("/head")
    public ResponseEntity<Map<String, Object>> head(
            @RequestParam(name = "path") String path,
            @RequestParam(name = "lines", defaultValue = "20") int lines,
            @RequestParam(name = "bytes", defaultValue = "16384") int bytes) {
        try {
            return ResponseEntity.ok(storage.head(path, lines, bytes));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            return ResponseEntity.status(500).body(Map.of("error", e.getMessage()));
        }
    }
}
