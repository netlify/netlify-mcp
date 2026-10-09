package com.example.portal.core;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.auth.FirebaseAuth;

public final class RepoProvider {
    private static PortalRepository repository;
    private static final String APP_NAME = "portal-core";

    private RepoProvider() {}

    public static synchronized PortalRepository get(Context context) {
        if (repository == null) {
            Context appContext = context.getApplicationContext();
            if (isFirebaseConfigured(appContext)) {
                repository = new FirebaseRepository(appContext, firebaseApp(appContext));
            } else {
                MockPortalRepository mock = new MockPortalRepository();
                SharedPreferences local = appContext.getSharedPreferences("portal_device", Context.MODE_PRIVATE);
                String savedDevice = local.getString("device_demo", "");
                for (Device device : mock.devices()) {
                    if (device.id.equals(savedDevice)) { mock.selectDevice(savedDevice); break; }
                }
                mock.observe(new PortalRepository.Listener() {
                    @Override public void onChanged() {
                        local.edit().putString("device_demo", mock.selectedDeviceId()).apply();
                    }
                    @Override public void onError(String message) {}
                });
                repository = mock;
            }
        }
        return repository;
    }

    public static boolean isFirebaseConfigured(Context context) {
        return FirebaseConfiguration.isConfigured(
                resource(context, "firebase_project_id"),
                resource(context, "firebase_application_id"),
                resource(context, "firebase_api_key"));
    }

    static synchronized FirebaseAuth auth(Context context) {
        return FirebaseAuth.getInstance(firebaseApp(context.getApplicationContext()));
    }

    private static FirebaseApp firebaseApp(Context context) {
        for (FirebaseApp app : FirebaseApp.getApps(context)) {
            if (APP_NAME.equals(app.getName())) return app;
        }
        FirebaseOptions options = new FirebaseOptions.Builder()
                .setProjectId(resource(context, "firebase_project_id"))
                .setApplicationId(resource(context, "firebase_application_id"))
                .setApiKey(resource(context, "firebase_api_key"))
                .build();
        return FirebaseApp.initializeApp(context, options, APP_NAME);
    }

    private static String resource(Context context, String name) {
        int id = context.getResources().getIdentifier(name, "string", context.getPackageName());
        return id == 0 ? "" : context.getString(id).trim();
    }
}
