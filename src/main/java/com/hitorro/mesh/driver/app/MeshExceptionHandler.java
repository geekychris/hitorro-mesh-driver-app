/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.hitorro.mesh.AgentTaskException;
import com.hitorro.mesh.MeshException;
import com.hitorro.mesh.QueryTimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Phase 7c — global exception handler mapping typed mesh errors to
 * clean JSON responses with actionable HTTP status codes.
 *
 * <ul>
 *   <li>{@link QueryTimeoutException} → 408 Request Timeout</li>
 *   <li>{@link AgentTaskException} → 502 Bad Gateway (agent-side failure
 *       is analogous to an upstream failure)</li>
 *   <li>{@link IllegalArgumentException} → 400 Bad Request (planner-side
 *       validation failures like unregistered tables, unsupported SQL)</li>
 *   <li>Other {@link MeshException} → 500 Internal Server Error</li>
 * </ul>
 *
 * <p>Every response body carries {@code error} (short type identifier),
 * {@code message} (human-readable), and — when known — {@code queryId}
 * for log correlation.</p>
 */
@RestControllerAdvice
public class MeshExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(MeshExceptionHandler.class);

    @ExceptionHandler(QueryTimeoutException.class)
    public ResponseEntity<Map<String, Object>> handleTimeout(QueryTimeoutException e) {
        log.info("query timeout: queryId={} message={}", e.queryId(), e.getMessage());
        return ResponseEntity.status(HttpStatus.REQUEST_TIMEOUT)
                .body(body("query_timeout", e.getMessage(), e.queryId()));
    }

    @ExceptionHandler(AgentTaskException.class)
    public ResponseEntity<Map<String, Object>> handleAgentTask(AgentTaskException e) {
        log.warn("agent task error: queryId={} message={}", e.queryId(), e.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(body("agent_task_error", e.getMessage(), e.queryId()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, Object>> handleBadRequest(IllegalArgumentException e) {
        log.info("bad request: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(body("bad_request", e.getMessage(), null));
    }

    @ExceptionHandler(MeshException.class)
    public ResponseEntity<Map<String, Object>> handleMesh(MeshException e) {
        log.error("mesh error: queryId={} message={}", e.queryId(), e.getMessage(), e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(body("mesh_error", e.getMessage(), e.queryId()));
    }

    private static Map<String, Object> body(String type, String message, String queryId) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", type);
        out.put("message", message == null ? "" : message);
        if (queryId != null) out.put("queryId", queryId);
        return out;
    }
}
