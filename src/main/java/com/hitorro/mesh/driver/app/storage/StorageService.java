/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.storage;

import com.hitorro.util.basefile.fs.BaseFile;
import com.hitorro.util.basefile.fs.BaseFileSystem;
import com.hitorro.util.basefile.fs.s3.MinioProtocolAdapter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Read-only inspection of the storage layer that backs the mesh's
 * datasets + pipeline outputs. Reports:
 *
 * <ul>
 *   <li>Which backend is active — local filesystem, MinIO / S3, or both</li>
 *   <li>For S3: endpoint, bucket, SSL flag</li>
 *   <li>Per-dataset presence — installed locally, present on S3, both</li>
 *   <li>Size totals per source (best-effort — local via {@code Files.walk};
 *       S3 via a bucket list call)</li>
 * </ul>
 *
 * <p>Powers {@code GET /mesh/storage} and the UI's Cluster → Storage
 * sub-tab. Cheap enough to poll on every UI refresh (couple ms locally;
 * one S3 list call for the bucket).</p>
 */
@Service
public class StorageService {

    private static final Logger log = LoggerFactory.getLogger(StorageService.class);

    /** Present when {@link S3StorageAutoConfig} activated. Absent otherwise. */
    private final ObjectProvider<MinioProtocolAdapter> s3;
    private final Path datasetsHome;

    public StorageService(ObjectProvider<MinioProtocolAdapter> s3) {
        this.s3 = s3;
        String home = System.getenv().getOrDefault("HITORRO_DATASETS_HOME",
                System.getProperty("user.home") + "/.hitorro/datasets");
        this.datasetsHome = Path.of(home);
    }

