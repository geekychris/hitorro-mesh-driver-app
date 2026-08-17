/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app.storage;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * REST surface for storage-layer inspection. See {@link StorageService}
 * for what's returned.
 *
 * <ul>
 *   <li>{@code GET /mesh/storage} — backend + dataset presence + sizes</li>
 * </ul>
 */
@RestController
@RequestMapping("/mesh/storage")
public class StorageController {

    private final StorageService storage;

    public StorageController(StorageService storage) {
        this.storage = storage;
    }

    @GetMapping
    public Map<String, Object> summary() {
        return storage.summary();
    }
}
