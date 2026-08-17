/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.storage;

import com.hitorro.mesh.EnableS3Message;
import com.hitorro.mesh.driver.MeshDriver;
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

    private final ObjectProvider<MeshDriver> driverProvider;

    public MinioLifecycleService(ConfigurableApplicationContext ctx,
                                 Environment env,
                                 ObjectProvider<MinioProtocolAdapter> bootAdapter,
                                 ObjectProvider<MeshDriver> driverProvider) {
        this.ctx = ctx;
        this.env = env;
        this.bootAdapter = bootAdapter;
        this.driverProvider = driverProvider;
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

        // Fan out to every live agent — one click enables the whole mesh.
        // Agents subscribe on Subjects.agentControlEnableS3() in
        // S3AdapterInstaller and install the adapter the same way.
        MeshDriver driver = driverProvider.getIfAvailable();
        int agentsNotified = 0;
        if (driver != null) {
            try {
                driver.publishEnableS3(new EnableS3Message(endpoint, bucket, access, secret, false));
                agentsNotified = driver.agents().agentsWith(java.util.List.of("jvssql")).size();
                log.info("mesh: broadcast enable-s3 to {} live agent(s)", agentsNotified);
            } catch (Exception e) {
                log.warn("mesh: enable-s3 broadcast failed: {}", e.toString());
            }
        }

        out.put("endpoint", endpoint);
        out.put("bucket", bucket);
        out.put("reachable", true);
        out.put("adapterRegistered", true);
        out.put("agentsNotified", agentsNotified);
        out.put("alreadyRunning", alreadyUp);
        return out;
    }

    /**
     * Sync local datasets → MinIO by shelling out to
     * {@code minio-sync-datasets.sh}. Requires the container to be up.
     * Prints the script output so the caller can see per-dataset progress
     * (the script uses {@code mc mirror} which reports bytes/files).
     */
    public Map<String, Object> sync(String dataset) throws IOException, InterruptedException {
        Map<String, Object> out = new LinkedHashMap<>();
        File dir = findScriptsDir();
        if (dir == null) throw new IllegalStateException("MinIO scripts dir not found.");
        if (!ping(resolveEndpoint())) {
            throw new IllegalStateException("MinIO not reachable at " + resolveEndpoint()
                    + " — click Start first.");
        }
        List<String> stdout = new ArrayList<>();
        // Basic safety filter — dataset ids are lowercase-alphanumeric + dash,
        // never contain shell-meta chars. Reject anything that would break
        // out of the argv position.
        if (dataset != null && !dataset.isBlank()) {
            if (!dataset.matches("[a-zA-Z0-9._-]+")) {
                throw new IllegalArgumentException("invalid dataset id: " + dataset);
            }
        }
        int rc = runScript(dir, "minio-sync-datasets.sh", stdout,
                dataset == null || dataset.isBlank() ? new String[0] : new String[]{dataset});
        out.put("scriptExitCode", rc);
        out.put("scriptOutput", String.join("\n", stdout));
        out.put("dataset", dataset == null ? "" : dataset);
        out.put("success", rc == 0);
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

    /** Overload that runs with no extra args. */
    private static int runScript(File dir, String name, List<String> stdout)
            throws IOException, InterruptedException {
        return runScript(dir, name, stdout, new String[0]);
    }

    /**
     * Streaming variant of {@link #runScript} — invokes {@code onLine}
     * for every stdout line as it arrives. Used by the SSE sync
     * endpoint so the UI can show live mc-mirror progress instead of
     * waiting for the whole script to finish before displaying anything.
     *
     * @return the script exit code
     */
    public int runScriptStreaming(String name, String[] args,
                                  java.util.function.Consumer<String> onLine)
            throws IOException, InterruptedException {
        File dir = findScriptsDir();
        if (dir == null) throw new IllegalStateException("MinIO scripts dir not found.");
        File script = new File(dir, name);
        if (!script.canExecute()) script.setExecutable(true, true);
        List<String> cmd = new ArrayList<>();
        cmd.add("/bin/bash");
        cmd.add(script.getAbsolutePath());
        for (String a : args) cmd.add(a);
        Process p = new ProcessBuilder(cmd)
                .directory(dir).redirectErrorStream(true).start();
        try (var reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(p.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                onLine.accept(line);
            }
        }
        if (!p.waitFor(600, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            throw new IOException(name + " timed out after 600s");
        }
        return p.exitValue();
    }

    /** Validate + normalise a dataset id or throw. Same rules as {@link #sync}. */
    public void validateDataset(String dataset) {
        if (dataset != null && !dataset.isBlank() && !dataset.matches("[a-zA-Z0-9._-]+")) {
            throw new IllegalArgumentException("invalid dataset id: " + dataset);
        }
    }

    /** Whether MinIO is reachable — cheap health check. */
    public boolean isReachable() {
        return ping(resolveEndpoint());
    }

    /** Run a shell script from the scripts dir, capturing stdout+stderr. */
    private static int runScript(File dir, String name, List<String> stdout, String[] args)
            throws IOException, InterruptedException {
        File script = new File(dir, name);
        if (!script.canExecute()) {
            // Best-effort chmod.
            script.setExecutable(true, true);
        }
        List<String> cmd = new ArrayList<>();
        cmd.add("/bin/bash");
        cmd.add(script.getAbsolutePath());
        for (String a : args) cmd.add(a);
        Process p = new ProcessBuilder(cmd)
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
