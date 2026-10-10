package com.example.portal.core;

import java.util.List;
import java.util.Set;

public interface PortalRepository extends AutoCloseable {
    interface Listener {
        void onChanged();
        void onError(String message);
    }

    /** Registers a listener and returns an idempotent unsubscribe action. */
    Runnable observe(Listener listener);
    List<Portal> portals();
    String selectedPortalId();
    String selectedDeviceId();
    List<Device> devices();
    PlaybackState playback();
    Set<String> favorites();
    void selectPortal(String id);
    void selectDevice(String id);
    void addDevice(String id, String name);
    void toggleFavorite(String channelId);
    /** Plays in the selected portal, pauses any known channel, or stops with an empty ID and false. */
    void sendCommand(String channelId, boolean playing);
    @Override void close();
}
