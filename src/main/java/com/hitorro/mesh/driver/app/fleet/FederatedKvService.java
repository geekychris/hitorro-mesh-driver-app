/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.fleet;

import com.hitorro.kvstore.KVStore;
import com.hitorro.kvstore.Result;
import com.hitorro.kvstore.remote.CompositeKvStore;
import com.hitorro.kvstore.remote.RemoteKvStore;
import com.hitorro.mesh.driver.fleet.FleetEndpointRegistry;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Driver-side federated KV fetch — mirrors {@link FederatedRetrievalService}
 * but for {@code /api/retrieval/documents/{indexName}/{key}} lookups
 * (and, when the fleet exposes it, prefix scans via
 * {@code /api/retrieval/kv/{indexName}/scan?prefix=…}).
 *
 * <p>Constructs one {@link RemoteKvStore} per (endpoint, indexName)
 * pair on demand, caches them, and wraps the set in
 * {@link CompositeKvStore} for parallel first-match fan-out. Endpoint
 * discovery follows the same {@link FleetEndpointRegistry} as search
 * (health-filtered, platform-aware).</p>
 *
 * <p>Read-only. Writes flow via the pipeline runtime, not the driver.</p>
 */
public class FederatedKvService {

    private final FleetEndpointRegistry registry;
    /** Per-(endpoint,index) client cache — RemoteKvStore is cheap but the cache saves reconstructing per request. */
    private final Map<String, RemoteKvStore> cache = new ConcurrentHashMap<>();

    public FederatedKvService(FleetEndpointRegistry registry) {
        this.registry = registry;
    }

    public String discoveryPlatform() { return registry.platform(); }
    public List<String> currentEndpoints() { return registry.endpoints(); }

    /**
     * Federated fetch: broadcast key lookup to every discovered fleet,
     * return the first non-null hit. Returns {@code null} when nothing
     * had the key.
     */
    public byte[] get(String indexName, String key) {
        KVStore composite = compositeFor(indexName);
        Result<byte[]> r = composite.get(key.getBytes(StandardCharsets.UTF_8));
        return r.isSuccess() && r.getValue().isPresent() ? r.getValue().get() : null;
    }

    /** Prefix scan across every fleet that supports it. Values only. */
    public java.util.Iterator<byte[]> scanValues(String indexName, String prefix) {
        return compositeFor(indexName).scanByPrefix(prefix.getBytes(StandardCharsets.UTF_8));
    }

    /** Prefix scan across every fleet that supports it. Key + value entries. */
    public java.util.Iterator<Map.Entry<byte[], byte[]>> scanEntries(String indexName, String prefix) {
        return compositeFor(indexName).scanByPrefixWithKeys(prefix.getBytes(StandardCharsets.UTF_8));
    }

    /** Build (or reuse) a CompositeKvStore over every current endpoint's RemoteKvStore for this index. */
    private CompositeKvStore compositeFor(String indexName) {
        List<String> endpoints = registry.endpoints();
        List<KVStore> stores = new ArrayList<>(endpoints.size());
        for (String ep : endpoints) {
            String cacheKey = ep + "|" + indexName;
            stores.add(cache.computeIfAbsent(cacheKey, k -> new RemoteKvStore(ep, indexName)));
        }
        if (stores.isEmpty()) {
            throw new IllegalStateException("no fleet-retrieval endpoints discovered via "
                    + registry.platform() + " — cannot federate KV fetch for index=" + indexName);
        }
        return new CompositeKvStore(stores);
    }
}
