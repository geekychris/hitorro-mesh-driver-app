/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.query;

import com.hitorro.mesh.Codecs;
import com.hitorro.mesh.MeshTransport;
import com.hitorro.mesh.Subjects;
import com.hitorro.mesh.TableInventoryReply;
import com.hitorro.mesh.TableInventoryRequest;
import com.hitorro.mesh.driver.MeshDriver;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Driver-side helper that fans out a {@link TableInventoryRequest} and
 * collects {@link TableInventoryReply}s from every live agent within a
 * short deadline. Builds request/reply on top of {@link MeshTransport}'s
 * plain publish/subscribe (per the SPI design note).
 *
 * <p>Correlation: each probe generates a UUID {@code replyId}. The
 * driver subscribes on {@code mesh.agent.control.inventory-reply.<replyId>.>}
 * BEFORE publishing the request, then collects for {@code deadline} ms
 * before unsubscribing + returning whatever came back.</p>
 *
 * <p>Not exactly-once — an agent that boots mid-probe won't respond.
 * The UI communicates this by showing "N of M agents responded"
 * derived from the driver's live-agent set at probe time.</p>
 */
@Component
public class InventoryProbe {

    private static final Logger log = LoggerFactory.getLogger(InventoryProbe.class);

    private final MeshDriver driver;

    public InventoryProbe(MeshDriver driver) {
        this.driver = driver;
    }

    public record ProbeResult(int agentsAsked, List<TableInventoryReply> replies) { }

    /** Run a single probe with the given deadline. */
    public ProbeResult probe(Duration deadline) {
        MeshTransport transport = driver.transport();
        String replyId = UUID.randomUUID().toString().substring(0, 8);
        ConcurrentLinkedQueue<TableInventoryReply> replies = new ConcurrentLinkedQueue<>();

        MeshTransport.Subscription sub = transport.subscribe(
                Subjects.allAgentInventoryReplies(replyId), bytes -> {
                    try {
                        replies.add(Codecs.decode(bytes, TableInventoryReply.class));
                    } catch (Exception e) {
                        log.warn("mesh: inventory-reply decode failed: {}", e.toString());
                    }
                });

        int agentsAsked = driver.agents().agentsWith(List.of("jvssql")).size();

        try {
            transport.publish(Subjects.agentControlInventoryRequest(),
                    Codecs.encode(new TableInventoryRequest(replyId)));
            long deadlineNs = System.nanoTime() + deadline.toNanos();
            while (System.nanoTime() < deadlineNs && replies.size() < agentsAsked) {
                Thread.sleep(25);
            }
            // Give slow-agents a small tail after quorum too.
            Thread.sleep(50);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            sub.close();
        }
        return new ProbeResult(agentsAsked, new ArrayList<>(replies));
    }
}
