/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import com.fasterxml.jackson.databind.JsonNode;
import com.hitorro.mesh.pipelines.adapters.lucene.LuceneSearchService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

/**
 * REST search over pipeline-indexed Lucene indexes. Queries the same
 * physical directories the pipeline's {@link
 * com.hitorro.mesh.pipelines.adapters.lucene.LuceneIndexSink} wrote
 * into — no separate index registration.
 *
 * <p>End-to-end story: a pipeline node with
 * {@code sinks: [{kind: lucene, name: airports-idx, storeSource: true}]}
 * lands documents at {@code ~/.hitorro/pipelines/lucene/airports-idx/}.
 * A subsequent {@code GET /mesh/search/airports-idx?q=heathrow}
 * queries them via this controller.</p>
 */
@RestController
@RequestMapping("/mesh/search")
public class PipelineSearchController {

    private final LuceneSearchService searchService;

    public PipelineSearchController(@Value("${hitorro.pipelines.home:#{null}}") String pipelinesHome) {
        String home = pipelinesHome != null ? pipelinesHome
                : System.getProperty("hitorro.pipelines.home",
                        System.getProperty("user.home") + "/.hitorro/pipelines");
        this.searchService = new LuceneSearchService(Paths.get(home));
    }

    /** List every pipeline-indexed Lucene index on-disk. */
    @GetMapping
    public List<LuceneSearchService.IndexInfo> indexes() {
        return searchService.listIndexes();
    }

    /**
     * Query one index. {@code q} is Lucene query-syntax over the
     * synthetic {@code _text} catch-all (or exact fielded lookups like
     * {@code iata:LHR}). Missing / empty {@code q} → MatchAllDocs.
     */
    @GetMapping("/{index}")
    public LuceneSearchService.SearchResult search(
            @PathVariable("index") String index,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "limit", defaultValue = "20") int limit) throws Exception {
        return searchService.search(index, q, limit);
    }
}
