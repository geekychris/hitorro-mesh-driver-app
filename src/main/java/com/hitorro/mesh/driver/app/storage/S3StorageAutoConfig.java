/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.storage;

import com.hitorro.util.basefile.fs.BaseFileSystem;
import com.hitorro.util.basefile.fs.s3.MinioProtocolAdapter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Registers {@link MinioProtocolAdapter} with {@link BaseFileSystem} at
 * driver startup whenever {@code hitorro.storage.s3.endpoint} is set.
 * After registration every {@code s3://bucket/key} URI passed to
 * {@code BaseFileSystem.getBaseFileFromPath()} routes through the
 * configured MinIO / S3-compatible endpoint.
 *
 * <p>Zero-config when the endpoint property is absent — mesh falls back
 * to local filesystem access via the default file: adapter.</p>
 *
 * <p>Config (any of):</p>
 * <ul>
 *   <li>{@code hitorro.storage.s3.endpoint}   — e.g. {@code http://localhost:9000}</li>
 *   <li>{@code hitorro.storage.s3.bucket}     — default bucket for bucketless URIs</li>
 *   <li>{@code hitorro.storage.s3.access-key} — MinIO root user or S3 IAM key</li>
 *   <li>{@code hitorro.storage.s3.secret-key} — MinIO root password or S3 IAM secret</li>
 *   <li>{@code hitorro.storage.s3.ssl}        — default false for local MinIO</li>
 * </ul>
 *
 * <p>Environment-variable form: {@code HITORRO_STORAGE_S3_ENDPOINT} etc.
 * Spring Boot's relaxed binding handles the conversion.</p>
 */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty(prefix = "hitorro.storage.s3", name = "endpoint")
public class S3StorageAutoConfig {

    private static final Logger log = LoggerFactory.getLogger(S3StorageAutoConfig.class);

    @Bean
    public MinioProtocolAdapter s3ProtocolAdapter(
            @Value("${hitorro.storage.s3.endpoint}") String endpoint,
            @Value("${hitorro.storage.s3.bucket:hitorro}") String bucket,
            @Value("${hitorro.storage.s3.access-key:}") String accessKey,
            @Value("${hitorro.storage.s3.secret-key:}") String secretKey,
            @Value("${hitorro.storage.s3.ssl:false}") boolean sslEnabled) {

        MinioProtocolAdapter adapter = new MinioProtocolAdapter(
                endpoint, bucket, accessKey, secretKey, sslEnabled);
        BaseFileSystem.addProtocolAdapter(adapter);
        log.info("storage: s3:// routed to {} (bucket={}, ssl={})",
                endpoint, bucket, sslEnabled);
        return adapter;
    }
}
