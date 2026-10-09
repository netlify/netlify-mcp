package com.example.portal.core;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class MockPortalRepository implements PortalRepository {
    private final List<Portal> catalog = Collections.unmodifiableList(Arrays.asList(
            new Portal("public", "Public samples", Arrays.asList(
                    new Channel("big-buck-bunny", "Big Buck Bunny", "Film",
                            "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4", false),
                    new Channel("soundhelix-one", "SoundHelix sample 1", "Music",
                            "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", true))),
            new Portal("discovery", "Discovery samples", Arrays.asList(
                    new Channel("elephants-dream", "Elephants Dream", "Film",
                            "https://storage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4", false),
                    new Channel("soundhelix-two", "SoundHelix sample 2", "Music",
                            "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3", true)))));
    private final List<Device> deviceList = new ArrayList<>(Arrays.asList(
            new Device("living-room", "Living room TV"), new Device("bedroom", "Bedroom TV")));
    private final Map<String, PlaybackState> states = new HashMap<>();
    private final Set<String> favoriteIds = new LinkedHashSet<>();
    private final Set<Listener> listeners = new LinkedHashSet<>();
    private String portalId = "public";
    private String deviceId = "living-room";
    private boolean closed;

    @Override public synchronized Runnable observe(Listener listener) {
        if (closed) return () -> {};
        listeners.add(listener);
        listener.onChanged();
        return () -> {
            synchronized (MockPortalRepository.this) { listeners.remove(listener); }
        };
    }
    @Override public synchronized List<Portal> portals() { return catalog; }
    @Override public synchronized String selectedPortalId() { return portalId; }
    @Override public synchronized String selectedDeviceId() { return deviceId; }
    @Override public synchronized List<Device> devices() {
        return Collections.unmodifiableList(new ArrayList<>(deviceList));
    }
    @Override public synchronized PlaybackState playback() {
        PlaybackState state = states.get(deviceId);
        return state == null ? new PlaybackState("", false) : state;
    }
    @Override public synchronized Set<String> favorites() {
        return Collections.unmodifiableSet(new LinkedHashSet<>(favoriteIds));
    }
    @Override public synchronized void selectPortal(String id) {
        if (closed) return;
        for (Portal portal : catalog) {
            if (portal.id.equals(id)) { portalId = id; changed(); return; }
        }
        error("Unknown portal");
    }
    @Override public synchronized void selectDevice(String id) {
        if (closed) return;
        for (Device device : deviceList) {
            if (device.id.equals(id)) { deviceId = id; changed(); return; }
        }
        error("Unknown device");
    }
    @Override public synchronized void addDevice(String id, String name) {
        if (closed) return;
        if (!validDevice(id, name)) { error("Invalid device ID or name"); return; }
        for (int index = 0; index < deviceList.size(); index++) {
            if (deviceList.get(index).id.equals(id)) { deviceList.remove(index); break; }
        }
        deviceList.add(new Device(id, name.trim()));
        changed();
    }
    @Override public synchronized void toggleFavorite(String channelId) {
        if (closed) return;
        if (!hasChannel(channelId, false)) { error("Unknown channel"); return; }
        if (!favoriteIds.remove(channelId)) favoriteIds.add(channelId);
        changed();
    }
    @Override public synchronized void sendCommand(String channelId, boolean playing) {
        if (closed) return;
        boolean stopping = "".equals(channelId) && !playing;
        if (!stopping && !hasChannel(channelId, playing)) {
            error(playing ? "Choose a channel in the selected portal" : "Unknown channel");
            return;
        }
        states.put(deviceId, new PlaybackState(channelId, playing));
        changed();
    }
    static boolean validDevice(String id, String name) {
        return id != null && id.matches("[A-Za-z0-9_-]{1,128}")
                && name != null && !name.trim().isEmpty() && name.trim().length() <= 128;
    }
    private boolean hasChannel(String id, boolean selectedOnly) {
        for (Portal portal : catalog) {
            if (selectedOnly && !portal.id.equals(portalId)) continue;
            for (Channel channel : portal.channels) if (channel.id.equals(id)) return true;
        }
        return false;
    }
    private void changed() {
        for (Listener listener : new ArrayList<>(listeners)) listener.onChanged();
    }
    private void error(String message) {
        for (Listener listener : new ArrayList<>(listeners)) listener.onError(message);
    }
    @Override public synchronized void close() { closed = true; listeners.clear(); }
}
