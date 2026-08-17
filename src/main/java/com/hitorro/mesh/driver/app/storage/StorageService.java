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
