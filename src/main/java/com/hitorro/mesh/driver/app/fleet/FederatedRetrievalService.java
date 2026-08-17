/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.fleet;

import com.hitorro.index.search.SearchResult;
import com.hitorro.mesh.driver.fleet.FleetEndpointRegistry;
import com.hitorro.retrieval.cluster.NodeAddress;
import com.hitorro.retrieval.cluster.NodeRole;
import com.hitorro.retrieval.merger.FieldSortMerger;
import com.hitorro.retrieval.merger.RRFMerger;
import com.hitorro.retrieval.merger.ResultMerger;
import com.hitorro.retrieval.merger.ScoreMerger;
import com.hitorro.retrieval.merger.SortCriteria;
import com.hitorro.retrieval.search.CompositeSearchProvider;
import com.hitorro.retrieval.search.RemoteSearchProvider;
import com.hitorro.retrieval.search.SearchProvider;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Driver-side federated retrieval — fans a search out across every
 * discovered {@code hitorro-fleet-retrieval} instance in parallel and
 * merges the per-fleet result sets via a caller-selected
 * {@link ResultMerger}.
 *
 * <p>Endpoints come from a {@link FleetEndpointRegistry} that adapts to
 * whichever platform the driver runs on (Kubernetes label watch,
 * Orion cluster query, static config). Each endpoint becomes one
 * {@link RemoteSearchProvider}; a {@link CompositeSearchProvider}
 * runs them all with the same query.</p>
 *
 * <p>Merger selection follows the standard mesh convention:</p>
 * <ul>
 *   <li>{@code "score"} or null → {@link ScoreMerger} (Lucene relevance)</li>
 *   <li>{@code "rrf"} → {@link RRFMerger} (Reciprocal Rank Fusion — good
 *       when merging results from providers with incompatible scoring
 *       scales, e.g. lexical + vector)</li>
 *   <li>{@code "field:<name>"} → {@link FieldSortMerger} over the given
 *       field. Add {@code ":desc"} for descending.</li>
 * </ul>
 */
public class FederatedRetrievalService {

    private final FleetEndpointRegistry registry;

    public FederatedRetrievalService(FleetEndpointRegistry registry) {
        this.registry = registry;
    }

    /** Human-readable label for status endpoints. */
    public String discoveryPlatform() { return registry.platform(); }

    /** Current fleet endpoints. Useful for status / debugging. */
    public List<String> currentEndpoints() { return registry.endpoints(); }

    /**
     * Per-endpoint health detail when the registry supports it (i.e.
     * a {@link com.hitorro.mesh.driver.fleet.HealthyFleetEndpointRegistry}
     * is wrapping the discovery layers). Empty map when health-filtering
     * is disabled.
     */
    public java.util.Map<String, Object> healthReport() {
        if (registry instanceof com.hitorro.mesh.driver.fleet.HealthyFleetEndpointRegistry h) {
            return h.healthReport();
        }
        return java.util.Map.of();
    }

    /**
     * Run one search across every discovered fleet instance in parallel
     * and merge with the named strategy.
     */
    public SearchResult searchFederated(String indexName, String query, int offset, int limit,
                                        List<String> facetDims, String lang, String mergerName)
            throws Exception {
        List<String> endpoints = registry.endpoints();
        if (endpoints.isEmpty()) {
            throw new IllegalStateException("no fleet-retrieval endpoints discovered via "
                    + registry.platform() + " — set hitorro.fleet.endpoints in config, "
                    + "or check that Services labeled app=hitorro-fleet-retrieval are running");
        }
        List<SearchProvider> providers = new ArrayList<>(endpoints.size());
        for (String ep : endpoints) providers.add(remoteFor(ep));
        var composite = new CompositeSearchProvider(providers, selectMerger(mergerName));
        return composite.search(indexName, query, offset, limit, facetDims, lang);
    }

    /** Turn "http://host:port" into a RemoteSearchProvider hitting that fleet's REST. */
    private static RemoteSearchProvider remoteFor(String baseUrl) {
        URI u = URI.create(baseUrl);
        int port = u.getPort() > 0 ? u.getPort() : 8087;
        return new RemoteSearchProvider(
                new NodeAddress(u.getHost() + ":" + port,
                                u.getHost(), port,
                                Set.of(NodeRole.INDEX, NodeRole.KVSTORE)));
    }

    private static ResultMerger selectMerger(String name) {
        if (name == null) return new ScoreMerger();
        String n = name.trim().toLowerCase();
        if (n.equals("rrf"))       return new RRFMerger();
        if (n.equals("score"))     return new ScoreMerger();
        if (n.startsWith("field:")) {
            String rest = n.substring("field:".length());
            boolean asc = !rest.endsWith(":desc");
            String field = asc ? rest : rest.substring(0, rest.length() - ":desc".length());
            SortCriteria criteria = new SortCriteria(field,
                    asc ? SortCriteria.Direction.ASC : SortCriteria.Direction.DESC,
                    SortCriteria.SortType.FIELD);
            // FieldSortMerger accepts the criteria via its merge() overload
            // but SearchProvider.search only calls the 3-arg merge(). Wrap
            // so the criteria is baked in and applied on every call.
            FieldSortMerger inner = new FieldSortMerger();
            return new ResultMerger() {
                @Override
                public com.hitorro.index.search.SearchResult merge(List<com.hitorro.index.search.SearchResult> results, int offset, int limit) {
                    return inner.merge(results, offset, limit, criteria);
                }
                @Override
                public com.hitorro.index.search.SearchResult merge(List<com.hitorro.index.search.SearchResult> results, int offset, int limit, SortCriteria override) {
                    return inner.merge(results, offset, limit, override != null ? override : criteria);
                }
                @Override public String getName() { return "field:" + field + (asc ? "" : ":desc"); }
            };
        }
        throw new IllegalArgumentException("unknown merger: " + name
                + " — try 'score', 'rrf', or 'field:<name>[:desc]'");
    }
}
