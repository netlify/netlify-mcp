package com.example.portal.core;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class CatalogValidation {
    private CatalogValidation() {}

    static boolean isHttpsStream(String url) {
        if (url == null) return false;
        try {
            URI uri = new URI(url);
            int port = uri.getPort();
            return "https".equalsIgnoreCase(uri.getScheme())
                    && uri.getHost() != null && !uri.getHost().isEmpty()
                    && uri.getRawUserInfo() == null
                    && (port == -1 || (port > 0 && port <= 65535));
        } catch (URISyntaxException exception) {
            return false;
        }
    }

    static boolean hasUniqueChannelIds(List<Portal> portals) {
        Set<String> ids = new HashSet<>();
        for (Portal portal : portals) {
            for (Channel channel : portal.channels) {
                String id = channel.id;
                if (id == null || id.isEmpty() || !id.equals(id.trim())
                        || id.length() > 128 || !ids.add(id)) return false;
            }
        }
        return true;
    }
}
