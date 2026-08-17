/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.storage;

import com.hitorro.util.basefile.fs.BaseFileSystem;
import com.hitorro.util.basefile.fs.s3.MinioProtocolAdapter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Bring MinIO up/down from the UI and hot-switch the driver's S3
 * protocol adapter — no restart needed. Shells out to
 * {@code minio-up.sh} / {@code minio-down.sh} in the bundled
 * hitorro-mesh-examples scripts dir; polls MinIO's health endpoint;
 * on success constructs a {@link MinioProtocolAdapter}, wires it into
 * {@link BaseFileSystem} and registers it as a Spring singleton so
 * every {@code ObjectProvider<MinioProtocolAdapter>} in the app
 * (StorageService, QueryWriteController, …) picks it up immediately.
 *
 * <p>Script-dir lookup order:</p>
 * <ol>
 *   <li>{@code hitorro.storage.minio.scripts-dir} property</li>
 *   <li>{@code HITORRO_MESH_EXAMPLES_HOME} env → {@code $_/scripts/minio}</li>
 *   <li>Walk up from CWD looking for {@code hitorro-mesh-examples/scripts/minio}</li>
 * </ol>
 *
 * <p>Agents in a distributed mesh still need their own S3 config +
 * restart to read s3:// tables. The hot-switch here only enables the
 * driver's write path (Playground → file), storage browser, and
 * anything else that resolves URIs via BaseFile from the driver JVM.</p>
 */
@Service
public class MinioLifecycleService {

    private static final Logger log = LoggerFactory.getLogger(MinioLifecycleService.class);

    /** Poll ~30s for MinIO health after start. */
    private static final Duration START_TIMEOUT = Duration.ofSeconds(30);
    private static final Duration POLL_INTERVAL = Duration.ofMillis(500);

