/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Shape + defaulting tests for {@link QueryWriteController.BatchWriteRequest}
 * and {@link QueryWriteController.WriteRequest}. Full end-to-end
 * batch-write requires a live MeshDriver; verified in the smoke script.
 * These tests cover the JSON-body deserialisation + defaults the
 * controller relies on so the batch path isn't fooled by a malformed
 * client payload.
 */
class BatchWriteRequestShapeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void batchRequest_deserialisesFromCleanJson() throws Exception {
        String body = """
            {
              "format": "ndjson",
              "register": true,
              "timeoutMs": 30000,
              "queries": [
                {"sql": "SELECT 1", "tableName": "a"},
                {"sql": "SELECT 2", "tableName": "b", "path": "file:/tmp/b.ndjson"}
              ]
            }
            """;
        var req = JSON.readValue(body, QueryWriteController.BatchWriteRequest.class);
        assertThat(req.format).isEqualTo("ndjson");
        assertThat(req.register).isTrue();
        assertThat(req.timeoutMs).isEqualTo(30_000);
        assertThat(req.queries).hasSize(2);
        assertThat(req.queries.get(0).tableName).isEqualTo("a");
        assertThat(req.queries.get(1).path).isEqualTo("file:/tmp/b.ndjson");
    }

    @Test
    void batchRequest_defaults_applyWhenPerQueryFieldsOmitted() throws Exception {
        // Per-query WriteRequest has default timeoutMs=60000 in the class;
        // the batch loop overrides only when q.timeoutMs <= 0. So an
        // omitted per-query timeoutMs stays at the WriteRequest default,
        // NOT the batch default. Documents the current behaviour.
        String body = """
            {"format":"ndjson","register":false,"timeoutMs":90000,
             "queries":[{"sql":"SELECT 1"}]}
            """;
        var req = JSON.readValue(body, QueryWriteController.BatchWriteRequest.class);
        var q = req.queries.get(0);
        assertThat(q.timeoutMs).isEqualTo(60_000);  // WriteRequest's default
    }

    @Test
    void writeRequest_typeJsonOverride_deserialises() throws Exception {
        var req = JSON.readValue("""
            {"sql":"SELECT 1","format":"ndjson","path":"file:/x",
             "register":true,"tableName":"x",
             "typeJsonOverride":"{\\"name\\":\\"x\\",\\"fields\\":[]}"}
            """, QueryWriteController.WriteRequest.class);
        assertThat(req.typeJsonOverride).contains("\"name\":\"x\"");
    }

    @Test
    void emptyQueries_isDetectableViaListSize() throws Exception {
        var req = JSON.readValue("""
            {"format":"ndjson","register":false,"queries":[]}
            """, QueryWriteController.BatchWriteRequest.class);
        assertThat(req.queries).isEmpty();
    }

    @Test
    void queriesList_missing_isNull() throws Exception {
        // Controller checks (req.queries == null || req.queries.isEmpty())
        // so both cases short-circuit to a 400.
        var req = JSON.readValue("""
            {"format":"ndjson","register":false}
            """, QueryWriteController.BatchWriteRequest.class);
        assertThat(req.queries).isNull();
    }
}
