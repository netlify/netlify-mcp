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
    /** An empty channel ID with playing=false stops the selected device. */
    void sendCommand(String channelId, boolean playing);
    @Override void close();
}
