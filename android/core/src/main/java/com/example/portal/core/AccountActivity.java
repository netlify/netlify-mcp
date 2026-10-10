package com.example.portal.core;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import java.lang.ref.WeakReference;

/** The same keyboard-capable email/password sign-in screen is used on handheld and TV. */
public final class AccountActivity extends Activity {
    private FirebaseAuth auth;
    private FirebaseAuth.AuthStateListener authListener;
    private TextView status;
    private EditText email;
    private EditText password;
    private Button login;
    private Button logout;
    private boolean busy;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (24 * getResources().getDisplayMetrics().density);
        content.setPadding(padding, padding, padding, padding);
        scroll.addView(content);
        TextView heading = new TextView(this);
        heading.setText("Portal account");
        heading.setTextSize(24);
        content.addView(heading);
        status = new TextView(this);
        status.setAccessibilityLiveRegion(TextView.ACCESSIBILITY_LIVE_REGION_POLITE);
        content.addView(status);
        email = new EditText(this);
        email.setHint("Email");
        email.setContentDescription("Email address");
        email.setSingleLine(true);
        email.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        email.setImeOptions(EditorInfo.IME_ACTION_NEXT);
        email.setSaveEnabled(false);
        content.addView(email);
        password = new EditText(this);
        password.setHint("Password");
        password.setContentDescription("Password");
        password.setSingleLine(true);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setImeOptions(EditorInfo.IME_ACTION_DONE);
        password.setSaveEnabled(false);
        content.addView(password);
        login = new Button(this);
        login.setText("Sign in");
        content.addView(login);
        logout = new Button(this);
        logout.setText("Sign out");
        content.addView(logout);
        Button done = new Button(this);
        done.setText("Done");
        content.addView(done, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        done.setOnClickListener(view -> finish());
        setContentView(scroll);
        if (!RepoProvider.isFirebaseConfigured(this)) {
            status.setText("Demo mode. Configure Firebase to sign in and share your devices.");
            email.setEnabled(false);
            password.setEnabled(false);
            login.setEnabled(false);
            logout.setEnabled(false);
            return;
        }
        auth = RepoProvider.auth(this);
        RepoProvider.get(this);
        authListener = ignored -> refreshUser();
        login.setOnClickListener(view -> signIn());
        logout.setOnClickListener(view -> {
            password.setText("");
            email.setText("");
            auth.signOut();
        });
        password.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) { signIn(); return true; }
            return false;
        });
        refreshUser();
    }

    private void signIn() {
        if (auth == null || busy) return;
        String address = email.getText().toString().trim();
        String secret = password.getText().toString();
        if (address.isEmpty() || secret.isEmpty()) {
            status.setText("Enter an email address and password.");
            return;
        }
        busy = true;
        login.setEnabled(false);
        logout.setEnabled(false);
        status.setText("Signing in…");
        password.setText("");
        WeakReference<AccountActivity> owner = new WeakReference<>(this);
        auth.signInWithEmailAndPassword(address, secret).addOnCompleteListener(task -> {
            AccountActivity activity = owner.get();
            if (activity == null) return;
            activity.busy = false;
            if (activity.isFinishing() || activity.isDestroyed()) return;
            activity.refreshUser();
            if (!task.isSuccessful()) {
                Exception exception = task.getException();
                activity.status.setText(exception == null ? "Sign-in failed." : exception.getLocalizedMessage());
            } else {
                activity.email.setText("");
            }
        });
    }

    private void refreshUser() {
        FirebaseUser user = auth.getCurrentUser();
        status.setText(user == null ? "Not signed in." : "Signed in as " + user.getEmail());
        login.setEnabled(!busy && user == null);
        logout.setEnabled(!busy && user != null);
        email.setEnabled(!busy && user == null);
        password.setEnabled(!busy && user == null);
    }

    @Override protected void onStart() {
        super.onStart();
        if (auth != null) auth.addAuthStateListener(authListener);
    }

    @Override protected void onStop() {
        if (auth != null) auth.removeAuthStateListener(authListener);
        password.setText("");
        super.onStop();
    }
}
