package com.hitorro.mesh.driver.app;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.json.JsonCompareMode;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Starts the whole driver application offline (in-memory transport, no NATS,
 * no dataset auto-registration, no fleet probes, state under a temp dir) and
 * checks that Jackson 2 {@link JsonNode} values in responses are written as
 * plain JSON. Spring Boot 4 uses Jackson 3 for HTTP by default, which would
 * serialize a Jackson 2 JsonNode as a Java bean; application.yml selects the
 * Jackson 2 converter with spring.http.converters.preferred-json-mapper.
 */
@SpringBootTest(properties = {
        "hitorro.mesh.driver.transport=inmemory",
        "hitorro.mesh.datasets.auto-register=false",
        "hitorro.fleet.health.enabled=false",
        "hitorro.mesh.runtime.reconcile.enabled=false",
})
@AutoConfigureMockMvc
@Import(MeshDriverApplicationTest.JsonNodeProbeController.class)
class MeshDriverApplicationTest {

    private static final ObjectMapper MAPPER = com.hitorro.util.json.JsonMappers.json();

    @DynamicPropertySource
    static void stateDirs(DynamicPropertyRegistry registry) throws IOException {
        Path home = Files.createTempDirectory("mesh-driver-app-test");
        registry.add("hitorro.mesh.schedule.home", () -> home.resolve("schedules").toString());
        registry.add("hitorro.pipelines.home", () -> home.resolve("pipelines").toString());
    }

    /** Test-only endpoints that return Jackson 2 trees, as the real controllers do. */
    @RestController
    static class JsonNodeProbeController {
        static final String DOC =
                "{\"id\":\"a-1\",\"count\":3,\"ratio\":0.5,\"flag\":true,\"none\":null,"
                + "\"nested\":{\"list\":[1,\"two\",{\"three\":3}]}}";

        @GetMapping("/test/jackson2/node")
        JsonNode node() throws IOException {
            return MAPPER.readTree(DOC);
        }

        @GetMapping("/test/jackson2/query-response")
        MeshRestController.QueryResponse queryResponse() throws IOException {
            return new MeshRestController.QueryResponse("q-1", List.of("agent-1"), 1,
                    List.of(MAPPER.readTree(DOC)));
        }
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ApplicationContext context;

    @Test
    void contextLoads() {
        assertThat(context.getBean(MeshRestController.class)).isNotNull();
        assertThat(context.getBean(MeshHealthIndicator.class)).isNotNull();
    }

    @Test
    void jsonNodeIsWrittenAsPlainJson() throws Exception {
        mockMvc.perform(get("/test/jackson2/node"))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(content().json(JsonNodeProbeController.DOC, JsonCompareMode.STRICT))
                .andExpect(content().string(not(containsString("nodeType"))));
    }

    @Test
    void queryResponseRowsAreWrittenAsPlainJson() throws Exception {
        String expected = "{\"queryId\":\"q-1\",\"assignedAgents\":[\"agent-1\"],\"rowCount\":1,"
                + "\"rows\":[" + JsonNodeProbeController.DOC + "],"
                + "\"timedOut\":false,\"attempts\":1,\"rewrittenSql\":null}";
        mockMvc.perform(get("/test/jackson2/query-response"))
                .andExpect(status().isOk())
                .andExpect(content().json(expected, JsonCompareMode.STRICT))
                .andExpect(content().string(not(containsString("nodeType"))));
    }

    @Test
    void actuatorHealthResponds() throws Exception {
        mockMvc.perform(get("/actuator/health"))
                .andExpect(jsonPath("$.status").exists());
    }
}
