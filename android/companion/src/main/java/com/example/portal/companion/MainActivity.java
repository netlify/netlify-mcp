package com.example.portal.companion;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.Spinner;
import android.widget.TextView;

import com.example.portal.core.AccountActivity;
import com.example.portal.core.Channel;
import com.example.portal.core.Device;
import com.example.portal.core.PlaybackState;
import com.example.portal.core.Portal;
import com.example.portal.core.PortalRepository;
import com.example.portal.core.RepoProvider;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Phone/tablet remote: video always plays on the selected TV, never on this screen. */
public final class MainActivity extends Activity {
    private PortalRepository repository;
    private Runnable unsubscribe;
    private Spinner portals, devices;
    private EditText search;
    private TextView status;
    private final List<String> portalIds = new ArrayList<>();
    private final List<String> deviceIds = new ArrayList<>();
    private final List<Channel> channels = new ArrayList<>();
    private boolean favoritesOnly;
    private boolean rendering;
    private boolean started;
    private String error = "";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        repository = RepoProvider.get(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(16), dp(16), dp(8));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(16) + insets.getSystemWindowInsetLeft(),
                    dp(16) + insets.getSystemWindowInsetTop(),
                    dp(16) + insets.getSystemWindowInsetRight(),
                    dp(8) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root);
        LinearLayout heading = row(root);
        TextView title = new TextView(this);
        title.setText("Portal Remote");
        title.setTextSize(24);
        heading.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        button(heading, "Account", () -> startActivity(new Intent(this, AccountActivity.class)));
        status = new TextView(this);
        root.addView(status);
        label(root, "Portal");
        portals = new Spinner(this);
        portals.setContentDescription("Portal");
        root.addView(portals, new LinearLayout.LayoutParams(-1, dp(48)));
        label(root, "Playback device");
        devices = new Spinner(this);
        devices.setContentDescription("Playback device");
        root.addView(devices, new LinearLayout.LayoutParams(-1, dp(48)));

        LinearLayout controls = row(root);
        button(controls, "Play", () -> command(repository.playback().channelId, true));
        button(controls, "Pause", () -> command(repository.playback().channelId, false));
        button(controls, "Stop", () -> command("", false));
        search = new EditText(this);
        search.setSingleLine(true);
        search.setHint("Search channels or categories");
        search.setContentDescription("Search channels or categories");
        root.addView(search, new LinearLayout.LayoutParams(-1, dp(48)));
        Button favorites = new Button(this);
        favorites.setText("Show favorites");
        favorites.setOnClickListener(v -> {
            favoritesOnly = !favoritesOnly;
            favorites.setText(favoritesOnly ? "Show all channels" : "Show favorites");
            render();
        });
        root.addView(favorites);
        ListView list = new ListView(this);
        list.setAdapter(channelAdapter);
        root.addView(list, new LinearLayout.LayoutParams(-1, 0, 1));
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { render(); }
            @Override public void afterTextChanged(Editable s) {}
        });
        portals.setOnItemSelectedListener(selection(() -> {
            int position = portals.getSelectedItemPosition();
            if (position >= 0 && position < portalIds.size()
                    && !portalIds.get(position).equals(repository.selectedPortalId())) {
                repository.selectPortal(portalIds.get(position));
            }
        }));
        devices.setOnItemSelectedListener(selection(() -> {
            int position = devices.getSelectedItemPosition();
            if (position >= 0 && position < deviceIds.size()
                    && !deviceIds.get(position).equals(repository.selectedDeviceId())) {
                repository.selectDevice(deviceIds.get(position));
            }
        }));
    }

    @Override protected void onStart() {
        super.onStart();
        started = true;
        unsubscribe = repository.observe(new PortalRepository.Listener() {
            @Override public void onChanged() {
                runOnUiThread(() -> { if (started) { error = ""; render(); } });
            }
            @Override public void onError(String message) {
                runOnUiThread(() -> { if (started) { error = message; updateStatus(); } });
            }
        });
        render();
    }

    @Override protected void onStop() {
        started = false;
        if (unsubscribe != null) { unsubscribe.run(); unsubscribe = null; }
        super.onStop();
    }

    private void command(String channelId, boolean playing) {
        if (repository.selectedDeviceId().isEmpty()) {
            error = "Register a TV in the TV app, then select it here.";
            updateStatus();
            return;
        }
        if (playing && channelId.isEmpty()) {
            error = "Choose a channel first.";
            updateStatus();
            return;
        }
        repository.sendCommand(channelId, playing);
    }

    private void render() {
        rendering = true;
        List<String> ids = new ArrayList<>();
        List<String> names = new ArrayList<>();
        Portal selected = null;
        for (Portal portal : repository.portals()) {
            ids.add(portal.id); names.add(portal.name);
            if (portal.id.equals(repository.selectedPortalId())) selected = portal;
        }
        setChoices(portals, portalIds, ids, names, repository.selectedPortalId());
        ids = new ArrayList<>();
        names = new ArrayList<>();
        for (Device device : repository.devices()) { ids.add(device.id); names.add(device.name); }
        setChoices(devices, deviceIds, ids, names, repository.selectedDeviceId());
        String query = search.getText().toString().trim().toLowerCase(Locale.ROOT);
        channels.clear();
        if (selected != null) for (Channel channel : selected.channels) {
            if ((!favoritesOnly || repository.favorites().contains(channel.id))
                    && (channel.title.toLowerCase(Locale.ROOT).contains(query)
                    || channel.category.toLowerCase(Locale.ROOT).contains(query))) channels.add(channel);
        }
        channelAdapter.notifyDataSetChanged();
        rendering = false;
        updateStatus();
    }

    private void updateStatus() {
        PlaybackState playback = repository.playback();
        String title = "";
        for (Portal portal : repository.portals()) for (Channel channel : portal.channels) {
            if (channel.id.equals(playback.channelId)) title = channel.title;
        }
        boolean configured = RepoProvider.isFirebaseConfigured(this);
        String mode = configured ? "Account sync configured" : "Demo mode — configure Firebase for TV sync";
        String transport = playback.channelId.isEmpty() ? "Stopped" : (playback.playing ? "Playing: " : "Paused: ") + title;
        status.setText(mode + "\n" + transport + " · " + channels.size() + " channels"
                + (configured && repository.portals().isEmpty()
                ? "\nSign in using Account. If signed in, check the shared catalog setup." : "")
                + (deviceIds.isEmpty() ? "\nRegister a device in the TV app." : "")
                + (error.isEmpty() ? "" : "\n" + error));
    }

    private void setChoices(Spinner spinner, List<String> previousIds, List<String> ids, List<String> names, String selected) {
        List<String> previousNames = new ArrayList<>();
        if (spinner.getAdapter() != null) for (int i = 0; i < spinner.getAdapter().getCount(); i++) {
            previousNames.add(String.valueOf(spinner.getAdapter().getItem(i)));
        }
        if (!previousIds.equals(ids) || !previousNames.equals(names)) {
            previousIds.clear(); previousIds.addAll(ids);
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
        @Override public int getCount() { return channels.size(); }
        @Override public Object getItem(int position) { return channels.get(position); }
        @Override public long getItemId(int position) { return position; }
        @Override public View getView(int position, View recycled, ViewGroup parent) {
            Channel channel = channels.get(position);
            LinearLayout row = new LinearLayout(MainActivity.this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            Button play = new Button(MainActivity.this);
            play.setAllCaps(false);
            play.setText(channel.title + "\n" + channel.category + (channel.audioOnly ? " · Audio" : ""));
            play.setContentDescription("Play " + channel.title + " on selected device");
            play.setOnClickListener(v -> command(channel.id, true));
            row.addView(play, new LinearLayout.LayoutParams(0, -2, 1));
            Button favorite = new Button(MainActivity.this);
            boolean saved = repository.favorites().contains(channel.id);
            favorite.setText(saved ? "★" : "☆");
            favorite.setContentDescription((saved ? "Remove " : "Add ") + channel.title + " favorite");
            favorite.setOnClickListener(v -> repository.toggleFavorite(channel.id));
            row.addView(favorite, new LinearLayout.LayoutParams(dp(64), -1));
            return row;
        }
    };

    private LinearLayout row(LinearLayout root) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        root.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }
    private void button(LinearLayout row, String title, Runnable action) {
        Button button = new Button(this);
        button.setText(title);
        button.setOnClickListener(v -> action.run());
        row.addView(button, new LinearLayout.LayoutParams(0, dp(48), 1));
    }
    private void label(LinearLayout root, String title) {
        TextView text = new TextView(this);
        text.setText(title);
        root.addView(text);
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
