/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.hitorro.mesh.datasets.model.Manifest;
import com.hitorro.mesh.datasets.registry.DatasetRegistry;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * Catalog view over the shipped {@link DatasetRegistry}: every manifest
 * the datasets module knows about, cross-referenced with what's
 * actually installed on this box. Powers the Cluster tab's grouped
 * "installed vs catalog-only" dataset list without the UI having to
 * introspect the filesystem itself.
 */
@RestController
@RequestMapping("/mesh/catalog")
public class DatasetCatalogController {

    private final DatasetRegistry registry;

    public DatasetCatalogController(DatasetRegistry registry) {
        this.registry = registry;
    }

    /**
     * All known manifests grouped by category, each annotated with
     * whether the dataset is installed on this box.
     */
    @GetMapping
    public ResponseEntity<Map<String, Object>> catalog() {
        Set<String> installedIds = Set.copyOf(registry.scanInstalled());
        // Group into a stable ordering that matches the UX intent —
        // geographic first (most datasets tend to hang off place), then
        // codification, scholarly, reference, time-series, other.
        String[] order = {"geographic", "codification", "scholarly",
                          "reference", "time-series", "other"};
        Map<String, List<Map<String, Object>>> grouped = new LinkedHashMap<>();
        for (String c : order) grouped.put(c, new ArrayList<>());

        List<Manifest> all = new ArrayList<>(registry.all());
        all.sort((a, b) -> a.id().compareTo(b.id()));
        for (Manifest m : all) {
            String cat = categoryFor(m);
            grouped.computeIfAbsent(cat, k -> new ArrayList<>()).add(entry(m, installedIds));
        }
        // Prune empties for terseness.
        grouped.entrySet().removeIf(e -> e.getValue().isEmpty());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("groups", grouped);
        out.put("counts", counts(grouped, installedIds));
        return ResponseEntity.ok(out);
    }

    /** Detail for one dataset — same shape as a catalog entry plus the full manifest. */
    @GetMapping("/{id}")
    public ResponseEntity<Map<String, Object>> detail(@PathVariable("id") String id) {
        Manifest m = registry.get(id);
        if (m == null) return ResponseEntity.notFound().build();
        Set<String> installedIds = Set.copyOf(registry.scanInstalled());
        Map<String, Object> row = entry(m, installedIds);
        row.put("manifest", m);
        return ResponseEntity.ok(row);
    }

    private static Map<String, Object> entry(Manifest m, Set<String> installedIds) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", m.id());
        row.put("title", m.title());
        row.put("category", categoryFor(m));
        row.put("description", m.description());
        row.put("tableName", tableName(m));
        row.put("installed", installedIds.contains(m.id()));
        row.put("partitionBy", m.partitionBy());
        row.put("broadcast", m.partitionBy() == null);
        row.put("installScript", "install-" + m.id() + ".sh");
        if (m.identifiers() != null) row.put("identifiers", m.identifiers());
        if (m.record() != null && m.record().fields() != null) {
            row.put("fieldCount", m.record().fields().size());
        }
        return row;
    }

    private static String normalizeCategory(String c) {
        if (c == null || c.isBlank()) return "other";
        return c.toLowerCase();
    }

    /**
     * Resolve category from manifest, falling back to id-prefix rules when
     * the manifest doesn't carry one (belt-and-suspenders — many manifests
     * still lack the `category:` field, and adding it everywhere was in
     * progress). Keep rules aligned with the yaml `category:` values so
     * the UI grouping is stable regardless of source.
     */
    public static String categoryFor(Manifest m) {
        String c = m.category();
        if (c != null && !c.isBlank()) return c.toLowerCase();
        String id = m.id() == null ? "" : m.id();
        if (id.startsWith("geonames-")
                || id.startsWith("osm-")
                || id.startsWith("natural-earth-")
                || id.startsWith("wikidata-cit")
                || id.startsWith("wikidata-count")
                || id.startsWith("un-locode")
                || id.startsWith("noaa-")) return "geographic";
        if (id.startsWith("iso-")
                || id.startsWith("fips-")
                || id.startsWith("naics-")
                || id.startsWith("soc-")
                || id.startsWith("hts-")
                || id.startsWith("un-m49-")
                || id.startsWith("us-states")) return "codification";
        if (id.startsWith("openalex-")
                || id.startsWith("arxiv")
                || id.startsWith("pubmed-")
                || id.startsWith("wikipedia-")) return "scholarly";
        if (id.startsWith("worldbank-")
                || id.startsWith("owid-")
                || id.startsWith("usgs-")) return "time-series";
        if (id.startsWith("nasa-")
                || id.startsWith("coingecko-")
                || id.startsWith("retro-")
                || id.startsWith("npm-")
                || id.startsWith("pypi-")
                || id.startsWith("github-")
                || id.startsWith("huggingface-")
                || id.startsWith("stackexchange")
                || id.startsWith("reg-test-")) return "reference";
        return "other";
    }

    /** id → snake_case table name (matches the pattern install scripts use). */
    private static String tableName(Manifest m) {
        return m.id().replace('-', '_');
    }

    private static Map<String, Object> counts(Map<String, List<Map<String, Object>>> grouped,
                                              Set<String> installedIds) {
        Map<String, Object> c = new TreeMap<>();
        int total = 0, installed = 0;
        for (var e : grouped.entrySet()) {
            int i = 0;
            for (var row : e.getValue()) if (Boolean.TRUE.equals(row.get("installed"))) i++;
            c.put(e.getKey(), Map.of("total", e.getValue().size(), "installed", i));
            total += e.getValue().size();
            installed += i;
        }
        c.put("_total", Map.of("total", total, "installed", installed));
        return c;
    }
}
