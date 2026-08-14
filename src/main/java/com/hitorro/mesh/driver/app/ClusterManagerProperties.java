/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

/**
 * <pre>
 * hitorro:
 *   mesh:
 *     driver:
 *       cluster: orion            # or k8s | none
 *       orion-api-base: http://orion-controller:9080
 *       k8s-namespace: mesh
 *       k8s-dashboard-base: https://dashboard.example.com
 *       request-timeout: 3s
 *       cache-ttl: 5s
 * </pre>
 */
@ConfigurationProperties(prefix = "hitorro.mesh.driver")
public class ClusterManagerProperties {

    private String cluster = "none";
    private String orionApiBase;
    private String k8sNamespace = "default";
    private String k8sDashboardBase;
    private Duration requestTimeout = Duration.ofSeconds(3);
    private Duration cacheTtl = Duration.ofSeconds(5);

    public String getCluster() { return cluster; }
    public void setCluster(String cluster) { this.cluster = cluster; }

    public String getOrionApiBase() { return orionApiBase; }
    public void setOrionApiBase(String orionApiBase) { this.orionApiBase = orionApiBase; }

    public String getK8sNamespace() { return k8sNamespace; }
    public void setK8sNamespace(String k8sNamespace) { this.k8sNamespace = k8sNamespace; }

    public String getK8sDashboardBase() { return k8sDashboardBase; }
    public void setK8sDashboardBase(String k8sDashboardBase) { this.k8sDashboardBase = k8sDashboardBase; }

    public Duration getRequestTimeout() { return requestTimeout; }
    public void setRequestTimeout(Duration requestTimeout) { this.requestTimeout = requestTimeout; }

    public Duration getCacheTtl() { return cacheTtl; }
    public void setCacheTtl(Duration cacheTtl) { this.cacheTtl = cacheTtl; }
}
