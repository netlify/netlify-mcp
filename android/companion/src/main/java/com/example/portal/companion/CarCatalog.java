package com.example.portal.companion;

import com.example.portal.core.Channel;
import com.example.portal.core.Portal;
import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** The car catalog deliberately excludes video and limits browsing to one short list. */
public final class CarCatalog {
    public static final String ROOT = "car-audio";
    public static final int MAX_ITEMS = 12;
    private static final String PREFIX = "car:";

    private CarCatalog() {}

    public static List<Channel> audio(List<Portal> portals, String portalId) {
        List<Channel> result = new ArrayList<>();
        for (Portal portal : portals) {
            if (!portal.id.equals(portalId)) continue;
            for (Channel channel : portal.channels) {
                boolean duplicate = false;
                for (Channel item : result) {
                    if (item.id.equals(channel.id)) duplicate = true;
                }
                if (channel.audioOnly && secureStream(channel.streamUrl) && !duplicate) {
                    result.add(channel);
                    if (result.size() == MAX_ITEMS) break;
                }
            }
            break;
        }
        return Collections.unmodifiableList(result);
    }

    private static boolean secureStream(String url) {
        try {
            URI uri = URI.create(url);
            return "https".equalsIgnoreCase(uri.getScheme())
                    && uri.getHost() != null && uri.getUserInfo() == null;
        } catch (IllegalArgumentException exception) {
            return false;
        }
    }

    public static String mediaId(Channel channel) {
        return PREFIX + channel.id;
    }

    public static Channel resolve(List<Channel> channels, String mediaId) {
        for (Channel channel : channels) {
            if (mediaId(channel).equals(mediaId)) return channel;
        }
        return null;
    }

    public static List<Channel> page(List<Channel> channels, int page, int pageSize) {
        if (page < 0 || pageSize <= 0) return Collections.emptyList();
        long start = (long) page * pageSize;
        if (start >= channels.size()) return Collections.emptyList();
        int end = (int) Math.min(start + pageSize, channels.size());
        return channels.subList((int) start, end);
    }
}