    /** Top-level summary shape for {@code GET /mesh/storage}. */
    public Map<String, Object> summary() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("localDatasetsHome", datasetsHome.toString());
        out.put("localBackend", localBackendSummary());
        MinioProtocolAdapter minio = s3.getIfAvailable();
        if (minio != null) {
            out.put("s3Backend", s3BackendSummary(minio));
        }
        out.put("datasets", datasetPresence(minio));
        return out;
    }

    private Map<String, Object> localBackendSummary() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "local");
        m.put("root", datasetsHome.toString());
        m.put("exists", Files.isDirectory(datasetsHome));
        if (Files.isDirectory(datasetsHome)) {
            long[] stats = walkSize(datasetsHome);
            m.put("bytes", stats[0]);
            m.put("files", stats[1]);
        }
        return m;
    }

    private Map<String, Object> s3BackendSummary(MinioProtocolAdapter minio) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kind", "s3");
        m.put("endpoint", minio.getEndpoint());
        m.put("bucket",   minio.getBucket());
        m.put("ssl",      minio.isSslEnabled());
        // Best-effort presence probe — see if the datasets/ prefix responds.
        m.put("reachable", canProbeS3(minio));
        return m;
    }

    private boolean canProbeS3(MinioProtocolAdapter minio) {
        try {
            BaseFile probe = BaseFileSystem.getBaseFileFromPath(
                    "s3://" + minio.getBucket() + "/datasets/");
            // getBaseFileFromPath returning without exception is enough — we
            // don't force a network round-trip here for cheapness.
            return probe != null;
        } catch (Exception e) {
            log.debug("s3 probe failed: {}", e.getMessage());
            return false;
        }
    }

    /**
     * Per-dataset {installed-locally, present-on-s3} matrix. Cheap
     * subdir listing on both sides — no per-file walk.
     */
    private List<Map<String, Object>> datasetPresence(MinioProtocolAdapter minio) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (!Files.isDirectory(datasetsHome)) return out;
        try (var subdirs = Files.list(datasetsHome)) {
            subdirs.filter(Files::isDirectory).sorted().forEach(p -> {
                Map<String, Object> row = new LinkedHashMap<>();
                String id = p.getFileName().toString();
                row.put("id", id);
                row.put("local", true);
                if (minio != null) {
                    row.put("s3", s3HasDataset(minio, id));
                }
                out.add(row);
            });
        } catch (IOException e) {
            log.warn("datasets home walk failed: {}", e.getMessage());
        }
        return out;
    }

    /** Cheap check — try to open the dataset's manifest.yaml over S3. */
    private boolean s3HasDataset(MinioProtocolAdapter minio, String id) {
        try {
            BaseFile bf = BaseFileSystem.getBaseFileFromPath(
                    "s3://" + minio.getBucket() + "/datasets/" + id + "/manifest.yaml");
            return bf != null && bf.exists();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * List entries under a storage path. Uses {@link BaseFileSystem}
     * uniformly so local dirs and S3 prefixes browse the same way.
     *
     * <p>The {@code path} arg can be:</p>
     * <ul>
     *   <li>Empty — defaults to the datasets root (S3 bucket + datasets/
     *       prefix when S3 is configured, else {@code HITORRO_DATASETS_HOME}).</li>
     *   <li>A bare relative path (e.g. {@code datasets/iso-currencies/}) —
     *       resolved against the same default root.</li>
     *   <li>An explicit URI ({@code s3://…}, {@code file:…}) — used as-is.</li>
     * </ul>
     *
     * <p>Response shape:
     * <pre>
     * {
     *   "path":     "s3://hitorro/datasets/iso-currencies/",
     *   "resolved": "s3://hitorro/datasets/iso-currencies/",
     *   "parent":   "s3://hitorro/datasets/",
     *   "entries":  [
     *     { "name": "data",     "isDir": true,  "size": 0 },
     *     { "name": "types",    "isDir": true,  "size": 0 },
     *     { "name": "manifest.yaml", "isDir": false, "size": 1287 }
     *   ]
     * }
     * </pre></p>
     */
    /**
     * Head-of-file preview — read the first {@code maxLines} lines (or
     * ~64KB, whichever comes first) via {@link BaseFileSystem} so any URI
     * scheme works uniformly. Text-oriented: intended for NDJson, CSV,
     * JSON, TSV. Binary files (Parquet, gzip w/o text extension) get a
     * best-effort peek at the first bytes rendered as UTF-8 with a
     * "possibly binary" flag when the raw bytes fail to decode as text.
     */
    public Map<String, Object> head(String path, int maxLines, int maxBytes) throws Exception {
        String resolved = resolveBrowsePath(path);
        BaseFile bf = BaseFileSystem.getBaseFileFromPath(resolved);
        if (bf == null || !bf.exists()) {
            throw new IllegalArgumentException("path not found: " + resolved);
        }
        if (bf.isDir()) {
            throw new IllegalArgumentException("not a file: " + resolved);
        }
        int lineCap = Math.max(1, Math.min(maxLines, 500));
        int byteCap = Math.max(256, Math.min(maxBytes, 262_144));  // 256 KB cap
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("path", path == null ? "" : path);
        out.put("resolved", resolved);
        out.put("size", safeLength(bf));

        // Parquet: return the Avro schema instead of raw bytes — much
        // more useful than a hex dump of the file header.
        if (resolved.toLowerCase().endsWith(".parquet")) {
            out.put("kind", "parquet");
            out.put("preview", parquetPeek(resolved));
            return out;
        }

        // Text-oriented preview via BaseFile (handles .gz/.bz2/.zstd via
        // extension). Read into a small buffer, split on newlines.
        StringBuilder sb = new StringBuilder();
        int lines = 0;
        boolean truncated = false;
        try (java.io.InputStream is = bf.getInputStream();
             java.io.BufferedReader r = new java.io.BufferedReader(
                     new java.io.InputStreamReader(is, java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null && lines < lineCap && sb.length() < byteCap) {
                sb.append(line).append('\n');
                lines++;
            }
            if (line != null || sb.length() >= byteCap) truncated = true;
        }
        out.put("kind", "text");
        out.put("lines", lines);
        out.put("truncated", truncated);
        out.put("preview", sb.toString());
        return out;
    }

    /** Best-effort Parquet header inspection — returns the Avro schema
     *  as a pretty JSON string, plus a row count if cheap to obtain. */
    private static String parquetPeek(String uri) {
        try {
            String u = uri.startsWith("s3://") ? "s3a://" + uri.substring(5) : uri;
            org.apache.hadoop.conf.Configuration conf = new org.apache.hadoop.conf.Configuration();
            conf.set("fs.s3a.path.style.access", "true");
            try (org.apache.parquet.hadoop.ParquetFileReader reader =
                    org.apache.parquet.hadoop.ParquetFileReader.open(
                            org.apache.parquet.hadoop.util.HadoopInputFile.fromPath(
                                    new org.apache.hadoop.fs.Path(u), conf))) {
                org.apache.parquet.hadoop.metadata.ParquetMetadata md = reader.getFooter();
                return "schema:\n" + md.getFileMetaData().getSchema().toString()
                        + "\n\nrows: " + reader.getRecordCount();
            }
        } catch (Exception e) {
            return "(parquet peek failed: " + e.getMessage() + ")";
        }
    }

    public Map<String, Object> browse(String path) throws Exception {
        String resolved = resolveBrowsePath(path);
        BaseFile bf = BaseFileSystem.getBaseFileFromPath(resolved);
        if (bf == null || !bf.exists()) {
            throw new IllegalArgumentException("path not found: " + resolved);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("path", path == null ? "" : path);
        out.put("resolved", resolved);
        out.put("parent", parentOf(resolved));

        List<Map<String, Object>> entries = new ArrayList<>();
        if (bf.isDir()) {
            BaseFile[] kids = bf.listFiles();
            if (kids != null) {
                java.util.Arrays.sort(kids, (a, b) -> {
                    // dirs first, then alpha
                    if (a.isDir() != b.isDir()) return a.isDir() ? -1 : 1;
                    return a.getName().compareTo(b.getName());
                });
                for (BaseFile k : kids) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("name", k.getName());
                    row.put("isDir", k.isDir());
                    row.put("size", k.isDir() ? 0L : safeLength(k));
                    entries.add(row);
                }
            }
        } else {
            // Single-file browse: just report itself.
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", bf.getName());
            row.put("isDir", false);
            row.put("size", safeLength(bf));
            entries.add(row);
        }
        out.put("entries", entries);
        return out;
    }

    private String resolveBrowsePath(String path) {
        String p = path == null ? "" : path.trim();
        // Already an explicit URI — use as-is.
        if (p.startsWith("s3://") || p.startsWith("file:") || p.startsWith("http://") || p.startsWith("https://")) {
            return p;
        }
        // Empty or relative — resolve against the default root.
        MinioProtocolAdapter minio = s3.getIfAvailable();
        if (minio != null) {
            String base = "s3://" + minio.getBucket() + "/";
            // Default to the bucket root — always exists on a live bucket,
            // and shows every top-level prefix (datasets/, queries/, …) so
            // the user can see what's actually there instead of erroring
            // out on a hard-coded "datasets/" that hasn't been synced yet.
            if (p.isEmpty()) return base;
            return base + (p.startsWith("/") ? p.substring(1) : p);
        }
        if (p.isEmpty()) return "file:" + datasetsHome;
        if (p.startsWith("/")) return "file:" + p;
        return "file:" + datasetsHome + "/" + p;
    }

    private static String parentOf(String uri) {
        int scheme = uri.indexOf("://");
        int start = scheme < 0 ? uri.indexOf(':') + 1 : scheme + 3;
        String prefix = uri.substring(0, start);
        String rest = uri.substring(start);
        // Trim trailing slash before splitting so /a/b/ → parent is /a/
        String trimmed = rest.endsWith("/") ? rest.substring(0, rest.length() - 1) : rest;
        int slash = trimmed.lastIndexOf('/');
        if (slash <= 0) return null;
        return prefix + trimmed.substring(0, slash + 1);
    }

    /**
     * Delete an object (or directory). Routes through {@link BaseFile#delete}
     * so file:/, s3://, hdfs://, ftp:// all work uniformly.
     */
    public Map<String, Object> delete(String path) throws Exception {
        String resolved = resolveBrowsePath(path);
        BaseFile bf = BaseFileSystem.getBaseFileFromPath(resolved);
        if (bf == null || !bf.exists()) {
            throw new IllegalArgumentException("path not found: " + resolved);
        }
        boolean isDir = bf.isDir();
        boolean deleted = bf.delete();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("path", path);
        out.put("resolved", resolved);
        out.put("wasDir", isDir);
        out.put("deleted", deleted);
        return out;
    }

    /**
     * Open a stream for a file — the caller writes it out with the right
     * Content-Type + Content-Disposition. Returns the raw {@link BaseFile}
     * so the caller can also read {@code length()} + {@code getName()}.
     */
    public BaseFile openForDownload(String path) throws Exception {
        String resolved = resolveBrowsePath(path);
        BaseFile bf = BaseFileSystem.getBaseFileFromPath(resolved);
        if (bf == null || !bf.exists()) {
            throw new IllegalArgumentException("path not found: " + resolved);
        }
        if (bf.isDir()) {
            throw new IllegalArgumentException("cannot download a directory: " + resolved);
        }
        return bf;
    }

    private static long safeLength(BaseFile bf) {
        try { return bf.length(); } catch (Exception e) { return -1L; }
    }

    /** Walk a local directory, sum bytes + file count. Best-effort. */
    private static long[] walkSize(Path root) {
        long[] r = new long[2]; // {bytes, files}
        try {
            Files.walkFileTree(root, new java.nio.file.SimpleFileVisitor<>() {
                @Override
                public java.nio.file.FileVisitResult visitFile(Path f, BasicFileAttributes a) {
                    r[0] += a.size();
                    r[1]++;
                    return java.nio.file.FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException ignore) { /* partial size is fine */ }
        return r;
    }
}
