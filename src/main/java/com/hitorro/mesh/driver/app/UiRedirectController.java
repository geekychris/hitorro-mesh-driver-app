/*
 * Copyright (c) 2006-2025 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

/**
 * Phase 7o — redirect the driver's root URL to the bundled UI.
 *
 * <p>Spring Boot's default static-resource handling already serves the UI
 * assets from {@code src/main/resources/static/ui/} at {@code /ui/*}. This
 * controller adds a friendly {@code GET /} → {@code /ui/index.html}
 * redirect so operators who hit the driver in a browser without a path
 * land on the admin UI immediately.</p>
 *
 * <p>Any REST call to a specific mesh endpoint (e.g. {@code /mesh/queries},
 * {@code /actuator/health}) bypasses this — they hit their own controllers.
 * Only bare {@code GET /} triggers the redirect.</p>
 */
@Controller
public class UiRedirectController {

    @GetMapping("/")
    public String redirectToUi() {
        return "redirect:/ui/index.html";
    }
}
