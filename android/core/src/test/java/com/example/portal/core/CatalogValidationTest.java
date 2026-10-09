package com.example.portal.core;

import static org.junit.Assert.*;
import java.util.Arrays;
import org.junit.Test;

public class CatalogValidationTest {
    @Test public void validHttpsStreamsAreAccepted() {
        assertTrue(CatalogValidation.isHttpsStream("https://example.com/video.mp4?token=sample"));
        assertTrue(CatalogValidation.isHttpsStream("https://example.com:8443/audio.mp3"));
        assertTrue(CatalogValidation.isHttpsStream("HTTPS://example.com/audio.mp3"));
    }

    @Test public void malformedUnsafeOrNonHttpsStreamsAreRejected() {
        for (String url : Arrays.asList(null, "", "http://example.com/video.mp4",
                "https:///video.mp4", "https://name@example.com/video.mp4",
                "https://example.com:0/video.mp4", "https://example.com:65536/video.mp4",
                "https://exa mple.com/video.mp4", "https://example.com/%GG",
                "https://example.com\\@other.com/video.mp4", "https://")) {
            assertFalse(String.valueOf(url), CatalogValidation.isHttpsStream(url));
        }
    }

    @Test public void mockCatalogUsesValidHttpsStreamsAndGlobalUniqueIds() {
        MockPortalRepository repository = new MockPortalRepository();
        assertTrue(CatalogValidation.hasUniqueChannelIds(repository.portals()));
        for (Portal portal : repository.portals()) {
            for (Channel channel : portal.channels) {
                assertTrue(CatalogValidation.isHttpsStream(channel.streamUrl));
            }
        }
    }

    @Test public void duplicateIdsAcrossPortalsAreRejected() {
        assertFalse(CatalogValidation.hasUniqueChannelIds(Arrays.asList(
                portal("one", "channel"), portal("two", "channel"))));
    }

    @Test public void duplicateIdsWithinOnePortalAreRejected() {
        assertFalse(CatalogValidation.hasUniqueChannelIds(Arrays.asList(portal("one", "channel", "channel"))));
    }

    @Test public void emptyOrWhitespaceChannelIdsAreRejected() {
        assertFalse(CatalogValidation.hasUniqueChannelIds(Arrays.asList(portal("one", ""))));
        assertFalse(CatalogValidation.hasUniqueChannelIds(Arrays.asList(portal("one", " channel "))));
    }

    private Portal portal(String id, String... ids) {
        java.util.List<Channel> channels = new java.util.ArrayList<>();
        for (String channelId : ids) {
            channels.add(new Channel(channelId, "Sample", "Music", "https://example.com/audio.mp3", true));
        }
        return new Portal(id, id, channels);
    }
}
