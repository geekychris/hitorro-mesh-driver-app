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
