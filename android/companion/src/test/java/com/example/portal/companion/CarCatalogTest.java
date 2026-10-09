package com.example.portal.companion;

import com.example.portal.core.Channel;
import com.example.portal.core.Portal;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public final class CarCatalogTest {
    @Test
    public void excludesVideoInsecureStreamsAndOtherPortals() {
        Channel audio = new Channel("a", "Radio", "Audio", "https://example.org/audio.mp3", true);
        List<Channel> result = CarCatalog.audio(List.of(
                new Portal("selected", "Selected", List.of(audio,
                        new Channel("v", "Video", "TV", "https://example.org/tv.mp4", false),
                        new Channel("http", "HTTP", "Audio", "http://example.org/a.mp3", true),
                        new Channel("bad", "Bad", "Audio", "https://user@example.org/a.mp3", true))),
                new Portal("other", "Other", List.of(audio))), "selected");
        assertEquals(List.of(audio), result);
        assertTrue(CarCatalog.audio(List.of(), "missing").isEmpty());
        assertNull(CarCatalog.resolve(result, "v"));
        assertNull(CarCatalog.resolve(result, "https://example.org/evil"));
        assertSame(audio, CarCatalog.resolve(result, "car:a"));
    }

    @Test
    public void boundsCatalogAndHandlesPaginationWithoutOverflow() {
        List<Channel> input = new ArrayList<>();
        for (int i = 0; i < 30; i++) {
            input.add(new Channel("a" + i, "Audio " + i, "Audio", "https://example.org/a.mp3", true));
        }
        List<Channel> catalog = CarCatalog.audio(List.of(new Portal("p", "Portal", input)), "p");
        assertEquals(12, catalog.size());
        assertEquals(2, CarCatalog.page(catalog, 1, 10).size());
        assertTrue(CarCatalog.page(catalog, -1, 10).isEmpty());
        assertTrue(CarCatalog.page(catalog, 0, 0).isEmpty());
        assertTrue(CarCatalog.page(catalog, Integer.MAX_VALUE, Integer.MAX_VALUE).isEmpty());
    }
}
