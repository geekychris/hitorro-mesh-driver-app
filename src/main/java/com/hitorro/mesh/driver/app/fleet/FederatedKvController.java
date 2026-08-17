/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.fleet;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

/**
 * REST surface for federated cross-fleet KV lookups. Symmetric with
 * {@link FederatedRetrievalController}.
 *
 * <ul>
 *   <li>{@code GET /mesh/retrieval/federated/kv/{index}/{key}} — first-match fetch</li>
 *   <li>{@code GET /mesh/retrieval/federated/kv/{index}/scan?prefix=…} — merged prefix scan (NDJson)</li>
 * </ul>
 */
@RestController
@RequestMapping("/mesh/retrieval/federated/kv")
public class FederatedKvController {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final FederatedKvService kv;

    public FederatedKvController(FederatedKvService kv) {
        this.kv = kv;
    }

    @GetMapping("/{index}/{key}")
    public ResponseEntity<byte[]> fetch(@PathVariable("index") String index,
                                        @PathVariable("key")   String key) {
        try {
            byte[] v = kv.get(index, key);
            if (v == null) return ResponseEntity.notFound().build();
            return ResponseEntity.ok()
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(v);
        } catch (IllegalStateException e) {
            return ResponseEntity.status(503).body(e.getMessage().getBytes());
        }
    }

    @GetMapping(value = "/{index}/scan", produces = "application/x-ndjson")
    public ResponseEntity<StreamingResponseBody> scan(@PathVariable("index") String index,
                                                      @RequestParam(name = "prefix", defaultValue = "") String prefix) {
        StreamingResponseBody body = out -> {
            var writer = new java.io.OutputStreamWriter(out, java.nio.charset.StandardCharsets.UTF_8);
            var mapper = JSON.getFactory().createGenerator(writer);
            for (var it = kv.scanEntries(index, prefix); it.hasNext(); ) {
                var e = it.next();
                writer.write("{\"key\":\"");
                writer.write(new String(e.getKey(), java.nio.charset.StandardCharsets.UTF_8)
                        .replace("\\", "\\\\").replace("\"", "\\\""));
                writer.write("\",\"value\":");
                writer.write(new String(e.getValue(), java.nio.charset.StandardCharsets.UTF_8));
                writer.write("}\n");
            }
            writer.flush();
        };
        return ResponseEntity.ok(body);
    }
}
