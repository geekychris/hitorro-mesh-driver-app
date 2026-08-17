/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.storage;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * REST surface for MinIO lifecycle — start/stop the container from the UI
 * and hot-wire the S3 protocol adapter without restarting the driver.
 *
 * <ul>
 *   <li>{@code GET  /mesh/storage/minio}       — status (reachable, adapter, creds hints)</li>
 *   <li>{@code POST /mesh/storage/minio/start} — bring MinIO up + register adapter</li>
 *   <li>{@code POST /mesh/storage/minio/stop}  — docker compose down</li>
 * </ul>
 */
@RestController
@RequestMapping("/mesh/storage/minio")
public class MinioLifecycleController {

    private static final Logger log = LoggerFactory.getLogger(MinioLifecycleController.class);

    private final MinioLifecycleService svc;

    public MinioLifecycleController(MinioLifecycleService svc) {
        this.svc = svc;
    }

    @GetMapping
    public Map<String, Object> status() {
        return svc.status();
    }

    @PostMapping("/start")
    public ResponseEntity<Map<String, Object>> start() {
        try {
            return ResponseEntity.ok(svc.start());
        } catch (Exception e) {
            log.warn("minio start failed", e);
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("success", false);
            err.put("error", e.getMessage());
            return ResponseEntity.status(500).body(err);
        }
    }

    /**
     * SSE variant of {@code /sync} — streams stdout of
     * {@code minio-sync-datasets.sh} line-by-line as the script runs.
     * Emits {@code line} events for each mc-mirror line, one
     * {@code done} event at the end with the exit code.
     */
    @org.springframework.web.bind.annotation.GetMapping(path = "/sync/stream",
            produces = org.springframework.http.MediaType.TEXT_EVENT_STREAM_VALUE)
    public org.springframework.web.servlet.mvc.method.annotation.SseEmitter syncStream(
            @org.springframework.web.bind.annotation.RequestParam(name = "dataset", required = false) String dataset) {
        org.springframework.web.servlet.mvc.method.annotation.SseEmitter emitter =
                new org.springframework.web.servlet.mvc.method.annotation.SseEmitter(600_000L);
        try {
            svc.validateDataset(dataset);
            if (!svc.isReachable()) {
                try {
                    emitter.send(org.springframework.web.servlet.mvc.method.annotation.SseEmitter.event()
                            .name("error").data("MinIO not reachable — click Start first."));
                } catch (java.io.IOException ignored) { }
                emitter.complete();
                return emitter;
            }
        } catch (IllegalArgumentException e) {
            try {
                emitter.send(org.springframework.web.servlet.mvc.method.annotation.SseEmitter.event()
                        .name("error").data(e.getMessage()));
            } catch (Exception ignored) { }
            emitter.complete();
            return emitter;
        }
        // Kick off the shell in a background thread so the emitter isn't
        // blocked. Every stdout line becomes an SSE `line` event.
        java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "minio-sync-sse");
            t.setDaemon(true);
            return t;
        }).submit(() -> {
            try {
                String[] args = (dataset == null || dataset.isBlank())
                        ? new String[0] : new String[]{dataset};
                int rc = svc.runScriptStreaming("minio-sync-datasets.sh", args, line -> {
                    try {
                        emitter.send(org.springframework.web.servlet.mvc.method.annotation.SseEmitter.event()
                                .name("line").data(line));
                    } catch (Exception e) { /* client disconnected — completion below */ }
                });
                emitter.send(org.springframework.web.servlet.mvc.method.annotation.SseEmitter.event()
                        .name("done").data("{\"exitCode\":" + rc + "}"));
                emitter.complete();
            } catch (Exception e) {
                try {
                    emitter.send(org.springframework.web.servlet.mvc.method.annotation.SseEmitter.event()
                            .name("error").data(e.getMessage()));
                } catch (Exception ignored) { }
                emitter.completeWithError(e);
            }
        });
        return emitter;
    }

    @PostMapping("/sync")
    public ResponseEntity<Map<String, Object>> sync(
            @org.springframework.web.bind.annotation.RequestParam(name = "dataset", required = false) String dataset) {
        try {
            return ResponseEntity.ok(svc.sync(dataset));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", e.getMessage()));
        } catch (IllegalStateException e) {
            return ResponseEntity.badRequest().body(Map.of("success", false, "error", e.getMessage()));
        } catch (Exception e) {
            log.warn("minio sync failed", e);
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("success", false);
            err.put("error", e.getMessage());
            return ResponseEntity.status(500).body(err);
        }
    }

    @PostMapping("/stop")
    public ResponseEntity<Map<String, Object>> stop() {
        try {
            return ResponseEntity.ok(svc.stop());
        } catch (Exception e) {
            log.warn("minio stop failed", e);
            Map<String, Object> err = new LinkedHashMap<>();
            err.put("success", false);
            err.put("error", e.getMessage());
            return ResponseEntity.status(500).body(err);
        }
    }
}
