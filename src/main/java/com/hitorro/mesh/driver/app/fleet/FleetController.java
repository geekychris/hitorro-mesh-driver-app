/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.fleet;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * REST surface for the driver-app's Fleet helper page. Reads
 * {@link FleetRegistry} for known members, port-scans each member's
 * default port for live health, exposes start/stop/logs for local dev,
 * and streams manifest text for K8s + Orion deploys.
 */
@RestController
@RequestMapping("/mesh/fleet")
public class FleetController {

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(400))
            .build();

    private final FleetProcessManager pm;

    public FleetController(FleetProcessManager pm) { this.pm = pm; }

    /**
     * Combined view: every registered member with its resolved jar,
     * whether the port is answering, and (if we started it locally) the
     * PID + uptime.
     */
    @GetMapping("/services")
    public ResponseEntity<List<Map<String, Object>>> services() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (FleetRegistry.FleetMember m : FleetRegistry.all()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", m.name());
            row.put("description", m.description());
            row.put("defaultPort", m.defaultPort());
            row.put("healthPath", m.healthPath());
            Path jar = FleetRegistry.resolveJar(m);
            row.put("jarPath", jar != null ? jar.toString() : null);
            row.put("jarFound", jar != null);
            Probe probe = probe("localhost", m.defaultPort(), m.healthPath());
            row.put("alive", probe.ok);
            row.put("probeMs", probe.elapsedMs);
            if (probe.ok && probe.body != null) row.put("healthBody", probe.body);
            FleetProcessManager.Handle h = pm.get(m.name());
            if (h != null) {
                row.put("managedPid", h.pid());
                row.put("startedAt", h.startedAt().toString());
                row.put("uptimeSec", Duration.between(h.startedAt(), Instant.now()).toSeconds());
                row.put("logFile", h.logFile().toString());
            }
            out.add(row);
        }
        return ResponseEntity.ok(out);
    }

    @PostMapping("/services/{name}/start")
    public ResponseEntity<Map<String, Object>> start(@PathVariable("name") String name) {
        FleetRegistry.FleetMember m = FleetRegistry.byName(name);
        if (m == null) return ResponseEntity.notFound().build();
        Map<String, Object> res = new LinkedHashMap<>();
        try {
            var h = pm.start(m);
            res.put("name", h.name());
            res.put("pid", h.pid());
            res.put("logFile", h.logFile().toString());
            res.put("success", true);
        } catch (IOException e) {
            res.put("success", false);
            res.put("error", e.getMessage());
            return ResponseEntity.badRequest().body(res);
        }
        return ResponseEntity.ok(res);
    }

    @PostMapping("/services/{name}/stop")
    public ResponseEntity<Map<String, Object>> stop(@PathVariable("name") String name) {
        boolean killed = pm.stop(name);
        return ResponseEntity.ok(Map.of("name", name, "killed", killed));
    }

    @GetMapping("/services/{name}/logs")
    public ResponseEntity<Map<String, Object>> logs(@PathVariable("name") String name,
                                                    @RequestParam(value = "tail", defaultValue = "100") int tail) {
        Map<String, Object> res = new LinkedHashMap<>();
        try {
            res.put("name", name);
            res.put("lines", pm.tailLog(name, tail));
        } catch (IOException e) {
            res.put("error", e.getMessage());
        }
        return ResponseEntity.ok(res);
    }

    @GetMapping(value = "/services/{name}/manifest", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseEntity<String> manifest(@PathVariable("name") String name,
                                           @RequestParam(value = "target", defaultValue = "k8s") String target) {
        FleetRegistry.FleetMember m = FleetRegistry.byName(name);
        if (m == null) return ResponseEntity.notFound().build();
        String body = switch (target.toLowerCase()) {
            case "orion" -> FleetRegistry.orionManifest(m);
            case "local", "shell" -> FleetRegistry.localLaunchCommand(m);
            default -> FleetRegistry.k8sManifest(m);
        };
        return ResponseEntity.ok(body);
    }

    // ─── helpers ────────────────────────────────────────────────────

    private record Probe(boolean ok, long elapsedMs, String body) {}

    private static Probe probe(String host, int port, String path) {
        long t0 = System.currentTimeMillis();
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create("http://" + host + ":" + port + path))
                    .timeout(Duration.ofMillis(600)).GET().build();
            HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            return new Probe(resp.statusCode() >= 200 && resp.statusCode() < 300,
                    System.currentTimeMillis() - t0,
                    resp.body().length() > 400 ? resp.body().substring(0, 400) : resp.body());
        } catch (Exception e) {
            return new Probe(false, System.currentTimeMillis() - t0, null);
        }
    }
}
