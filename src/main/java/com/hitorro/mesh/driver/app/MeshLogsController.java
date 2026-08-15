/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Tail the log file of any mesh / fleet component the driver can locate.
 * Component name → file lookup follows the standard mesh-up.sh layout
 * plus a few well-known fallbacks. If the requested component isn't
 * mapped, the endpoint returns a 404 with the list of names it does
 * know about so the caller (usually the UI's mesh-viz on-click handler)
 * can render a helpful hint.
 */
@RestController
@RequestMapping("/mesh/logs")
public class MeshLogsController {

    private static final String HOME = System.getProperty("user.home");

    /** Component-name → candidate log-file paths, first that exists wins. */
    private static Map<String, List<Path>> discover() {
        Map<String, List<Path>> map = new LinkedHashMap<>();
        // Standard mesh-up.sh work dir + Orion/K8s deployment layouts.
        for (String workDir : new String[]{
                "/tmp/hitorro-mesh-smoke/logs",
                HOME + "/.hitorro/mesh/logs",
                "/var/log/hitorro"}) {
            for (String name : new String[]{"driver", "agent-us", "agent-eu", "nats"}) {
                map.computeIfAbsent(name, k -> new ArrayList<>())
                   .add(Paths.get(workDir, name + ".log"));
            }
        }
        // Fleet-managed services (driver-spawned children write here).
        map.computeIfAbsent("fleet-retrieval", k -> new ArrayList<>())
           .add(Paths.get(HOME, ".hitorro/fleet/logs/fleet-retrieval.log"));
        return map;
    }

    @GetMapping
    public ResponseEntity<Map<String, Object>> catalog() {
        Map<String, List<Path>> disc = discover();
        Map<String, Object> out = new LinkedHashMap<>();
        List<Map<String, Object>> comps = new ArrayList<>();
        for (var entry : disc.entrySet()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", entry.getKey());
            Path resolved = firstExisting(entry.getValue());
            row.put("path", resolved != null ? resolved.toString() : null);
            row.put("exists", resolved != null);
            if (resolved != null) {
                try { row.put("sizeBytes", Files.size(resolved)); } catch (IOException ignore) {}
                try { row.put("lastModifiedMs", Files.getLastModifiedTime(resolved).toMillis()); }
                catch (IOException ignore) {}
            }
            comps.add(row);
        }
        out.put("components", comps);
        return ResponseEntity.ok(out);
    }

    @GetMapping("/{component}")
    public ResponseEntity<Map<String, Object>> tail(@PathVariable("component") String component,
                                                    @RequestParam(value = "tail", defaultValue = "200") int tail) {
        Path log = firstExisting(discover().getOrDefault(component, List.of()));
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("component", component);
        if (log == null) {
            res.put("error", "no log file found; known components: "
                    + String.join(", ", discover().keySet()));
            return ResponseEntity.status(404).body(res);
        }
        res.put("path", log.toString());
        try {
            List<String> all = Files.readAllLines(log, StandardCharsets.UTF_8);
            int start = Math.max(0, all.size() - tail);
            res.put("lines", all.subList(start, all.size()));
            res.put("truncated", start > 0);
            res.put("totalLines", all.size());
        } catch (IOException e) {
            res.put("error", e.getMessage());
        }
        return ResponseEntity.ok(res);
    }

    private static Path firstExisting(List<Path> candidates) {
        for (Path p : candidates) if (Files.isRegularFile(p)) return p;
        return null;
    }
}