    private final ConfigurableApplicationContext ctx;
    private final Environment env;
    private final ObjectProvider<MinioProtocolAdapter> bootAdapter;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2)).build();

    public MinioLifecycleService(ConfigurableApplicationContext ctx,
                                 Environment env,
                                 ObjectProvider<MinioProtocolAdapter> bootAdapter) {
        this.ctx = ctx;
        this.env = env;
        this.bootAdapter = bootAdapter;
    }

    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        String endpoint = resolveEndpoint();
        String bucket = resolveBucket();
        out.put("endpoint", endpoint);
        out.put("bucket", bucket);
        out.put("consoleUrl", "http://localhost:"
                + env.getProperty("HITORRO_MINIO_CONSOLE_PORT", "9001"));
        out.put("username", env.getProperty("HITORRO_MINIO_ROOT_USER", "hitorro"));
        out.put("passwordHint", "hitorro-dev-only (or $HITORRO_MINIO_ROOT_PASSWORD)");
        out.put("reachable", ping(endpoint));
        out.put("adapterRegistered", bootAdapter.getIfAvailable() != null);
        out.put("dockerAvailable", commandExists("docker"));
        File dir = findScriptsDir();
        out.put("scriptsDir", dir == null ? null : dir.getAbsolutePath());
        return out;
    }

    public Map<String, Object> start() throws IOException, InterruptedException {
        Map<String, Object> out = new LinkedHashMap<>();
        File dir = findScriptsDir();
        if (dir == null) {
            throw new IllegalStateException("MinIO scripts dir not found. Set "
                    + "HITORRO_MESH_EXAMPLES_HOME or hitorro.storage.minio.scripts-dir.");
        }
        if (!commandExists("docker")) {
            throw new IllegalStateException("docker not found on PATH. "
                    + "Install Docker Desktop or ensure `docker` is available.");
        }
        String endpoint = resolveEndpoint();
        String bucket = resolveBucket();

        // If already reachable, just wire the adapter and return.
        boolean alreadyUp = ping(endpoint);
        if (!alreadyUp) {
            List<String> stdout = new ArrayList<>();
            int rc = runScript(dir, "minio-up.sh", stdout);
            out.put("scriptExitCode", rc);
            out.put("scriptOutput", String.join("\n", stdout));
            if (rc != 0) {
                throw new IOException("minio-up.sh exited with " + rc);
            }
            // Poll until health endpoint responds.
            long deadline = System.nanoTime() + START_TIMEOUT.toNanos();
            while (System.nanoTime() < deadline) {
                if (ping(endpoint)) break;
                Thread.sleep(POLL_INTERVAL.toMillis());
            }
            if (!ping(endpoint)) {
                throw new IOException("MinIO did not become reachable within "
                        + START_TIMEOUT.toSeconds() + "s at " + endpoint);
            }
        }

        // Wire (or re-wire) the runtime adapter. addProtocolAdapter is
        // idempotent (last-writer-wins in a hash map), safe to call again.
        String access = env.getProperty("HITORRO_MINIO_ROOT_USER",
                env.getProperty("hitorro.storage.s3.access-key", "hitorro"));
        String secret = env.getProperty("HITORRO_MINIO_ROOT_PASSWORD",
                env.getProperty("hitorro.storage.s3.secret-key", "hitorro-dev-only"));
        MinioProtocolAdapter a = new MinioProtocolAdapter(endpoint, bucket, access, secret, false);
        BaseFileSystem.addProtocolAdapter(a);
        registerSingleton(a);

        out.put("endpoint", endpoint);
        out.put("bucket", bucket);
        out.put("reachable", true);
        out.put("adapterRegistered", true);
        out.put("alreadyRunning", alreadyUp);
        return out;
    }

    public Map<String, Object> stop() throws IOException, InterruptedException {
        Map<String, Object> out = new LinkedHashMap<>();
        File dir = findScriptsDir();
        if (dir == null) {
            throw new IllegalStateException("MinIO scripts dir not found.");
        }
        List<String> stdout = new ArrayList<>();
        int rc = runScript(dir, "minio-down.sh", stdout);
        out.put("scriptExitCode", rc);
        out.put("scriptOutput", String.join("\n", stdout));
        // Adapter stays registered so re-starting doesn't need a re-wire —
        // BaseFile calls will fail cleanly if MinIO is down.
        out.put("reachable", ping(resolveEndpoint()));
        return out;
    }

    /** POST /minio/health/live returns 200 when the server is live. */
    private boolean ping(String endpoint) {
        try {
            HttpRequest req = HttpRequest.newBuilder(
                    URI.create(endpoint + "/minio/health/live"))
                    .timeout(Duration.ofSeconds(2)).GET().build();
            return http.send(req, HttpResponse.BodyHandlers.discarding())
                    .statusCode() == 200;
        } catch (Exception e) {
            return false;
        }
    }

    private String resolveEndpoint() {
        String v = env.getProperty("hitorro.storage.s3.endpoint");
        if (v != null && !v.isBlank()) return v;
        return "http://localhost:" + env.getProperty("HITORRO_MINIO_S3_PORT", "9000");
    }

    private String resolveBucket() {
        String v = env.getProperty("hitorro.storage.s3.bucket");
        if (v != null && !v.isBlank()) return v;
        return env.getProperty("HITORRO_MINIO_BUCKET", "hitorro");
    }

    private File findScriptsDir() {
        String prop = env.getProperty("hitorro.storage.minio.scripts-dir");
        if (prop != null && !prop.isBlank()) {
            File f = new File(prop);
            if (isMinioScriptsDir(f)) return f;
        }
        String meshHome = env.getProperty("HITORRO_MESH_EXAMPLES_HOME");
        if (meshHome != null && !meshHome.isBlank()) {
            File f = new File(meshHome, "scripts/minio");
            if (isMinioScriptsDir(f)) return f;
        }
        // Walk up from CWD.
        Path cwd = Path.of("").toAbsolutePath();
        for (int i = 0; i < 8 && cwd != null; i++, cwd = cwd.getParent()) {
            File probe = cwd.resolve("hitorro-mesh-examples/scripts/minio").toFile();
            if (isMinioScriptsDir(probe)) return probe;
            probe = cwd.resolve("scripts/minio").toFile();
            if (isMinioScriptsDir(probe)) return probe;
        }
        return null;
    }

    private static boolean isMinioScriptsDir(File d) {
        return d.isDirectory()
                && new File(d, "minio-up.sh").isFile()
                && new File(d, "docker-compose.yml").isFile();
    }

    private static boolean commandExists(String cmd) {
        try {
            Process p = new ProcessBuilder("/bin/sh", "-c", "command -v " + cmd)
                    .redirectErrorStream(true).start();
            return p.waitFor(2, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** Run a shell script from the scripts dir, capturing stdout+stderr. */
    private static int runScript(File dir, String name, List<String> stdout)
            throws IOException, InterruptedException {
        File script = new File(dir, name);
        if (!script.canExecute()) {
            // Best-effort chmod.
            script.setExecutable(true, true);
        }
        Process p = new ProcessBuilder("/bin/bash", script.getAbsolutePath())
                .directory(dir).redirectErrorStream(true).start();
        try (var reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(p.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) stdout.add(line);
        }
        if (!p.waitFor(120, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException(name + " timed out after 120s");
        }
        int rc = p.exitValue();
        log.info("{} exit={} lines={}", name, rc, stdout.size());
        return rc;
    }

    /** Publish the adapter as a Spring singleton so pre-existing
     *  {@code ObjectProvider<MinioProtocolAdapter>} injections resolve it. */
    private void registerSingleton(MinioProtocolAdapter a) {
        ConfigurableListableBeanFactory bf = ctx.getBeanFactory();
        String name = "s3ProtocolAdapter";
        if (bf.containsSingleton(name)) {
            // Already there (either from S3StorageAutoConfig or a prior start).
            // We overwrite the BaseFileSystem entry above; leave the bean.
            return;
        }
        try {
            bf.registerSingleton(name, a);
        } catch (Exception e) {
            log.warn("could not register {} as Spring singleton: {}", name, e.toString());
        }
    }
}
