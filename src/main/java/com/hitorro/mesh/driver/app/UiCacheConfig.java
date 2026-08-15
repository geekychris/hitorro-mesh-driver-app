/*
 * Copyright (c) 2006-2026 Chris Collins
 */
package com.hitorro.mesh.driver.app;

import org.springframework.context.annotation.Configuration;
import org.springframework.http.CacheControl;
import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.util.concurrent.TimeUnit;

/**
 * Serves everything under {@code /ui/} with {@code Cache-Control:
 * no-cache}. The dev-loop pain here is that Spring Boot's default is
 * to serve static resources with strong caching, so an updated
 * {@code app.js} or {@code style.css} looks like it landed on the
 * server (curl shows the new bytes) but users' browsers keep the old
 * copy and features silently do nothing.
 *
 * <p>Overrides only the {@code /ui/**} path — Actuator, Prometheus,
 * REST endpoints keep their own cache defaults.</p>
 */
@Configuration
public class UiCacheConfig implements WebMvcConfigurer {

    @Override
    public void addResourceHandlers(ResourceHandlerRegistry registry) {
        registry.addResourceHandler("/ui/**")
                .addResourceLocations("classpath:/static/ui/")
                .setCacheControl(CacheControl.noCache().mustRevalidate());
    }
}
