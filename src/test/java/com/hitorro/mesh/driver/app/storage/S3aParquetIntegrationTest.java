/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app.storage;

import com.hitorro.util.basefile.fs.BaseFile;
import com.hitorro.util.basefile.fs.BaseFileSystem;
import com.hitorro.util.basefile.fs.s3.MinioProtocolAdapter;
import com.hitorro.util.core.iterator.sinks.parquet.ParquetFileSink;
import com.hitorro.util.json.JsonMappers;
import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.fs.FileSystem;
import org.apache.hadoop.fs.Path;
import org.apache.parquet.hadoop.ParquetFileReader;
import org.apache.parquet.hadoop.util.HadoopInputFile;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.Transferable;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The driver's S3 paths against SeaweedFS, with the AWS SDK modules the pom declares in place of
 * hadoop-aws's 654 MB {@code software.amazon.awssdk:bundle} (s3, s3-transfer-manager, sts): a Parquet
 * file read over S3A (as {@code StorageService}'s Parquet peek does) and an object read through
 * HiTorro's own s3:// file system (MinIO adapter). A missing SDK class fails here.
 */
@Testcontainers(disabledWithoutDocker = true)
class S3aParquetIntegrationTest {

    static final String BUCKET = "driver-s3a-test";
    static final String KEY = "test-access";
    static final String SECRET = "test-secret";

    @Container
    static final GenericContainer<?> S3 = new GenericContainer<>(DockerImageName.parse("chrislusf/seaweedfs:3.99"))
            .withCopyToContainer(Transferable.of(
                    "{\"identities\":[{\"name\":\"test\",\"credentials\":[{\"accessKey\":\"" + KEY + "\",\"secretKey\":\""
                            + SECRET + "\"}],\"actions\":[\"Admin\",\"Read\",\"List\",\"Tagging\",\"Write\"]}]}"),
                    "/etc/seaweedfs/s3.json")
            .withCommand("server", "-s3", "-s3.config=/etc/seaweedfs/s3.json", "-dir=/data", "-volume.max=8")
            .withExposedPorts(8333)
            .waitingFor(Wait.forListeningPorts(8333).withStartupTimeout(Duration.ofMinutes(2)));

    static String endpoint() {
        return "http://" + S3.getHost() + ":" + S3.getMappedPort(8333);
    }

    @BeforeAll
    static void upload(@TempDir java.nio.file.Path tmp) throws Exception {
        java.nio.file.Path local = tmp.resolve("rows.parquet");
        ParquetFileSink sink = new ParquetFileSink("file://" + local);
        sink.start();
        sink.add(JsonMappers.json().readTree("{\"name\":\"a\",\"n\":1,\"x\":1.5}"));
        sink.add(JsonMappers.json().readTree("{\"name\":\"b\",\"n\":2,\"x\":2.5}"));
        sink.close();
        try (S3Client s3 = S3Client.builder()
                .endpointOverride(URI.create(endpoint()))
                .region(Region.US_EAST_1)
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(KEY, SECRET)))
                .forcePathStyle(true)
                .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
                .build()) {
            long deadline = System.currentTimeMillis() + 60_000;
            while (true) {
                try {
                    s3.createBucket(CreateBucketRequest.builder().bucket(BUCKET).build());
                    s3.putObject(PutObjectRequest.builder().bucket(BUCKET).key("t/rows.parquet").build(),
                            RequestBody.fromBytes(Files.readAllBytes(local)));
                    s3.putObject(PutObjectRequest.builder().bucket(BUCKET).key("t/hello.txt").build(),
                            RequestBody.fromString("hello s3\n", StandardCharsets.UTF_8));
                    break;
                } catch (Exception e) {
                    if (System.currentTimeMillis() > deadline) throw new IllegalStateException("S3 store never became ready", e);
                    Thread.sleep(500);
                }
            }
        }
    }

    @AfterAll
    static void cleanUp() throws Exception {
        FileSystem.closeAll();
    }

    @Test
    void readsParquetOverS3a() throws Exception {
        Configuration conf = new Configuration();
        conf.set("fs.s3a.endpoint", endpoint());
        conf.set("fs.s3a.access.key", KEY);
        conf.set("fs.s3a.secret.key", SECRET);
        conf.set("fs.s3a.path.style.access", "true");
        conf.set("fs.s3a.connection.ssl.enabled", "false");
        conf.set("fs.s3a.endpoint.region", "us-east-1");
        try (ParquetFileReader reader = ParquetFileReader.open(
                HadoopInputFile.fromPath(new Path("s3a://" + BUCKET + "/t/rows.parquet"), conf))) {
            assertThat(reader.getRecordCount()).isEqualTo(2);
            assertThat(reader.getFooter().getFileMetaData().getSchema().toString()).contains("name").contains("x");
        }
    }

    @Test
    void readsAnObjectThroughHitorroS3FileSystem() throws Exception {
        System.setProperty("aws.accessKeyId", KEY);
        System.setProperty("aws.secretAccessKey", SECRET);
        System.setProperty("aws.region", "us-east-1");
        try {
            BaseFileSystem.addProtocolAdapter(new MinioProtocolAdapter(endpoint(), BUCKET, KEY, SECRET, false));
            BaseFile bf = BaseFileSystem.getBaseFileFromPath("s3://" + BUCKET + "/t/hello.txt");
            try (InputStream in = bf.getInputStream()) {
                assertThat(new String(in.readAllBytes(), StandardCharsets.UTF_8)).isEqualTo("hello s3\n");
            }
        } finally {
            System.clearProperty("aws.accessKeyId");
            System.clearProperty("aws.secretAccessKey");
            System.clearProperty("aws.region");
        }
    }
}
