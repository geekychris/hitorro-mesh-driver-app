/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.fasterxml.jackson.databind.JsonNode;
import com.hitorro.mesh.driver.MeshDriver;
import com.hitorro.mesh.driver.QueryDispatcher;
import com.hitorro.util.basefile.fs.s3.MinioProtocolAdapter;
import com.hitorro.util.core.iterator.sinks.NdjsonFileSink;
import com.hitorro.util.core.iterator.sinks.Sink;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Execute a SQL query and write the result rows to a storage URI as
 * NDJson or Parquet — the "SELECT … TO file" story for the Playground.
 *
 * <p>Endpoint: {@code POST /mesh/queries/write}</p>
 * <pre>{@code
 * {
 *   "sql":       "SELECT alpha3, name FROM iso_currencies LIMIT 10",
 *   "format":    "ndjson",                       // or "parquet"
 *   "path":      "s3://hitorro/exports/foo.ndjson.gz",
 *   "timeoutMs": 60000                            // optional
 * }
 * }</pre>
 *
 * <p>Response: {@code { rowsWritten, path, format, elapsedMs, queryId }}</p>
 *
 * <p>NDJson goes through {@code NdjsonFileSink} (streams) — routes via
 * BaseFile so {@code s3://}, {@code file:}, {@code hdfs://} all work.
 * Parquet requires {@code hitorro-streams-parquet} on the classpath;
 * loaded reflectively so the driver boots without it. The 400 error
 * message points at the required dep.</p>
 */
@RestController
@RequestMapping("/mesh/queries")
public class QueryWriteController {

    private static final Logger log = LoggerFactory.getLogger(QueryWriteController.class);

    private final MeshDriver driver;
    private final ObjectProvider<MinioProtocolAdapter> s3;

    public QueryWriteController(MeshDriver driver,
                                ObjectProvider<MinioProtocolAdapter> s3) {
        this.driver = driver;
        this.s3 = s3;
    }

    /**
     * Where a bare name (no scheme) writes to:
     * <ul>
     *   <li>S3 configured → {@code s3://<bucket>/queries/<name>.<format>}</li>
     *   <li>otherwise     → {@code file:./queries/<name>.<format>} (relative
     *       to driver working directory)</li>
     * </ul>
     * Explicit URIs ({@code file:/…}, {@code s3://…}, {@code hdfs://…})
     * pass through unchanged.
     */
    private String resolveWritePath(String userPath, String format) {
        String p = userPath.trim();
        if (p.startsWith("s3://") || p.startsWith("file:")
                || p.startsWith("hdfs://") || p.startsWith("http://") || p.startsWith("https://")) {
            return p;
        }
        String ext = format.equals("parquet") ? ".parquet" : ".ndjson";
        // Only append the format extension if the user didn't include one.
        String name = p.endsWith(".ndjson") || p.endsWith(".parquet")
                || p.endsWith(".ndjson.gz") || p.endsWith(".ndjson.bz2") ? p : p + ext;
        MinioProtocolAdapter minio = s3.getIfAvailable();
        if (minio != null) {
            return "s3://" + minio.getBucket() + "/queries/" + name;
        }
        // file: URIs must be absolute (java.net.URI + Hadoop Path both reject
        // "file:./…"). Resolve against the driver's working dir so the user's
        // bare name lands somewhere predictable and Hadoop-writable.
        java.nio.file.Path abs = java.nio.file.Paths.get("queries", name).toAbsolutePath();
        return "file:" + abs;
    }

    /**
     * Pre-flight resolver so the UI can show where a bare name will land
     * before the user clicks Write. No SQL executed. Returns
     * {@code {resolved: "s3://…" or "file:./…"}}.
     */
    @GetMapping("/write/resolve")
    public Map<String, Object> resolve(@RequestParam(name = "path", defaultValue = "example") String path,
                                       @RequestParam(name = "format", defaultValue = "ndjson") String format) {
        return Map.of("resolved", resolveWritePath(path, format));
    }

    public static final class WriteRequest {
        public String sql;
        public String format;   // "ndjson" | "parquet"
        public String path;     // file:/… | s3://bucket/key | hdfs://…
        public long timeoutMs = 60_000;
    }

    @PostMapping("/write")
    public ResponseEntity<Map<String, Object>> write(@RequestBody WriteRequest req) {
        long tStart = System.nanoTime();
        Map<String, Object> out = new LinkedHashMap<>();
        try {
            requireNonBlank("sql", req.sql);
            requireNonBlank("format", req.format);
            requireNonBlank("path", req.path);
            String format = req.format.trim().toLowerCase();
            String resolved = resolveWritePath(req.path, format);

            Sink<JsonNode> sink = openSink(format, resolved);
            long rows;
            String queryId;
            try (QueryDispatcher.QueryHandle h = driver.dispatcher().submit(
                    req.sql, Duration.ofMillis(req.timeoutMs))) {
                queryId = h.queryId();
                sink.start();
                List<JsonNode> collected = h.collect(req.timeoutMs, TimeUnit.MILLISECONDS);
                for (JsonNode row : collected) sink.add(row);
                rows = collected.size();
            } finally {
                try { sink.close(); } catch (Exception e) { log.warn("sink close failed", e); }
            }

            out.put("queryId", queryId);
            out.put("format", format);
            out.put("path", req.path);
            out.put("resolved", resolved);
            out.put("rowsWritten", rows);
            out.put("elapsedMs", (System.nanoTime() - tStart) / 1_000_000);
            out.put("success", true);
            return ResponseEntity.ok(out);

        } catch (IllegalArgumentException e) {
            out.put("success", false);
            out.put("error", e.getMessage());
            out.put("elapsedMs", (System.nanoTime() - tStart) / 1_000_000);
            return ResponseEntity.badRequest().body(out);
        } catch (Exception e) {
            log.error("query write failed", e);
            out.put("success", false);
            out.put("error", e.getMessage());
            out.put("elapsedMs", (System.nanoTime() - tStart) / 1_000_000);
            return ResponseEntity.status(500).body(out);
        }
    }

    /**
     * Wire the format to a concrete Sink. Parquet is loaded reflectively so
     * the driver-app builds and boots without pulling parquet + hadoop
     * transitively — callers who need it drop hitorro-streams-parquet on
     * the classpath.
     */
    private static Sink<JsonNode> openSink(String format, String path) throws Exception {
        return switch (format) {
            case "ndjson" -> new NdjsonFileSink(path);
            case "parquet" -> {
                try {
                    Class<?> cls = Class.forName(
                            "com.hitorro.util.core.iterator.sinks.parquet.ParquetFileSink");
                    @SuppressWarnings("unchecked")
                    Sink<JsonNode> s = (Sink<JsonNode>) cls.getConstructor(String.class).newInstance(path);
                    yield s;
                } catch (ClassNotFoundException e) {
                    throw new IllegalArgumentException(
                            "parquet format requires hitorro-streams-parquet on the classpath");
                }
            }
            default -> throw new IllegalArgumentException(
                    "unknown format: " + format + " (supported: ndjson, parquet)");
        };
    }

    private static void requireNonBlank(String field, String v) {
        if (v == null || v.isBlank()) {
            throw new IllegalArgumentException(field + " is required");
        }
    }
}
