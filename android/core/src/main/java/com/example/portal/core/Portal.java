package com.example.portal.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class Portal {
    public final String id;
    public final String name;
    public final List<Channel> channels;

    public Portal(String id, String name, List<Channel> channels) {
        this.id = id;
        this.name = name;
        this.channels = Collections.unmodifiableList(new ArrayList<>(channels));
    }
}
