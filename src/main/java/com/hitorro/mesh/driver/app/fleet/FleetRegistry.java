/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.fleet;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Hard-coded registry of known hitorro-fleet services. Grows as new fleet
 * members ship. Each entry knows where the fat jar likely lives (checked
 * in order at runtime), the default port, and a manifest template for
 * K8s and Orion deploys.
 */
public final class FleetRegistry {

    /** One deployable fleet member. */
    public record FleetMember(
            String name,
            String description,
            int defaultPort,
            int debugPort,
            String healthPath,
            List<Path> jarCandidates,
            Map<String, String> defaultEnv,
            List<String> defaultArgs) {}

    private FleetRegistry() {}

    private static final String HOME = System.getProperty("user.home");

    public static List<FleetMember> all() {
        return List.of(
                new FleetMember(
                        "fleet-retrieval",
                        "Full retrieval coordination runtime (RetrievalPipelineBuilder: "
                                + "Index → Document → Fixup → Pagination → Facet → Summarization). "
                                + "Shared-mode reads pipeline-produced Lucene + KV from ${HITORRO_PIPELINES_HOME}.",
                        8090,
                        5090,
                        "/api/retrieval/health",
                        jarCandidatesFor("hitorro-fleet-retrieval", "3.0.1"),
                        // HT_BIN must be set so the type system (JsonTypeSystem +
                        // LuceneFieldTypes) can find config/types + config/jsonconfigs
                        // when the coordinator resolves types for jvs-lucene queries.
                        Map.of(
                                "HITORRO_PIPELINES_HOME", HOME + "/.hitorro/pipelines",
                                "HT_BIN", detectHitorroBin()
                        ),
                        // -Dht.bin and -DHT_BIN mirror the env var (EnvCore checks
                        // sysprops first, then env). Belt and suspenders — some
                        // paths in the type system consult sysprops directly.
                        List.of(
                                "--hitorro.fleet.retrieval.mode=shared",
                                "--server.port=8090"
                        )
                )
                // future fleet members line up here (bump debugPort by 1 each)
        );
    }

    /**
     * Best-effort resolution of the hitorro repo root that holds
     * {@code config/types/} + {@code config/jsonconfigs/lucene/}. Env var wins,
     * then a sysprop, then the standard $HOME/hitorro layout, then $PWD.
     */
    private static String detectHitorroBin() {
        String p = System.getenv("HT_BIN");
        if (p == null || p.isBlank()) p = System.getProperty("HT_BIN");
        if (p == null || p.isBlank()) p = System.getProperty("ht.bin");
        if ((p == null || p.isBlank())
                && java.nio.file.Files.isDirectory(java.nio.file.Paths.get(HOME, "hitorro", "config", "types"))) {
            p = HOME + "/hitorro";
        }
        if (p == null || p.isBlank()) p = System.getProperty("user.dir", HOME);
        return p;
    }

    /** JDWP agent arg for a member — attach with jdb / IntelliJ Remote JVM Debug. */
    public static String jdwpArg(FleetMember m) {
        return "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:" + m.debugPort();
    }

    public static FleetMember byName(String name) {
        return all().stream().filter(m -> m.name().equals(name)).findFirst().orElse(null);
    }

    /** Find a jar in ~/hitorro/<module>/target or ~/.m2/repository. */
    private static List<Path> jarCandidatesFor(String artifactId, String version) {
        return List.of(
                Paths.get(HOME, "hitorro", artifactId, "target", artifactId + "-" + version + ".jar"),
                Paths.get(HOME, ".m2/repository/com/hitorro", artifactId, version,
                        artifactId + "-" + version + ".jar")
        );
    }

    /** Return the first existing jar for this member, or null. */
    public static Path resolveJar(FleetMember m) {
        for (Path p : m.jarCandidates()) if (Files.isRegularFile(p)) return p;
        return null;
    }

