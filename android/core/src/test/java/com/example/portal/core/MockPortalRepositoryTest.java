package com.example.portal.core;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.Before;
import org.junit.Test;

public class MockPortalRepositoryTest {
    private MockPortalRepository repository;
    private final List<String> errors = new ArrayList<>();
    private int changes;
    private final PortalRepository.Listener listener = new PortalRepository.Listener() {
        @Override public void onChanged() { changes++; }
        @Override public void onError(String message) { errors.add(message); }
    };

    @Before public void setUp() {
        repository = new MockPortalRepository();
        repository.observe(listener);
    }

    @Test public void mockCatalogIsReadyWithAudioAndVideo() {
        assertEquals(1, changes);
        assertEquals(2, repository.portals().size());
        assertEquals(2, repository.devices().size());
        assertEquals("public", repository.selectedPortalId());
        assertEquals("living-room", repository.selectedDeviceId());
        assertFalse(repository.playback().playing);
        for (Portal portal : repository.portals()) {
            assertTrue(portal.channels.get(0).streamUrl.startsWith("https://"));
            assertFalse(portal.channels.get(0).audioOnly);
            assertTrue(portal.channels.get(1).audioOnly);
        }
    }

    @Test public void favoritesToggleGloballyAndSnapshotsAreIndependent() {
        repository.toggleFavorite("soundhelix-one");
        Set<String> snapshot = repository.favorites();
        repository.selectPortal("discovery");
        repository.toggleFavorite("soundhelix-two");
        assertEquals(2, repository.favorites().size());
        assertEquals(1, snapshot.size());
        repository.toggleFavorite("soundhelix-one");
        assertFalse(repository.favorites().contains("soundhelix-one"));
        assertTrue(repository.favorites().contains("soundhelix-two"));
    }

    @Test public void commandsAreScopedToTargetDeviceAndSelectedPortal() {
        repository.sendCommand("soundhelix-one", true);
        repository.selectDevice("bedroom");
        assertFalse(repository.playback().playing);
        repository.sendCommand("big-buck-bunny", true);
        assertEquals("big-buck-bunny", repository.playback().channelId);
        repository.selectDevice("living-room");
        assertEquals("soundhelix-one", repository.playback().channelId);
        assertTrue(repository.playback().playing);
        repository.sendCommand("soundhelix-one", false);
        assertFalse(repository.playback().playing);
        repository.selectPortal("discovery");
        repository.sendCommand("big-buck-bunny", true);
        assertEquals(1, errors.size());
        assertFalse(repository.playback().playing);
        repository.sendCommand("elephants-dream", true);
        assertEquals("elephants-dream", repository.playback().channelId);
    }

    @Test public void invalidSelectionsAndChannelsDoNotMutateState() {
        repository.selectPortal(null);
        repository.selectDevice("unknown");
        repository.toggleFavorite("unknown");
        repository.sendCommand(null, true);
        assertEquals(4, errors.size());
        assertEquals(1, changes);
        assertEquals("public", repository.selectedPortalId());
        assertEquals("living-room", repository.selectedDeviceId());
        assertTrue(repository.favorites().isEmpty());
        assertEquals("", repository.playback().channelId);
    }

    @Test public void emptyPausedCommandStopsAcrossPortalChangesOnlyOnSelectedDevice() {
        repository.sendCommand("soundhelix-one", true);
        repository.selectDevice("bedroom");
        repository.sendCommand("big-buck-bunny", true);
        repository.selectPortal("discovery");
        repository.sendCommand("", false);
        assertEquals("", repository.playback().channelId);
        assertFalse(repository.playback().playing);
        assertTrue(errors.isEmpty());
        repository.sendCommand("", true);
        assertEquals(1, errors.size());
        assertFalse(repository.playback().playing);
        repository.selectDevice("living-room");
        assertEquals("soundhelix-one", repository.playback().channelId);
        assertTrue(repository.playback().playing);
    }

    @Test public void pauseAcceptsKnownChannelAfterSharedPortalChange() {
        repository.sendCommand("soundhelix-one", true);
        repository.selectPortal("discovery");
        repository.sendCommand("soundhelix-one", false);
        assertEquals("soundhelix-one", repository.playback().channelId);
        assertFalse(repository.playback().playing);
        assertTrue(errors.isEmpty());
        repository.sendCommand("unknown", false);
        assertEquals(1, errors.size());
        assertEquals("soundhelix-one", repository.playback().channelId);
    }

    @Test public void registerAndRenameDoesNotResetExistingPlayback() {
        repository.addDevice("my-tv", " My TV ");
        assertEquals(3, repository.devices().size());
        assertEquals("My TV", repository.devices().get(2).name);
        repository.selectDevice("my-tv");
        repository.sendCommand("soundhelix-one", true);
        repository.addDevice("my-tv", "Updated TV");
        assertEquals(3, repository.devices().size());
        assertTrue(repository.playback().playing);
        assertEquals("soundhelix-one", repository.playback().channelId);
        repository.addDevice("../bad", "TV");
        repository.addDevice("valid", " ");
        repository.addDevice(null, "TV");
        assertEquals(3, errors.size());
        assertEquals(3, repository.devices().size());
    }

    @Test public void closeStopsObservationAndMutation() {
        repository.close();
        repository.selectPortal("discovery");
        repository.selectDevice("bedroom");
        repository.toggleFavorite("soundhelix-one");
        repository.sendCommand("soundhelix-one", true);
        repository.addDevice("new", "New");
        repository.observe(listener);
        assertEquals(1, changes);
        assertTrue(errors.isEmpty());
        assertEquals("public", repository.selectedPortalId());
        assertEquals(2, repository.devices().size());
        assertTrue(repository.favorites().isEmpty());
        assertFalse(repository.playback().playing);
    }

    @Test public void unsubscribeStopsCallbacksAndIsIdempotent() {
        Runnable unsubscribe = repository.observe(listener);
        assertEquals(2, changes);
        unsubscribe.run();
        unsubscribe.run();
        repository.toggleFavorite("soundhelix-one");
        repository.selectPortal("missing");
        assertEquals(2, changes);
        assertTrue(errors.isEmpty());
    }

    @Test public void concurrentFavoriteTogglesRemainAtomic() throws Exception {
        ExecutorService workers = Executors.newFixedThreadPool(4);
        try {
            List<Future<?>> results = new ArrayList<>();
            for (int index = 0; index < 4; index++) {
                results.add(workers.submit(() -> {
                    for (int count = 0; count < 101; count++) {
                        repository.toggleFavorite("soundhelix-one");
                    }
                }));
            }
            for (Future<?> result : results) result.get();
            assertTrue(repository.favorites().isEmpty());
            assertEquals(405, changes);
        } finally {
            workers.shutdownNow();
        }
    }

    @Test public void portalDefensivelyCopiesItsChannels() {
        List<Channel> input = new ArrayList<>(Arrays.asList(
                new Channel("id", "Title", "Music", "https://example.com/audio", true)));
        Portal portal = new Portal("p", "Portal", input);
        input.clear();
        assertEquals(1, portal.channels.size());
    }

    @Test(expected = UnsupportedOperationException.class)
    public void catalogIsImmutable() { repository.portals().clear(); }

    @Test(expected = UnsupportedOperationException.class)
    public void channelsAreImmutable() { repository.portals().get(0).channels.clear(); }

    @Test(expected = UnsupportedOperationException.class)
    public void devicesAreImmutable() { repository.devices().clear(); }

    @Test(expected = UnsupportedOperationException.class)
    public void favoritesAreImmutable() { repository.favorites().add("bad"); }
}
