package com.example.portal.companion;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.LibraryResult;
import androidx.media3.session.MediaLibraryService;
import androidx.media3.session.MediaSession;
import com.example.portal.core.Channel;
import com.example.portal.core.PortalRepository;
import com.example.portal.core.RepoProvider;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.ArrayList;
import java.util.List;

/** Audio-only local playback; car controls never send commands to a TV device. */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public final class CarMediaService extends MediaLibraryService {
    private ExoPlayer player;
    private MediaLibrarySession session;
    private PortalRepository repository;
    private Runnable unsubscribe;
    private android.os.Handler handler;

    @Override
    public void onCreate() {
        super.onCreate();
        repository = RepoProvider.get(this);
        player = new ExoPlayer.Builder(this).build();
        handler = new android.os.Handler(player.getApplicationLooper());
        player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true);
        player.setHandleAudioBecomingNoisy(true);
        session = new MediaLibrarySession.Builder(this, player, new BrowseCallback()).build();
        unsubscribe = repository.observe(new PortalRepository.Listener() {
            @Override
            public void onChanged() {
                handler.post(() -> {
                    // Stop stale playback after signing out or switching to a different catalog.
                    MediaItem current = player.getCurrentMediaItem();
                    if (current != null) {
                        Channel allowed = CarCatalog.resolve(channels(), current.mediaId);
                        if (allowed == null || current.localConfiguration == null
                                || !allowed.streamUrl.equals(current.localConfiguration.uri.toString())) {
                            player.stop();
                            player.clearMediaItems();
                        }
                    }
                    session.notifyChildrenChanged(CarCatalog.ROOT, channels().size(), null);
                });
            }

            @Override
            public void onError(String message) {
                // The phone account screen displays backend errors, not the driving interface.
            }
        });
    }

    private List<Channel> channels() {
        return CarCatalog.audio(repository.portals(), repository.selectedPortalId());
    }

    private MediaItem item(Channel channel) {
        return new MediaItem.Builder()
                .setMediaId(CarCatalog.mediaId(channel))
                .setUri(channel.streamUrl)
                .setMediaMetadata(new MediaMetadata.Builder()
                        .setTitle(channel.title)
                        .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
                        .setIsBrowsable(false).setIsPlayable(true).build())
                .build();
    }

    @Override
    public MediaLibrarySession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    private final class BrowseCallback implements MediaLibrarySession.Callback {
        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetLibraryRoot(
                MediaLibrarySession session, MediaSession.ControllerInfo browser,
                LibraryParams params) {
            return Futures.immediateFuture(LibraryResult.ofItem(root(), params));
        }

        @Override
        public ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> onGetChildren(
                MediaLibrarySession session, MediaSession.ControllerInfo browser,
                String parentId, int page, int pageSize, LibraryParams params) {
            if (!CarCatalog.ROOT.equals(parentId) || page < 0 || pageSize < 1) {
                return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE));
            }
            List<MediaItem> items = new ArrayList<>();
            for (Channel channel : CarCatalog.page(channels(), page, pageSize)) items.add(item(channel));
            return Futures.immediateFuture(LibraryResult.ofItemList(items, params));
        }

        @Override
        public ListenableFuture<LibraryResult<MediaItem>> onGetItem(
                MediaLibrarySession session, MediaSession.ControllerInfo browser, String mediaId) {
            if (CarCatalog.ROOT.equals(mediaId)) {
                return Futures.immediateFuture(LibraryResult.ofItem(root(), null));
            }
            Channel channel = CarCatalog.resolve(channels(), mediaId);
            return Futures.immediateFuture(channel == null
                    ? LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
                    : LibraryResult.ofItem(item(channel), null));
        }

        private MediaItem root() {
            return new MediaItem.Builder().setMediaId(CarCatalog.ROOT)
                    .setMediaMetadata(new MediaMetadata.Builder().setTitle("Audio")
                            .setIsBrowsable(true).setIsPlayable(false).build()).build();
        }

        @Override
        public ListenableFuture<List<MediaItem>> onAddMediaItems(
                MediaSession session, MediaSession.ControllerInfo controller, List<MediaItem> mediaItems) {
            List<MediaItem> safeItems = new ArrayList<>();
            for (MediaItem requested : mediaItems) {
                Channel channel = CarCatalog.resolve(channels(), requested.mediaId);
                if (channel != null) safeItems.add(item(channel));
                if (safeItems.size() == CarCatalog.MAX_ITEMS) break;
            }
            return Futures.immediateFuture(safeItems);
        }
    }

    @Override
    public void onDestroy() {
        if (unsubscribe != null) unsubscribe.run();
        handler.removeCallbacksAndMessages(null);
        session.release();
        player.release();
        super.onDestroy();
    }
}
