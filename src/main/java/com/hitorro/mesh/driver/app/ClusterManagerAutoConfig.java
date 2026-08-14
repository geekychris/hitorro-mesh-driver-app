/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.hitorro.mesh.orion.ClusterManager;
import com.hitorro.mesh.orion.NoopClusterManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.net.URI;
import java.time.Duration;

/**
 * Wires a {@link ClusterManager} bean into the driver based on
 * {@code hitorro.mesh.driver.cluster}:
 *
 * <ul>
 *   <li>{@code orion} — {@code OrionClusterManager} against the configured API base</li>
 *   <li>{@code k8s} / {@code kubernetes} — {@code KubernetesClusterManager} against ambient kube config</li>
 *   <li>{@code none} (default) — {@code NoopClusterManager}; mesh works, just no
 *       declared-vs-live UI enrichment</li>
 * </ul>
 *
 * <p><b>Why not just {@code @ConditionalOnClass}?</b> Both bridge JARs may be
 * on the classpath in a bundled distribution (someone building a "universal"
 * fat jar). Property-based selection makes the choice explicit at deploy time
 * — one config change to switch platforms. {@code @ConditionalOnMissingBean}
 * lets a downstream module still override with a custom bean.</p>
 */
@Configuration(proxyBeanMethods = false)
public class ClusterManagerAutoConfig {

    private static final Logger log = LoggerFactory.getLogger(ClusterManagerAutoConfig.class);

    /** Orion bridge — needs the orion-controller HTTP API base URL. */
    @Bean
    @ConditionalOnMissingBean(ClusterManager.class)
    @ConditionalOnProperty(name = "hitorro.mesh.driver.cluster", havingValue = "orion")
    public ClusterManager orionClusterManager(ClusterManagerProperties props) {
        assertClassPresent("com.hitorro.mesh.orion.OrionClusterManager",
                "hitorro.mesh.driver.cluster=orion requires hitorro-mesh-orion on the classpath");
        String base = requireProp(props.getOrionApiBase(), "hitorro.mesh.driver.orion-api-base");
        log.info("mesh: ClusterManager = orion, api-base={}", base);
        return newOrionCm(URI.create(base), props.getRequestTimeout(), props.getCacheTtl());
    }

    /** Kubernetes bridge — needs a namespace and (optionally) a dashboard base for deep-links. */
    @Bean
    @ConditionalOnMissingBean(ClusterManager.class)
    @ConditionalOnProperty(name = "hitorro.mesh.driver.cluster", havingValue = "k8s")
    public ClusterManager kubernetesClusterManager(ClusterManagerProperties props) {
        assertClassPresent("com.hitorro.mesh.k8s.KubernetesClusterManager",
                "hitorro.mesh.driver.cluster=k8s requires hitorro-mesh-k8s on the classpath");
        String ns = requireProp(props.getK8sNamespace(), "hitorro.mesh.driver.k8s-namespace");
        URI dash = props.getK8sDashboardBase() != null && !props.getK8sDashboardBase().isBlank()
                ? URI.create(props.getK8sDashboardBase()) : null;
        log.info("mesh: ClusterManager = kubernetes, namespace={}, dashboard={}",
                ns, dash == null ? "(none)" : dash);
        return newK8sCm(ns, dash, props.getCacheTtl());
    }

    /**
     * Default bean when no cluster manager is selected. Registered with the
     * lowest precedence so any explicit bean (Orion / K8s / user-provided)
     * wins.
     */
    @Bean
    @ConditionalOnMissingBean(ClusterManager.class)
    public ClusterManager noopClusterManager() {
        log.info("mesh: ClusterManager = none (no declared-set enrichment; set hitorro.mesh.driver.cluster=orion|k8s to enable)");
        return new NoopClusterManager();
    }

    // -- reflection helpers so this class doesn't hard-depend on the bridge modules ---

    private static ClusterManager newOrionCm(URI base, Duration reqTimeout, Duration cacheTtl) {
        try {
            Class<?> cls = Class.forName("com.hitorro.mesh.orion.OrionClusterManager");
            return (ClusterManager) cls.getConstructor(URI.class, Duration.class, Duration.class)
                    .newInstance(base, reqTimeout, cacheTtl);
        } catch (Exception e) {
            throw new IllegalStateException("failed to construct OrionClusterManager", e);
        }
    }

    private static ClusterManager newK8sCm(String namespace, URI dashboardBase, Duration cacheTtl) {
        try {
            Class<?> cls = Class.forName("com.hitorro.mesh.k8s.KubernetesClusterManager");
            return (ClusterManager) cls.getMethod("fromAmbientConfig", String.class, URI.class, long.class)
                    .invoke(null, namespace, dashboardBase, cacheTtl.toMillis());
        } catch (Exception e) {
            throw new IllegalStateException("failed to construct KubernetesClusterManager", e);
        }
    }

    private static void assertClassPresent(String fqcn, String msg) {
        try { Class.forName(fqcn); }
        catch (ClassNotFoundException e) { throw new IllegalStateException(msg, e); }
    }

    private static String requireProp(String v, String propName) {
        if (v == null || v.isBlank()) {
            throw new IllegalStateException(propName + " is required");
        }
        return v;
    }
}
