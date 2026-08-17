/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.fleet;

import com.hitorro.mesh.driver.fleet.CompositeFleetEndpointRegistry;
import com.hitorro.mesh.driver.fleet.FleetEndpointRegistry;
import com.hitorro.mesh.driver.fleet.HealthyFleetEndpointRegistry;
import com.hitorro.mesh.driver.fleet.StaticFleetEndpointRegistry;
import com.hitorro.mesh.orion.ClusterManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Wires the {@link FleetEndpointRegistry} + {@link FederatedRetrievalService}
 * beans that federate retrieval across N {@code hitorro-fleet-retrieval}
 * instances.
 *
 * <p>Discovery model:</p>
 * <ul>
 *   <li><b>Static config</b>: {@code hitorro.fleet.endpoints=http://X,http://Y}.
 *       Always active as a base layer — works on every platform.</li>
 *   <li><b>Platform discovery</b>: reflected in based on the active
 *       {@link ClusterManager}. Kubernetes ({@code fabric8}) or Orion
 *       ({@code declaredAgents} with the {@code fleet-retrieval}
 *       capability) — whichever is on the classpath and configured.</li>
 * </ul>
 *
 * <p>When both are available the result is a
 * {@link CompositeFleetEndpointRegistry} that unions the two lists
 * (auto-discovered first, static config for anything the platform
 * can't see — cross-cluster, external, dev machines).</p>
 *
 * <p>{@link FederatedRetrievalController} is only exposed when this
 * config produces a {@link FederatedRetrievalService} bean — i.e.
 * when at least one endpoint source is configured.</p>
 */
@Configuration(proxyBeanMethods = false)
public class FleetRegistryAutoConfig {

    private static final Logger log = LoggerFactory.getLogger(FleetRegistryAutoConfig.class);

    // destroyMethod = "(inferred)" — Spring auto-detects close() when the
    // returned instance has one (HealthyFleetEndpointRegistry does); no-ops
    // silently for Static/Composite which have no resources to release.
    @Bean(destroyMethod = "(inferred)")
    @ConditionalOnMissingBean(FleetEndpointRegistry.class)
    public FleetEndpointRegistry fleetEndpointRegistry(
            @Value("${hitorro.fleet.endpoints:}") String configured,
            @Value("${hitorro.fleet.health.enabled:true}") boolean healthEnabled,
            @Value("${hitorro.fleet.health.check-interval-seconds:10}") int checkIntervalSeconds,
            @Value("${hitorro.fleet.health.probe-timeout-seconds:2}") int probeTimeoutSeconds,
            @Value("${hitorro.fleet.health.failure-threshold:3}") int failureThreshold,
            ClusterManager clusterManager) {

        List<FleetEndpointRegistry> layers = new ArrayList<>();

        // Layer 1 — platform auto-discovery (K8s watches Services; Orion queries agents).
        FleetEndpointRegistry auto = tryAutoDiscovery(clusterManager);
        if (auto != null) layers.add(auto);

        // Layer 2 — static config fallback.
        if (configured != null && !configured.isBlank()) {
            List<String> urls = Arrays.stream(configured.split(","))
                    .map(String::trim).filter(s -> !s.isEmpty()).toList();
            layers.add(new StaticFleetEndpointRegistry(urls));
        }

        if (layers.isEmpty()) {
            log.info("fleet: no endpoints configured (set hitorro.fleet.endpoints=… or "
                    + "run under k8s/orion with fleet-retrieval labeled/tagged instances) "
                    + "— federated retrieval disabled");
            return new StaticFleetEndpointRegistry(List.of());
        }
        FleetEndpointRegistry base = layers.size() == 1
                ? layers.get(0)
                : new CompositeFleetEndpointRegistry(layers);

        // Layer 3 — /actuator/health filtering. Wraps whatever the discovery
        // layers produced. Off with hitorro.fleet.health.enabled=false when
        // you want raw discovery (e.g. debugging why an endpoint gets dropped).
        FleetEndpointRegistry registry = healthEnabled
                ? new HealthyFleetEndpointRegistry(base,
                        java.time.Duration.ofSeconds(checkIntervalSeconds),
                        java.time.Duration.ofSeconds(probeTimeoutSeconds),
                        failureThreshold)
                : base;

        log.info("fleet: registry platform={}, initial endpoints={}, health-filter={}",
                registry.platform(), registry.endpoints(), healthEnabled);
        return registry;
    }

    @Bean
    @ConditionalOnMissingBean(FederatedRetrievalService.class)
    public FederatedRetrievalService federatedRetrievalService(FleetEndpointRegistry registry) {
        return new FederatedRetrievalService(registry);
    }

    @Bean
    @ConditionalOnMissingBean(FederatedKvService.class)
    public FederatedKvService federatedKvService(FleetEndpointRegistry registry) {
        return new FederatedKvService(registry);
    }

    /**
     * Reflectively try to construct a platform-specific
     * {@link FleetEndpointRegistry} from the active
     * {@link ClusterManager}. Reflection is used so the mesh-driver-app
     * pom can keep the k8s + orion module deps optional — a deployment
     * that pulls in only one adapter still compiles and boots cleanly.
     */
    private static FleetEndpointRegistry tryAutoDiscovery(ClusterManager cm) {
        if (cm == null) return null;
        String platform = cm.platform();
        try {
            if ("kubernetes".equalsIgnoreCase(platform)) {
                Class<?> cls = Class.forName("com.hitorro.mesh.k8s.KubernetesFleetEndpointRegistry");
                Class<?> kubeCmCls = Class.forName("com.hitorro.mesh.k8s.KubernetesClusterManager");
                if (!kubeCmCls.isInstance(cm)) return null;
                Object client   = kubeCmCls.getMethod("getKubeClient").invoke(cm);
                String namespace = (String) kubeCmCls.getMethod("getNamespace").invoke(cm);
                Class<?> clientIface = Class.forName("io.fabric8.kubernetes.client.KubernetesClient");
                return (FleetEndpointRegistry) cls.getConstructor(clientIface, String.class)
                        .newInstance(client, namespace);
            }
            if ("orion".equalsIgnoreCase(platform)) {
                Class<?> cls = Class.forName("com.hitorro.mesh.orion.OrionFleetEndpointRegistry");
                Class<?> orionCmCls = Class.forName("com.hitorro.mesh.orion.OrionClusterManager");
                if (!orionCmCls.isInstance(cm)) return null;
                return (FleetEndpointRegistry) cls.getConstructor(orionCmCls).newInstance(cm);
            }
        } catch (ClassNotFoundException e) {
            log.debug("fleet: platform registry class not on classpath — skipping auto-discovery");
        } catch (Exception e) {
            log.warn("fleet: platform auto-discovery init failed ({}), falling back to static config",
                    e.getMessage());
        }
        return null;
    }
}
