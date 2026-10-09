package com.example.portal.core;

public final class PlaybackState {
    public final String channelId;
    public final boolean playing;

    public PlaybackState(String channelId, boolean playing) {
        this.channelId = channelId;
        this.playing = playing;
    }
}
