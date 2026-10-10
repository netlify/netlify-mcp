package com.example.portal.core;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.firebase.FirebaseApp;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.firestore.DocumentReference;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.ListenerRegistration;
import com.google.firebase.firestore.SetOptions;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Authenticated catalog and per-account settings; target device remains local to this client. */
public final class FirebaseRepository implements PortalRepository {
    private final FirebaseAuth auth;
    private final FirebaseFirestore store;
    private final SharedPreferences local;
    private final FirebaseAuth.AuthStateListener authListener;
    private final List<ListenerRegistration> registrations = new ArrayList<>();
    private final Set<Listener> listeners = new LinkedHashSet<>();
    private List<Portal> catalog = Collections.emptyList();
    private List<Device> deviceList = Collections.emptyList();
    private final Map<String, PlaybackState> states = new HashMap<>();
    private Set<String> favoriteIds = Collections.emptySet();
    private String portalId = "";
    private String requestedPortalId = "";
    private String deviceId = "";
    private String uid;
    private long generation;
    private boolean closed;

    public FirebaseRepository(Context context, FirebaseApp app) {
        auth = FirebaseAuth.getInstance(app);
        store = FirebaseFirestore.getInstance(app);
        local = context.getApplicationContext().getSharedPreferences("portal_device", Context.MODE_PRIVATE);
        authListener = ignored -> authChanged();
        auth.addAuthStateListener(authListener);
    }

    private synchronized void authChanged() {
        if (closed) return;
        FirebaseUser user = auth.getCurrentUser();
        String nextUid = user == null || user.isAnonymous() ? null : user.getUid();
        if (uid != null && uid.equals(nextUid)) return;
        detach();
        uid = nextUid;
        catalog = Collections.emptyList();
        deviceList = Collections.emptyList();
        states.clear();
        favoriteIds = Collections.emptySet();
        portalId = "";
        requestedPortalId = "";
        deviceId = uid == null ? "" : local.getString("device_" + uid, "");
        changed();
        if (uid == null) return;
        final long token = generation;
        registrations.add(store.collection("portals").addSnapshotListener((snapshot, exception) -> {
            synchronized (FirebaseRepository.this) {
                if (!active(token)) return;
                if (exception != null) { error(exception.getMessage()); return; }
                if (snapshot == null) return;
                List<Portal> result = new ArrayList<>();
                for (DocumentSnapshot doc : snapshot.getDocuments()) {
                    String name = doc.getString("name");
                    Object raw = doc.get("channels");
                    if (name == null || !(raw instanceof List<?>)) continue;
                    List<Channel> channels = new ArrayList<>();
                    for (Object entry : (List<?>) raw) {
                        if (!(entry instanceof Map<?, ?>)) continue;
                        Map<?, ?> item = (Map<?, ?>) entry;
                        Object id = item.get("id"), title = item.get("title"),
                                category = item.get("category"), url = item.get("streamUrl"),
                                audio = item.get("audioOnly");
                        if (id instanceof String && title instanceof String && category instanceof String
                                && url instanceof String && CatalogValidation.isHttpsStream((String) url)
                                && audio instanceof Boolean) {
                            channels.add(new Channel((String) id, (String) title, (String) category,
                                    (String) url, (Boolean) audio));
                        }
                    }
                    result.add(new Portal(doc.getId(), name, channels));
                }
                if (!CatalogValidation.hasUniqueChannelIds(result)) {
                    error("Channel IDs must be nonempty and unique across all portals");
                    return;
                }
                catalog = Collections.unmodifiableList(result);
                resolvePortal();
                changed();
            }
        }));
        registrations.add(preferences().addSnapshotListener((snapshot, exception) -> {
            synchronized (FirebaseRepository.this) {
                if (!active(token)) return;
                if (exception != null) { error(exception.getMessage()); return; }
                requestedPortalId = snapshot == null ? "" : string(snapshot.get("portalId"));
                Set<String> favorites = new LinkedHashSet<>();
                Object raw = snapshot == null ? null : snapshot.get("favorites");
                if (raw instanceof List<?>) {
                    for (Object value : (List<?>) raw) if (value instanceof String) favorites.add((String) value);
                }
                favoriteIds = Collections.unmodifiableSet(favorites);
                resolvePortal();
                changed();
            }
        }));
        registrations.add(store.collection("users").document(uid).collection("devices")
                .addSnapshotListener((snapshot, exception) -> {
                    synchronized (FirebaseRepository.this) {
                        if (!active(token)) return;
                        if (exception != null) { error(exception.getMessage()); return; }
                        if (snapshot == null) return;
                        List<Device> devices = new ArrayList<>();
                        states.clear();
                        for (DocumentSnapshot doc : snapshot.getDocuments()) {
                            String name = doc.getString("name");
                            if (name == null) continue;
                            devices.add(new Device(doc.getId(), name));
                            states.put(doc.getId(), new PlaybackState(string(doc.get("channelId")),
                                    Boolean.TRUE.equals(doc.getBoolean("playing"))));
                        }
                        deviceList = Collections.unmodifiableList(devices);
                        // Keep a locally chosen target across reconnects; only resolve missing targets
                        // against server-confirmed data, not an incomplete offline cache.
                        if (!snapshot.getMetadata().isFromCache() && !hasDevice(deviceId)) {
                            deviceId = devices.isEmpty() ? "" : devices.get(0).id;
                            saveDevice();
                        }
                        changed();
                    }
                }));
    }

