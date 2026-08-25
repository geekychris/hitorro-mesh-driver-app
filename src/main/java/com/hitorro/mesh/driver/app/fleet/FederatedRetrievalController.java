/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.fleet;

import com.fasterxml.jackson.databind.JsonNode;
import com.hitorro.index.search.SearchResult;
import com.hitorro.jsontypesystem.JVS;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * REST surface for cross-fleet federated retrieval. Exposed only when a
 * {@link FederatedRetrievalService} bean is present (i.e. when at least
 * one {@code FleetEndpointRegistry} has been auto-configured — static
 * config, Kubernetes discovery, or Orion discovery).
 *
 * <p>Endpoints:</p>
 * <ul>
 *   <li>{@code GET /mesh/retrieval/federated/status} — discovered fleet URLs + platform</li>
 *   <li>{@code POST /mesh/retrieval/federated} — run a search across every fleet, merge</li>
 * </ul>
 */
@RestController
@RequestMapping("/mesh/retrieval/federated")
public class FederatedRetrievalController {

    private final FederatedRetrievalService federated;

    @Autowired
    public FederatedRetrievalController(FederatedRetrievalService federated) {
        this.federated = federated;
    }

    @GetMapping("/status")
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("platform", federated.discoveryPlatform());
        out.put("endpoints", federated.currentEndpoints());
        var health = federated.healthReport();
        if (!health.isEmpty()) out.put("health", health);
        return out;
    }

    /**
     * Body:
     * <pre>{@code
     * {
     *   "indexName": "articles",
     *   "query":     "London Heathrow",
     *   "offset":    0,
     *   "limit":     20,
     *   "lang":      "en",
     *   "facets":    ["country", "category"],
     *   "merger":    "rrf"          // score | rrf | field:name[:desc]
     * }
     * }</pre>
     */
    @PostMapping
    public ResponseEntity<Map<String, Object>> federatedSearch(@RequestBody JsonNode body) {
        Map<String, Object> out = new LinkedHashMap<>();
        long start = System.currentTimeMillis();
        try {
            String indexName = requireString(body, "indexName");
            String query     = requireString(body, "query");
            int offset       = body.path("offset").asInt(0);
            int limit        = body.path("limit").asInt(20);
            String lang      = body.path("lang").asText(null);
            List<String> facets = null;
            if (body.has("facets") && body.get("facets").isArray()) {
                var arr = body.get("facets");
                facets = new java.util.ArrayList<>(arr.size());
                for (JsonNode f : arr) facets.add(f.asText());
            }
            String merger = body.has("merger") && !body.get("merger").isNull()
                    ? body.get("merger").asText() : null;

            SearchResult sr = federated.searchFederated(indexName, query, offset, limit,
                    facets, lang, merger);
            out.put("documents", sr.getDocuments().stream().map(JVS::getJsonNode).toList());
            out.put("totalHits", sr.getTotalHits());
            out.put("searchTimeMs", sr.getSearchTimeMs());
            out.put("mergerUsed", merger != null ? merger : "score");
            out.put("fleetsQueried", federated.currentEndpoints().size());
            // Merged per-source aggregates from the streaming k-way
            // merger — carries summary/facets/ai_summary with
            // byIndex.<source> sub-objects. Empty when nothing was
            // merged (single-source or all-branches-failed).
            if (sr.hasSourceAggregates()) {
                out.put("aggregates", sr.getSourceAggregates().stream()
                        .map(JVS::getJsonNode).toList());
            }
            out.put("success", true);
        } catch (IllegalArgumentException | IllegalStateException e) {
            out.put("success", false);
            out.put("error", e.getMessage());
            out.put("totalTimeMs", System.currentTimeMillis() - start);
            return ResponseEntity.badRequest().body(out);
        } catch (Exception e) {
            out.put("success", false);
            out.put("error", e.getMessage());
        }
        out.put("totalTimeMs", System.currentTimeMillis() - start);
        return ResponseEntity.ok(out);
    }

    private static String requireString(JsonNode body, String field) {
        if (!body.hasNonNull(field) || body.get(field).asText().isBlank()) {
            throw new IllegalArgumentException(field + " is required");
        }
        return body.get(field).asText();
    }
}
