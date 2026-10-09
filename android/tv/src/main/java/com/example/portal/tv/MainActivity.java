package com.example.portal.tv;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.GridView;
import android.widget.LinearLayout;
import android.widget.Spinner;
import android.widget.TextView;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

import com.example.portal.core.AccountActivity;
import com.example.portal.core.Channel;
import com.example.portal.core.Device;
import com.example.portal.core.PlaybackState;
import com.example.portal.core.Portal;
import com.example.portal.core.PortalRepository;
import com.example.portal.core.RepoProvider;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;

/** Native, D-pad navigable TV browser and remote playback receiver. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public final class MainActivity extends Activity {
    private PortalRepository repository;
    private Runnable unsubscribe;
    private ExoPlayer player;
    private PlayerView playerView;
    private TextView status;
    private Spinner portals, devices, categories;
    private GridView grid;
    private Button favoriteButton;
    private EditText deviceId, deviceName;
    private final List<Channel> visibleChannels = new ArrayList<>();
    private final List<String> portalIds = new ArrayList<>();
    private final List<String> deviceIds = new ArrayList<>();
    private List<String> categoryNames = new ArrayList<>();
    private String category = "All categories";
    private String focusedChannelId = "";
    private String loadedChannelId = "";
    private String loadedStreamUrl = "";
    private String localDeviceId;
    private String pendingDeviceId = "";
    private String pendingDeviceName = "";
    private String playbackError = "";
    private String repositoryError = "";
    private boolean favoritesOnly;
    private boolean rendering;
    private boolean started;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        repository = RepoProvider.get(this);
        SharedPreferences preferences = getPreferences(MODE_PRIVATE);
        localDeviceId = preferences.getString("deviceId", UUID.randomUUID().toString());
        preferences.edit().putString("deviceId", localDeviceId).apply();
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(12), dp(24), dp(12));
        setContentView(root);

        LinearLayout selectors = row(root);
        portals = spinner(selectors, "Portal");
        devices = spinner(selectors, "Playback device");
        button(selectors, "Account", () -> startActivity(new Intent(this, AccountActivity.class)));
        status = new TextView(this);
        status.setTextSize(16);
        root.addView(status);
        playerView = new PlayerView(this);
        playerView.setUseController(false);
        playerView.setFocusable(false);
        root.addView(playerView, new LinearLayout.LayoutParams(-1, dp(185)));
        LinearLayout controls = row(root);
        button(controls, "Play", () -> command(repository.playback().channelId, true));
        button(controls, "Pause", () -> command(repository.playback().channelId, false));
        button(controls, "Stop", () -> command("", false));
        Button favorites = button(controls, "Favorites: off", () -> {});
        favorites.setOnClickListener(v -> {
            favoritesOnly = !favoritesOnly;
            favorites.setText(favoritesOnly ? "Favorites: on" : "Favorites: off");
            render();
        });
        favoriteButton = button(controls, "Favorite selected channel", () -> {
            if (!focusedChannelId.isEmpty()) repository.toggleFavorite(focusedChannelId);
        });
        categories = spinner(controls, "Category");

        LinearLayout registration = row(root);
        deviceId = new EditText(this);
        deviceId.setSingleLine(true);
        deviceId.setHint("TV device ID");
        deviceId.setText(localDeviceId);
        registration.addView(deviceId, new LinearLayout.LayoutParams(0, dp(48), 1));
        deviceName = new EditText(this);
        deviceName.setSingleLine(true);
        deviceName.setHint("TV name");
        deviceName.setText(preferences.getString("deviceName", "Living room TV"));
        registration.addView(deviceName, new LinearLayout.LayoutParams(0, dp(48), 1));
        button(registration, "Register TV", () -> {
            String id = deviceId.getText().toString().trim();
            String name = deviceName.getText().toString().trim();
            if (!id.matches("[A-Za-z0-9_-]{1,128}") || name.isEmpty() || name.length() > 128) {
                repositoryError = "Use a device ID with 1–128 letters, digits, hyphens or underscores, and a name up to 128 characters.";
                updateStatus();
                return;
            }
            pendingDeviceId = id;
            pendingDeviceName = name;
            repository.addDevice(id, name);
            render();
        });

        grid = new GridView(this);
        grid.setNumColumns(3);
        grid.setHorizontalSpacing(dp(8));
        grid.setVerticalSpacing(dp(8));
        grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        grid.setAdapter(channelAdapter);
        root.addView(grid, new LinearLayout.LayoutParams(-1, 0, 1));
        grid.setOnItemClickListener((parent, view, position, id) -> {
            focusedChannelId = visibleChannels.get(position).id;
            updateFavoriteButton();
            boolean registered = false;
            for (Device device : repository.devices()) {
                if (device.id.equals(localDeviceId)) registered = true;
            }
            if (!registered) {
                repositoryError = "Register this TV before choosing a channel.";
                updateStatus();
                return;
            }
            repository.selectDevice(localDeviceId);
            command(focusedChannelId, true);
        });
        grid.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position < visibleChannels.size()) {
                    focusedChannelId = visibleChannels.get(position).id;
                    updateFavoriteButton();
                }
            }
            @Override public void onNothingSelected(AdapterView<?> parent) {}
        });
        portals.setOnItemSelectedListener(selection(() -> {
            int index = portals.getSelectedItemPosition();
            if (index >= 0 && index < portalIds.size()
                    && !portalIds.get(index).equals(repository.selectedPortalId())) {
                repository.selectPortal(portalIds.get(index));
            }
        }));
        devices.setOnItemSelectedListener(selection(() -> {
            int index = devices.getSelectedItemPosition();
            if (index >= 0 && index < deviceIds.size()
                    && !deviceIds.get(index).equals(repository.selectedDeviceId())) {
                repository.selectDevice(deviceIds.get(index));
            }
        }));
        categories.setOnItemSelectedListener(selection(() -> {
            String value = (String) categories.getSelectedItem();
            if (value != null && !value.equals(category)) {
                category = value;
                render();
            }
        }));
    }

    @Override protected void onStart() {
        super.onStart();
        started = true;
        player = new ExoPlayer.Builder(this).build();
        playerView.setPlayer(player);
        player.addListener(new Player.Listener() {
            @Override public void onPlayerError(PlaybackException error) {
                playbackError = "Playback failed: " + error.getErrorCodeName();
                updateStatus();
            }
        });
        unsubscribe = repository.observe(new PortalRepository.Listener() {
            @Override public void onChanged() {
                runOnUiThread(() -> { if (started) { repositoryError = ""; render(); } });
            }
            @Override public void onError(String message) {
                runOnUiThread(() -> {
                    if (started) {
                        pendingDeviceId = "";
                        repositoryError = message;
                        updateStatus();
                    }
                });
            }
        });
        render();
    }

    @Override protected void onStop() {
        started = false;
        if (unsubscribe != null) { unsubscribe.run(); unsubscribe = null; }
        playerView.setPlayer(null);
        if (player != null) { player.release(); player = null; }
        loadedChannelId = "";
        loadedStreamUrl = "";
        super.onStop();
    }

    private void render() {
        if (!pendingDeviceId.isEmpty()) {
            for (Device device : repository.devices()) {
                if (device.id.equals(pendingDeviceId)) {
                    localDeviceId = pendingDeviceId;
                    pendingDeviceId = "";
                    getPreferences(MODE_PRIVATE).edit().putString("deviceId", localDeviceId)
                            .putString("deviceName", pendingDeviceName).apply();
                    repository.selectDevice(localDeviceId);
                    break;
                }
            }
        }
        rendering = true;
        List<String> names = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        Portal selected = null;
        for (Portal portal : repository.portals()) {
            ids.add(portal.id);
            names.add(portal.name);
            if (portal.id.equals(repository.selectedPortalId())) selected = portal;
        }
        setChoices(portals, portalIds, ids, names, repository.selectedPortalId());
        names = new ArrayList<>();
        ids = new ArrayList<>();
        for (Device device : repository.devices()) { ids.add(device.id); names.add(device.name); }
        setChoices(devices, deviceIds, ids, names, repository.selectedDeviceId());
        LinkedHashSet<String> available = new LinkedHashSet<>();
        available.add("All categories");
        if (selected != null) for (Channel channel : selected.channels) available.add(channel.category);
        List<String> nextCategories = new ArrayList<>(available);
        if (!available.contains(category)) category = "All categories";
        if (!nextCategories.equals(categoryNames)) {
            categoryNames = nextCategories;
            categories.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, categoryNames));
        }
        categories.setSelection(categoryNames.indexOf(category));
        visibleChannels.clear();
        if (selected != null) for (Channel channel : selected.channels) {
            if (("All categories".equals(category) || category.equals(channel.category))
                    && (!favoritesOnly || repository.favorites().contains(channel.id))) visibleChannels.add(channel);
        }
        channelAdapter.notifyDataSetChanged();
        boolean focusStillVisible = false;
        for (Channel channel : visibleChannels) {
            if (channel.id.equals(focusedChannelId)) focusStillVisible = true;
        }
        if (!focusStillVisible) {
            focusedChannelId = visibleChannels.isEmpty() ? "" : visibleChannels.get(0).id;
        }
        updateFavoriteButton();
        rendering = false;
        applyPlayback();
        updateStatus();
    }

    private void applyPlayback() {
        if (player == null) return;
        PlaybackState state = repository.playback();
        Channel requested = null;
        if (localDeviceId.equals(repository.selectedDeviceId())) {
            for (Portal portal : repository.portals()) for (Channel channel : portal.channels) {
                if (channel.id.equals(state.channelId)) requested = channel;
            }
        }
        if (requested == null) {
            player.stop();
            player.clearMediaItems();
            loadedChannelId = "";
            loadedStreamUrl = "";
            if (state.channelId.isEmpty()) playbackError = "";
            if (!state.channelId.isEmpty() && localDeviceId.equals(repository.selectedDeviceId())) {
                playbackError = "The requested channel is not available in this account.";
            }
            return;
        }
        if (!requested.id.equals(loadedChannelId) || !requested.streamUrl.equals(loadedStreamUrl)) {
            loadedChannelId = requested.id;
            loadedStreamUrl = requested.streamUrl;
            playbackError = "";
            player.setMediaItem(MediaItem.fromUri(requested.streamUrl));
            player.prepare();
        }
        if (state.playing && player.getPlaybackState() == Player.STATE_IDLE) {
            playbackError = "";
            player.prepare();
        }
        player.setPlayWhenReady(state.playing);
    }

    private void command(String channelId, boolean playing) {
        if (playing && channelId.isEmpty()) {
            repositoryError = "Choose a channel first.";
            updateStatus();
            return;
        }
        repository.sendCommand(channelId, playing);
    }

    private void updateStatus() {
        boolean configured = RepoProvider.isFirebaseConfigured(this);
        String mode = configured ? "Account sync configured" : "Demo mode — configure Firebase to sync devices";
        String target = localDeviceId.equals(repository.selectedDeviceId()) ? "This TV selected" : "Another device selected";
        String empty = visibleChannels.isEmpty() ? " · No matching channels" : "";
        PlaybackState state = repository.playback();
        String transport = state.channelId.isEmpty() ? "Stopped" : (state.playing ? "Playing" : "Paused");
        status.setText(mode + " · " + target + " · " + transport + empty
                + (configured && repository.portals().isEmpty()
                ? "\nSign in using Account. If signed in, check the shared catalog setup." : "")
                + (pendingDeviceId.isEmpty() ? "" : "\nRegistering TV…")
                + (repositoryError.isEmpty() ? "" : "\n" + repositoryError)
                + (playbackError.isEmpty() ? "" : "\n" + playbackError));
    }

    private void updateFavoriteButton() {
        favoriteButton.setEnabled(!focusedChannelId.isEmpty());
        favoriteButton.setText(repository.favorites().contains(focusedChannelId) ? "Remove favorite" : "Add favorite");
    }

    private void setChoices(Spinner spinner, List<String> oldIds, List<String> ids, List<String> names, String selected) {
        List<String> oldNames = new ArrayList<>();
        if (spinner.getAdapter() != null) for (int i = 0; i < spinner.getAdapter().getCount(); i++) {
            oldNames.add(String.valueOf(spinner.getAdapter().getItem(i)));
        }
        if (!oldIds.equals(ids) || !oldNames.equals(names)) {
            oldIds.clear(); oldIds.addAll(ids);
            spinner.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, names));
        }
        int position = ids.indexOf(selected);
        if (position >= 0 && spinner.getSelectedItemPosition() != position) spinner.setSelection(position);
    }

    private AdapterView.OnItemSelectedListener selection(Runnable action) {
        return new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (!rendering) action.run();
            }
            @Override public void onNothingSelected(AdapterView<?> parent) {}
        };
    }

    private final BaseAdapter channelAdapter = new BaseAdapter() {
        @Override public int getCount() { return visibleChannels.size(); }
        @Override public Object getItem(int position) { return visibleChannels.get(position); }
        @Override public long getItemId(int position) { return position; }
        @Override public View getView(int position, View recycled, ViewGroup parent) {
            TextView text = recycled instanceof TextView ? (TextView) recycled : new TextView(MainActivity.this);
            Channel channel = visibleChannels.get(position);
            text.setText((repository.favorites().contains(channel.id) ? "★ " : "") + channel.title + "\n" + channel.category);
            text.setTextSize(18);
            text.setPadding(dp(12), dp(10), dp(12), dp(10));
            text.setMinHeight(dp(66));
            text.setBackgroundResource(android.R.drawable.list_selector_background);
            return text;
        }
    };

    private LinearLayout row(LinearLayout root) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        root.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }
    private Spinner spinner(LinearLayout row, String description) {
        Spinner spinner = new Spinner(this);
        spinner.setContentDescription(description);
        row.addView(spinner, new LinearLayout.LayoutParams(0, dp(48), 1));
        return spinner;
    }
    private Button button(LinearLayout row, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setOnClickListener(v -> action.run());
        row.addView(button);
        return button;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
