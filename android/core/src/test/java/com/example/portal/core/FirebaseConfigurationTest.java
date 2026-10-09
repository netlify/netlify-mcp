package com.example.portal.core;

import static org.junit.Assert.*;
import org.junit.Test;

public class FirebaseConfigurationTest {
    @Test public void noConfigurationIsDemoMode() {
        assertFalse(FirebaseConfiguration.isConfigured("", "", ""));
        assertFalse(FirebaseConfiguration.isConfigured(null, " ", ""));
    }

    @Test public void completeConfigurationEnablesFirebase() {
        assertTrue(FirebaseConfiguration.isConfigured("project", "application", "key"));
    }

    @Test public void everyPartialConfigurationFailsExplicitly() {
        for (int mask = 1; mask < 7; mask++) {
            try {
                FirebaseConfiguration.isConfigured(
                        (mask & 1) != 0 ? "project" : "",
                        (mask & 2) != 0 ? "application" : "",
                        (mask & 4) != 0 ? "key" : "");
                fail("Partial configuration should fail: " + mask);
            } catch (IllegalStateException expected) {
                assertTrue(expected.getMessage().contains("all three resources"));
            }
        }
    }
}
