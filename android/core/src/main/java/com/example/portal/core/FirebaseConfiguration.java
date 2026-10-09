package com.example.portal.core;

final class FirebaseConfiguration {
    private FirebaseConfiguration() {}

    static boolean isConfigured(String projectId, String applicationId, String apiKey) {
        boolean project = present(projectId);
        boolean application = present(applicationId);
        boolean key = present(apiKey);
        if (!project && !application && !key) return false;
        if (project && application && key) return true;
        throw new IllegalStateException("Firebase configuration requires all three resources: "
                + "firebase_project_id, firebase_application_id and firebase_api_key");
    }

    private static boolean present(String value) { return value != null && !value.trim().isEmpty(); }
}
