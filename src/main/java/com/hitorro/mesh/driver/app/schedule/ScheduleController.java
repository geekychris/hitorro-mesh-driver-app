/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.schedule;

import com.fasterxml.jackson.databind.JsonNode;
import com.hitorro.mesh.pipelines.runtime.JobStatus;
import com.hitorro.mesh.pipelines.schedule.Schedule;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * REST surface for the durable pipeline scheduler.
 *
 * <ul>
 *   <li>{@code GET    /mesh/schedules} — list</li>
 *   <li>{@code POST   /mesh/schedules} — create/replace (body = Schedule JSON)</li>
 *   <li>{@code GET    /mesh/schedules/{name}} — show</li>
 *   <li>{@code DELETE /mesh/schedules/{name}} — delete</li>
 *   <li>{@code POST   /mesh/schedules/{name}/run-now} — fire immediately</li>
 *   <li>{@code POST   /mesh/schedules/{name}/pause} / {@code /resume}</li>
 *   <li>{@code GET    /mesh/schedules/{name}/checkpoint} — read checkpoint</li>
 *   <li>{@code PUT    /mesh/schedules/{name}/checkpoint} — set (body = raw string)</li>
 * </ul>
 */
@RestController
@RequestMapping("/mesh/schedules")
public class ScheduleController {

    private final ScheduleService svc;

    public ScheduleController(ScheduleService svc) { this.svc = svc; }

    @GetMapping
    public List<Schedule> list() { return svc.list(); }

    @PostMapping
    public ResponseEntity<Schedule> upsert(@RequestBody Schedule body) throws IOException {
        if (body.name == null || body.name.isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        if (body.jobYaml == null || body.jobYaml.isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        Schedule saved = svc.save(body);
        return ResponseEntity.ok(saved);
    }

    @GetMapping("/{name}")
    public ResponseEntity<Map<String, Object>> show(@PathVariable String name) {
        try {
            Schedule s = svc.get(name);
            JobStatus last = svc.lastStatus(name);
            java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
            out.put("schedule", s);
            if (last != null) out.put("lastStatus", Map.of(
                    "jobId", last.jobId,
                    "state", last.state == null ? "?" : last.state.name(),
                    "error", last.error == null ? "" : last.error));
            return ResponseEntity.ok(out);
        } catch (IllegalArgumentException e) {
            return ResponseEntity.notFound().build();
        }
    }

    @DeleteMapping("/{name}")
    public ResponseEntity<Void> delete(@PathVariable String name) throws IOException {
        return svc.delete(name)
                ? ResponseEntity.noContent().build()
                : ResponseEntity.notFound().build();
    }

    @PostMapping("/{name}/run-now")
    public ResponseEntity<Map<String, Object>> runNow(@PathVariable String name) {
        try {
            JobStatus st = svc.runNow(name);
            if (st == null) return ResponseEntity.status(429).body(Map.of(
                    "error", "in-flight cap hit — try again shortly"));
            return ResponseEntity.ok(Map.of(
                    "jobId", st.jobId,
                    "state", st.state == null ? "?" : st.state.name(),
                    "error", st.error == null ? "" : st.error));
        } catch (IllegalArgumentException e) {
            return ResponseEntity.notFound().build();
        }
    }

    @PostMapping("/{name}/pause")
    public ResponseEntity<Schedule> pause(@PathVariable String name) throws IOException {
        try { return ResponseEntity.ok(svc.setEnabled(name, false)); }
        catch (IllegalArgumentException e) { return ResponseEntity.notFound().build(); }
    }

    @PostMapping("/{name}/resume")
    public ResponseEntity<Schedule> resume(@PathVariable String name) throws IOException {
        try { return ResponseEntity.ok(svc.setEnabled(name, true)); }
        catch (IllegalArgumentException e) { return ResponseEntity.notFound().build(); }
    }

    @GetMapping("/{name}/checkpoint")
    public ResponseEntity<Map<String, String>> getCheckpoint(@PathVariable String name) {
        try {
            svc.get(name); // 404 check
            return ResponseEntity.ok(Map.of("checkpoint", svc.getCheckpoint(name)));
        } catch (IllegalArgumentException e) { return ResponseEntity.notFound().build(); }
    }

    /** Accepts either a raw text body ({@code Content-Type: text/plain})
     *  or a JSON body {@code {"checkpoint":"..."}}. */
    @PutMapping(value = "/{name}/checkpoint",
                consumes = { MediaType.TEXT_PLAIN_VALUE, MediaType.APPLICATION_JSON_VALUE })
    public ResponseEntity<Map<String, String>> setCheckpoint(@PathVariable String name,
                                                              @RequestBody(required = false) String rawBody,
                                                              @RequestParam(required = false) String value)
            throws IOException {
        try { svc.get(name); }
        catch (IllegalArgumentException e) { return ResponseEntity.notFound().build(); }
        String v = value;
        if (v == null && rawBody != null) {
            String trimmed = rawBody.trim();
            if (trimmed.startsWith("{")) {
                try {
                    JsonNode node = new com.fasterxml.jackson.databind.ObjectMapper().readTree(trimmed);
                    v = node.path("checkpoint").asText(null);
                } catch (Exception ignore) { /* fall through to raw */ }
            }
            if (v == null) v = trimmed;
        }
        svc.setCheckpoint(name, v == null ? "" : v);
        return ResponseEntity.ok(Map.of("checkpoint", svc.getCheckpoint(name)));
    }
}
