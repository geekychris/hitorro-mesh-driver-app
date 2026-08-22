/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.fasterxml.jackson.databind.JsonNode;
import com.hitorro.mesh.pipelines.model.SinkSpec;
import com.hitorro.mesh.pipelines.sinks.SinkRegistry;
import com.hitorro.util.core.iterator.sinks.Sink;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * Bridges the pipelines module with the runtime-table registration path.
 * Registers itself as a {@link SinkRegistry} decorator; when a pipeline
 * spec's {@code ndjson-file} sink carries
 * {@link SinkSpec.RegisterAsTable} options, this wraps the built sink
 * so its {@code close()} triggers a
 * {@code POST /mesh/queries/register-existing}-equivalent internal
 * call. Result: the file lands and becomes SQL-queryable in one
 * pipeline run — no separate register step.
 *
 * <p>Conditional on the pipelines module — {@link ObjectProvider} so
 * the driver-app boots fine even when {@code hitorro-mesh-pipelines}
 * is absent (the whole feature just doesn't activate).</p>
 */
@Component
public class PipelineAutoRegisterDecorator {

    private static final Logger log = LoggerFactory.getLogger(PipelineAutoRegisterDecorator.class);

    private final ObjectProvider<SinkRegistry> sinkRegistry;
    private final QueryWriteController writeController;

    public PipelineAutoRegisterDecorator(ObjectProvider<SinkRegistry> sinkRegistry,
                                         QueryWriteController writeController) {
        this.sinkRegistry = sinkRegistry;
        this.writeController = writeController;
    }

    @PostConstruct
    public void wire() {
        SinkRegistry reg = sinkRegistry.getIfAvailable();
        if (reg == null) {
            log.info("pipelines auto-register: SinkRegistry not present — feature disabled");
            return;
        }
        reg.registerDecorator(this::decorate);
        log.info("pipelines auto-register: wired — NDJSON sinks with registerAsTable will "
                + "POST /mesh/queries/register-existing on close");
    }

    /** Called by {@link SinkRegistry#create} for every sink; wraps only
     *  the NdjsonFile ones whose spec has {@code registerAsTable} set. */
    private Sink<JsonNode> decorate(SinkSpec spec, Sink<JsonNode> base) {
        if (!(spec instanceof SinkSpec.NdjsonFile ndjson)) return base;
        SinkSpec.RegisterAsTable opts = ndjson.registerAsTable();
        if (opts == null || opts.tableName() == null || opts.tableName().isBlank()) {
            return base;
        }
        return new AutoRegisterSink(base, ndjson.url(), opts, writeController);
    }

    /**
     * Sink wrapper — delegates every method to the inner sink; on
     * successful {@code close}, calls the driver's register-existing
     * endpoint (internal method call, no HTTP round-trip).
     *
     * <p>If the underlying sink throws on close, registration is
     * skipped and the exception propagates. If the sink closes fine
     * but registration itself throws, the registration failure is
     * logged but the caller (pipeline runner) still sees a
     * successful close — the file was written, only the SQL binding
     * failed, and the operator can retry manually.</p>
     */
    static final class AutoRegisterSink implements Sink<JsonNode> {
        private final Sink<JsonNode> delegate;
        private final String uri;
        private final SinkSpec.RegisterAsTable opts;
        private final QueryWriteController controller;

        AutoRegisterSink(Sink<JsonNode> delegate, String uri,
                         SinkSpec.RegisterAsTable opts, QueryWriteController controller) {
            this.delegate = delegate;
            this.uri = uri;
            this.opts = opts;
            this.controller = controller;
        }

        @Override public boolean init(JsonNode node) { return delegate.init(node); }
        @Override public boolean start() throws java.io.IOException { return delegate.start(); }
        @Override public boolean add(JsonNode row)
                throws java.io.IOException, com.hitorro.util.io.StoreException {
            return delegate.add(row);
        }
        @Override public boolean stop()  throws java.io.IOException { return delegate.stop(); }
        @Override public void close() throws java.io.IOException {
            delegate.close();
            // Register after close so the file is flushed + visible before
            // the URI-validity check runs on the register endpoint.
            try {
                var req = new QueryWriteController.RegisterExistingRequest();
                req.name = opts.tableName();
                // Register-existing requires a URI (BaseFileSystem needs a
                // scheme). NdjsonFileSink accepts bare paths and file://
                // URIs; the sink write path expands ~/ but the register
                // path doesn't. Normalise: bare absolute paths → file://,
                // ~/ → $HOME + file://, existing scheme unchanged.
                req.uri = normaliseUriForRegister(uri);
                req.format = "ndjson";
                req.typeJson = opts.typeJson();     // null → induced from file
                req.broadcast = opts.broadcastOrDefault();
                req.partitionKey = opts.partitionKey();
                controller.registerExisting(req);
                log.info("pipelines auto-register: registered {} → {}", opts.tableName(), uri);
            } catch (Exception e) {
                log.warn("pipelines auto-register: {} failed for {}: {}",
                        opts.tableName(), uri, e.toString());
            }
        }

        /** Package-visible for testing. Bare absolute → file://; ~/ →
         *  file://$HOME/...; anything else (URL scheme, relative path)
         *  passes through. */
        static String normaliseUriForRegister(String raw) {
            if (raw == null || raw.isBlank()) return raw;
            if (raw.startsWith("~/")) {
                return "file://" + System.getProperty("user.home") + raw.substring(1);
            }
            if (raw.startsWith("/")) return "file://" + raw;
            // Already has a scheme (file: / http: / hdfs: / s3:) or is
            // a relative path — hand off unchanged; register-existing's
            // own resolution handles those.
            return raw;
        }
    }
}