    /** IntelliJ IDEA Remote JVM Debug run-configuration XML for a member. */
    public static String intellijRunConfig(FleetMember m) {
        return """
                <!-- Save as .idea/runConfigurations/Debug_%s.xml at the repo root,
                     then Run → Debug → "Debug %s". Or add manually via
                     Run → Edit Configurations → + → Remote JVM Debug and paste
                     host=localhost port=%d, use "Attach to remote JVM". -->
                <component name="ProjectRunConfigurationManager">
                  <configuration default="false" name="Debug %s" type="Remote">
                    <option name="USE_SOCKET_TRANSPORT" value="true" />
                    <option name="SERVER_MODE" value="false" />
                    <option name="SHMEM_ADDRESS" />
                    <option name="HOST" value="localhost" />
                    <option name="PORT" value="%d" />
                    <option name="AUTO_RESTART" value="false" />
                    <RunnerSettings RunnerId="Debug">
                      <option name="DEBUG_PORT" value="%d" />
                      <option name="LOCAL" value="false" />
                    </RunnerSettings>
                    <method v="2" />
                  </configuration>
                </component>
                """.formatted(m.name(), m.name(), m.debugPort(),
                              m.name(), m.debugPort(), m.debugPort());
    }

    /**
     * Materialize a K8s Deployment+Service manifest for a fleet member.
     * Values are plain (no Helm templating) — user can pipe to kubectl.
     */
    public static String k8sManifest(FleetMember m) {
        String envBlock = m.defaultEnv().entrySet().stream()
                .map(e -> "            - name: " + e.getKey() + "\n              value: " + quote(e.getValue()))
                .collect(Collectors.joining("\n"));
        String argsBlock = Stream.concat(
                Stream.of(
                    "- " + quote(jdwpArg(m)),
                    "- \"-jar\"",
                    "- \"/opt/hitorro/" + m.name() + ".jar\""),
                m.defaultArgs().stream().map(a -> "- " + quote(a))
        ).collect(Collectors.joining("\n            "));
        return """
                # hitorro-fleet: %s
                # Apply:  kubectl apply -f %s.yaml
                # Prereqs: image hitorro/%s:3.0.1 pushed; PVC hitorro-pipelines-home mounted RWX
                #          across the mesh writers and this service.
                apiVersion: apps/v1
                kind: Deployment
                metadata:
                  name: hitorro-%s
                  labels: { app: hitorro-fleet, member: %s }
                spec:
                  replicas: 1
                  selector: { matchLabels: { app: hitorro-fleet, member: %s } }
                  template:
                    metadata:
                      labels: { app: hitorro-fleet, member: %s }
                    spec:
                      containers:
                        - name: %s
                          image: hitorro/%s:3.0.1
                          command: ["java"]
                          args:
                            %s
                          env:
                %s
                          ports:
                            - containerPort: %d
                              name: rest
                            - containerPort: %d
                              name: jdwp
                          readinessProbe:
                            httpGet: { path: %s, port: rest }
                            initialDelaySeconds: 5
                            periodSeconds: 3
                          livenessProbe:
                            httpGet: { path: /actuator/health, port: rest }
                            initialDelaySeconds: 20
                            periodSeconds: 10
                          resources:
                            requests: { cpu: "500m", memory: "1Gi" }
                            limits:   { cpu: "2",   memory: "3Gi" }
                          volumeMounts:
                            - name: pipelines-home
                              mountPath: /home/hitorro/.hitorro/pipelines
                      volumes:
                        - name: pipelines-home
                          persistentVolumeClaim:
                            claimName: hitorro-pipelines-home
                ---
                apiVersion: v1
                kind: Service
                metadata:
                  name: hitorro-%s
                  labels: { app: hitorro-fleet, member: %s }
                spec:
                  type: ClusterIP
                  selector: { app: hitorro-fleet, member: %s }
                  ports:
                    - name: rest
                      port: %d
                      targetPort: rest
                    - name: jdwp
                      port: %d
                      targetPort: jdwp
                # Debug: kubectl port-forward svc/hitorro-%s %d:%d — then attach IntelliJ Remote JVM Debug to localhost:%d
                """.formatted(
                m.name(), m.name(), m.name(),
                m.name(), m.name(), m.name(), m.name(),
                m.name(), m.name(),
                argsBlock, envBlock, m.defaultPort(), m.debugPort(),
                m.healthPath(),
                m.name(), m.name(), m.name(), m.defaultPort(), m.debugPort(),
                m.name(), m.debugPort(), m.debugPort(), m.debugPort());
    }

