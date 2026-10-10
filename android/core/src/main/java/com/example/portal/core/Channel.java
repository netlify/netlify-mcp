package com.example.portal.core;

public final class Channel {
    public final String id;
    public final String title;
    public final String category;
    public final String streamUrl;
    public final boolean audioOnly;

    public Channel(String id, String title, String category, String streamUrl, boolean audioOnly) {
        this.id = id;
        this.title = title;
        this.category = category;
        this.streamUrl = streamUrl;
        this.audioOnly = audioOnly;
    }
}
