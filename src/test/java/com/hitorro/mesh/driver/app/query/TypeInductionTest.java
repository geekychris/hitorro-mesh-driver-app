/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Tests the multi-row type induction on {@link QueryWriteController}.
 * Covers the specific bug the rough-edge fix targeted: a null in row 1
 * that gets rescued by later rows.
 */
class TypeInductionTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static List<JsonNode> rows(String... jsonLines) {
        return Stream.of(jsonLines).map(s -> {
            try { return JSON.readTree(s); }
            catch (Exception e) { throw new RuntimeException(e); }
        }).collect(Collectors.toList());
    }

    @Test
    void integralNumbers_inferAsCoreLong() {
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"population\":1000}",
                "{\"population\":2000}"));
        assertThat(typeJson).contains("\"population\"").contains("core_long");
    }

    @Test
    void fractionalNumbers_inferAsCoreDouble() {
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"ratio\":1.5}",
                "{\"ratio\":2.7}"));
        assertThat(typeJson).contains("core_double");
    }

    @Test
    void mixedIntegralAndFractional_inferAsCoreDouble() {
        // Once we see any decimal, "core_long" isn't safe — downgrade to
        // double so the parser accepts every row.
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"v\":1}",
                "{\"v\":1.5}"));
        assertThat(typeJson).contains("core_double");
    }

    @Test
    void booleans_inferAsCoreBoolean() {
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"active\":true}",
                "{\"active\":false}"));
        assertThat(typeJson).contains("core_boolean");
    }

    @Test
    void strings_inferAsCoreString() {
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"code\":\"USA\"}",
                "{\"code\":\"CHN\"}"));
        assertThat(typeJson).contains("core_string");
    }

    @Test
    void firstRowNullSecondRowNumeric_infersAsNumeric() {
        // THE core motivation for the rough-edge fix — old single-row
        // induction would have called this core_string.
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"population\":null}",
                "{\"population\":1000}",
                "{\"population\":2000}"));
        assertThat(typeJson).contains("core_long");
    }

    @Test
    void allNullsInWindow_defaultsToCoreString() {
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"unknown\":null}",
                "{\"unknown\":null}"));
        assertThat(typeJson).contains("core_string");
    }

    @Test
    void mixedNumericAndString_defaultsToCoreString() {
        // Row 1 sets an integer, row 2 has a string — safer to call it
        // string so nothing gets rejected. Better inference could pick
        // "text if any string", but core_string is the conservative pick.
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"v\":1}",
                "{\"v\":\"n/a\"}"));
        assertThat(typeJson).contains("core_string");
    }

    @Test
    void inductionRespectsColumnOrder_fromFirstRow() {
        String typeJson = QueryWriteController.induceTypeJson("t", rows(
                "{\"alpha3\":\"USA\",\"population\":331000000}",
                "{\"alpha3\":\"CHN\",\"population\":1412000000}"));
        // alpha3 must come first (it's first in row 1), population second.
        int posAlpha = typeJson.indexOf("alpha3");
        int posPop   = typeJson.indexOf("population");
        assertThat(posAlpha).isPositive().isLessThan(posPop);
    }

    @Test
    void inductionScanSize_isBoundedTo10() {
        // Even if there are 100 rows, only the first
        // TYPE_INDUCTION_SAMPLE_SIZE (10) are consulted. Row 20's
        // numeric value doesn't rescue a column that's null in rows 1-10.
        var jsonRows = new java.util.ArrayList<JsonNode>();
        for (int i = 0; i < 10; i++) jsonRows.add(rows("{\"v\":null}").get(0));
        for (int i = 0; i < 5; i++)  jsonRows.add(rows("{\"v\":42}").get(0));

        String typeJson = QueryWriteController.induceTypeJson("t", jsonRows);
        assertThat(typeJson).contains("core_string");   // rows 11-15 never scanned
    }
}