    /**
     * Materialize an Orion Service manifest. Mirrors the shape used by
     * hitorro-mesh-orion/templates/driver.yaml — java binary + jar args.
     */
    public static String orionManifest(FleetMember m) {
        String envBlock = m.defaultEnv().entrySet().stream()
                .map(e -> "    " + e.getKey() + ": " + quote(e.getValue()))
                .collect(Collectors.joining("\n"));
        String argsBlock = Stream.concat(
                Stream.of(
                    "- " + quote(jdwpArg(m)),
                    "- \"-jar\"",
                    "- \"${HITORRO_JARS}/" + m.name() + ".jar\""),
                m.defaultArgs().stream().map(a -> "- " + quote(a))
        ).collect(Collectors.joining("\n    "));
        return """
                # hitorro-fleet: %s
                # Apply:  orion apply -f %s.yaml
                # Prereqs: jars uploaded to ${HITORRO_JARS} on the Orion pool;
                #          shared FS mount at ${HITORRO_PIPELINES_HOME}.
                apiVersion: orion/v1
                kind: Service
                metadata:
                  name: hitorro-%s
                  labels:
                    app: hitorro-fleet
                    member: %s
                spec:
                  binary: java
                  args:
                    %s
                  env:
                    HITORRO_JARS: /opt/hitorro/jars
                %s
                    JAVA_TOOL_OPTIONS: "-Xmx2G"
                  ports:
                    - name: rest
                      port: %d
                      protocol: tcp
                    - name: jdwp
                      port: %d
                      protocol: tcp
                  capabilities:
                    - hitorro-fleet-%s
                  resources:
                    cpu: 2
                    memMB: 3072
                  health:
                    liveness:
                      httpGet:
                        path: /actuator/health
                        port: %d
                      intervalSec: 5
                      timeoutSec: 3
                    readiness:
                      httpGet:
                        path: %s
                        port: %d
                      intervalSec: 3
                      timeoutSec: 2
                # Debug: orion port-forward svc/hitorro-%s %d:%d — then attach IntelliJ Remote JVM Debug to localhost:%d
                """.formatted(
                m.name(), m.name(),
                m.name(), m.name(),
                argsBlock, envBlock, m.defaultPort(), m.debugPort(),
                m.name(), m.defaultPort(),
                m.healthPath(), m.defaultPort(),
                m.name(), m.debugPort(), m.debugPort(), m.debugPort());
    }

    /** Materialize a local-dev launch command for a fleet member (JDWP on). */
    public static String localLaunchCommand(FleetMember m) {
        Path jar = resolveJar(m);
        String jarPath = jar != null ? jar.toString() : "<jar-not-found: build " + m.name() + " first>";
        String env = m.defaultEnv().entrySet().stream()
                .map(e -> e.getKey() + "=" + quote(e.getValue()))
                .collect(Collectors.joining(" "));
        String args = String.join(" ", m.defaultArgs());
        return "%sjava %s -jar %s %s".formatted(
                env.isEmpty() ? "" : env + " ",
                jdwpArg(m),
                jarPath, args);
    }

    /** {@code jdb} attach command. */
    public static String jdbCommand(FleetMember m) {
        return "jdb -attach localhost:" + m.debugPort();
    }

    /** Minimal shell escape — good enough for the values we emit. */
    private static String quote(String s) {
        if (s == null) return "\"\"";
        if (s.matches("[a-zA-Z0-9._/=@:${}+-]+")) return "\"" + s + "\"";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /** All ports the panel should probe for auto-discovery. */
    public static Map<String, Integer> discoveryPorts() {
        Map<String, Integer> ports = new LinkedHashMap<>();
        for (FleetMember m : all()) ports.put(m.name(), m.defaultPort());
        return ports;
    }
}