    private boolean active(long token) {
        FirebaseUser user = auth.getCurrentUser();
        return !closed && token == generation && user != null && !user.isAnonymous()
                && user.getUid().equals(uid);
    }
    private static String string(Object value) { return value instanceof String ? (String) value : ""; }
    private DocumentReference preferences() {
        return store.collection("users").document(uid).collection("preferences").document("main");
    }
    private void resolvePortal() {
        portalId = "";
        for (Portal portal : catalog) {
            if (portal.id.equals(requestedPortalId)) { portalId = portal.id; return; }
        }
        if (!catalog.isEmpty()) portalId = catalog.get(0).id;
    }
    private boolean ready() {
        if (closed) return false;
        FirebaseUser user = auth.getCurrentUser();
        if (uid == null || user == null || user.isAnonymous() || !uid.equals(user.getUid())) {
            error("Sign in to access your account");
            return false;
        }
        return true;
    }
    @Override public synchronized Runnable observe(Listener listener) {
        if (closed) return () -> {};
        listeners.add(listener);
        listener.onChanged();
        return () -> {
            synchronized (FirebaseRepository.this) { listeners.remove(listener); }
        };
    }
    @Override public synchronized List<Portal> portals() { return catalog; }
    @Override public synchronized String selectedPortalId() { return portalId; }
    @Override public synchronized String selectedDeviceId() { return deviceId; }
    @Override public synchronized List<Device> devices() { return deviceList; }
    @Override public synchronized Set<String> favorites() { return favoriteIds; }
    @Override public synchronized PlaybackState playback() {
        PlaybackState state = states.get(deviceId);
        return state == null ? new PlaybackState("", false) : state;
    }
    @Override public synchronized void selectPortal(String id) {
        if (!ready()) return;
        for (Portal portal : catalog) {
            if (portal.id.equals(id)) { updatePreferences(id, null); return; }
        }
        error("Unknown portal");
    }
    @Override public synchronized void selectDevice(String id) {
        if (!ready()) return;
        if (!hasDevice(id)) { error("Unknown device"); return; }
        deviceId = id;
        saveDevice();
        changed();
    }
    private boolean hasDevice(String id) {
        for (Device device : deviceList) if (device.id.equals(id)) return true;
        return false;
    }
    private void saveDevice() { local.edit().putString("device_" + uid, deviceId).apply(); }
    @Override public synchronized void addDevice(String id, String name) {
        if (!ready()) return;
        if (!MockPortalRepository.validDevice(id, name)) { error("Invalid device ID or name"); return; }
        DocumentReference device = store.collection("users").document(uid).collection("devices").document(id);
        final long token = generation;
        store.runTransaction(transaction -> {
            DocumentSnapshot snapshot = transaction.get(device);
            Map<String, Object> values = new HashMap<>();
            values.put("name", name.trim());
            values.put("updatedAt", FieldValue.serverTimestamp());
            if (!snapshot.exists()) {
                values.put("channelId", "");
                values.put("playing", false);
            }
            transaction.set(device, values, SetOptions.merge());
            return null;
        }).addOnFailureListener(exception -> failed(token, exception));
    }
    @Override public synchronized void toggleFavorite(String channelId) {
        if (!ready()) return;
        if (!hasChannel(channelId, false)) { error("Unknown channel"); return; }
        updatePreferences(null, channelId);
    }
    private void updatePreferences(String selectedPortal, String toggleChannel) {
        DocumentReference ref = preferences();
        String fallbackPortal = portalId;
        final long token = generation;
        store.runTransaction(transaction -> {
            DocumentSnapshot snapshot = transaction.get(ref);
            List<String> favorites = new ArrayList<>();
            Object raw = snapshot.get("favorites");
            if (raw instanceof List<?>) {
                for (Object value : (List<?>) raw) if (value instanceof String) favorites.add((String) value);
            }
            if (toggleChannel != null && !favorites.remove(toggleChannel)) favorites.add(toggleChannel);
            Map<String, Object> values = new HashMap<>();
            String storedPortal = string(snapshot.get("portalId"));
            values.put("portalId", selectedPortal != null ? selectedPortal
                    : (storedPortal.isEmpty() ? fallbackPortal : storedPortal));
            values.put("favorites", favorites);
            transaction.set(ref, values);
            return null;
        }).addOnFailureListener(exception -> failed(token, exception));
    }
    @Override public synchronized void sendCommand(String channelId, boolean playing) {
        if (!ready()) return;
        if (!hasDevice(deviceId)) { error("Select or register a device first"); return; }
        boolean stopping = "".equals(channelId) && !playing;
        if (!stopping && !hasChannel(channelId, playing)) {
            error(playing ? "Choose a channel in the selected portal" : "Unknown channel");
            return;
        }
        final long token = generation;
        Map<String, Object> values = new HashMap<>();
        values.put("channelId", channelId);
        values.put("playing", playing);
        values.put("updatedAt", FieldValue.serverTimestamp());
        store.collection("users").document(uid).collection("devices").document(deviceId)
                .update(values).addOnFailureListener(exception -> failed(token, exception));
    }
    private boolean hasChannel(String id, boolean selectedOnly) {
        for (Portal portal : catalog) {
            if (selectedOnly && !portal.id.equals(portalId)) continue;
            for (Channel channel : portal.channels) if (channel.id.equals(id)) return true;
        }
        return false;
    }
    private synchronized void failed(long token, Exception exception) {
        if (active(token)) error(exception.getMessage());
    }
    private void changed() {
        for (Listener listener : new ArrayList<>(listeners)) listener.onChanged();
    }
    private void error(String message) {
        String detail = message == null ? "Account data could not be updated" : message;
        for (Listener listener : new ArrayList<>(listeners)) listener.onError(detail);
    }
    private void detach() {
        generation++;
        for (ListenerRegistration registration : registrations) registration.remove();
        registrations.clear();
    }
    @Override public synchronized void close() {
        if (closed) return;
        closed = true;
        detach();
        auth.removeAuthStateListener(authListener);
        listeners.clear();
        uid = null;
        catalog = Collections.emptyList();
        deviceList = Collections.emptyList();
        states.clear();
        favoriteIds = Collections.emptySet();
        portalId = "";
        deviceId = "";
    }
}
