package com.the151universe.machine;

import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.content.Context;
import android.content.pm.PackageManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.ArrayList;

public class MainActivity extends BridgeActivity {

    private static final int PERMISSION_REQUEST_CODE = 151;

    /** Native APK download + install (v10). See UpdateInstaller. */
    private UpdateInstaller updater;

    /** Le tre modalità: copia dell'app servita dal telefono quando il Pi manca (2026-10-07). */
    private OfflineBridge offline;

    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest; // API 26+
    private final AudioManager.OnAudioFocusChangeListener focusListener =
            focusChange -> { /* no-op: we don't react to loss/gain ourselves */ };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Prima di tutto il resto: la prima pagina verso il Pi è già partita.
        offline = new OfflineBridge(this, getBridge());
        offline.installa();
        requestNeededPermissions();
        enableWebViewMicPermission();
        installAudioFocusBridge();
        installMicBridge();
        installUpdaterBridge();
        // BATTERY ROUND 2026-08-16 — the Doze-exemption request is gone
        // (its dead method was deleted 2026-09-29). Asking Android to exempt us from Doze was the third leg
        // of the always-awake setup: it stopped the OS from ever throttling the
        // app. We now WANT the OS to throttle us in the background.
        // NB: the exemption already granted on the phone survives this change —
        // it must be revoked by hand in Android settings (see projects/phone.md).
    }

    @Override
    public void onResume() {
        super.onResume();
        if (offline != null) offline.onResume();
        // If the user just came back from granting "install unknown apps", the
        // APK is already downloaded — resume the install instead of re-downloading.
        if (updater != null) updater.onActivityResumed();
        // BATTERY ROUND 2026-08-16 — we deliberately DO NOT start the keep-alive
        // service here any more. Holding the process + CPU awake whenever the app
        // was merely OPEN is what kept the phone hot and flattened the battery
        // overnight. Foreground now plays by normal Android rules; on return the
        // web side re-attaches by itself (public/js/ws.js → wsOnResume).
        keepWebViewTimersRunning();
    }

    @Override
    public void onPause() {
        super.onPause();
        if (offline != null) offline.onPause();
        // BATTERY ROUND 2026-08-16 — going to the background must be CHEAP: every JS
        // timer stops (WebSocket heartbeat, pollers, animations). L'eccezione per
        // l'audio a schermo spento è uscita con Entertainment (13/10/2026).
        pauseWebViewTimers();
    }

    private void keepWebViewTimersRunning() {
        try {
            WebView wv = getBridge().getWebView();
            if (wv != null) wv.resumeTimers();
        } catch (Exception ignored) {}
    }

    /** Freeze every JS timer in the WebView (counterpart of resumeTimers). */
    private void pauseWebViewTimers() {
        try {
            WebView wv = getBridge().getWebView();
            if (wv != null) wv.pauseTimers();
        } catch (Exception ignored) {}
    }

    /**
     * window.AndroidMic.{start,stop}() — public/js/dictation.js accende MicService
     * al tap che avvia la registrazione (app ancora visibile: Android lo esige) e
     * lo spegne quando la registrazione finisce. Vedi MicService.
     */
    private void installMicBridge() {
        WebView webView = getBridge().getWebView();
        webView.addJavascriptInterface(new MicJsBridge(), "AndroidMic");
    }

    public class MicJsBridge {
        @JavascriptInterface
        public void start() { runOnUiThread(() -> micService(MicService.ACTION_START)); }
        @JavascriptInterface
        public void stop()  { runOnUiThread(() -> micService(MicService.ACTION_STOP)); }
    }

    private void micService(String action) {
        try {
            Intent i = new Intent(this, MicService.class).setAction(action);
            if (MicService.ACTION_START.equals(action) && Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (Exception ignored) {}
    }

    // ------------------------------------------------------------------
    // NATIVE APK UPDATE (v10, 2026-08-16)
    //
    // Old flow: Update button → Capacitor Browser → SYSTEM BROWSER (Brave) →
    // Brave reached 113/113 MB and never finalised the file → update dead.
    // New flow: everything below stays inside the app (DownloadManager +
    // FileProvider + package installer). No browser is ever involved.
    //
    // Three entry points, on purpose:
    //  1. window.AndroidUpdater.start(url)  — what the NEW auth.js calls.
    //  2. A JS shim injected on every page load that reroutes any
    //     Capacitor Browser.open() of an APK URL into (1). This is what makes
    //     v10 safe even while the Pi is still serving the OLD auth.js — the
    //     legacy button silently becomes native instead of opening Brave.
    //  3. A WebView DownloadListener, covering auth.js's non-Capacitor
    //     fallback (an <a download> click), which a WebView otherwise drops
    //     on the floor.
    // ------------------------------------------------------------------

    private void installUpdaterBridge() {
        updater = new UpdateInstaller(this);
        WebView webView = getBridge().getWebView();
        webView.addJavascriptInterface(new UpdaterJsBridge(), "AndroidUpdater");

        // (3) Fallback path: <a download> / any WebView-initiated download.
        try {
            webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
                if (isApkUrl(url) || "application/vnd.android.package-archive".equals(mimeType)) {
                    updater.start(url);
                }
            });
        } catch (Exception ignored) {}

        // (2) Re-injected on every page load, because the web app is served
        // remotely and reloads on its own.
        try {
            getBridge().addWebViewListener(new WebViewListener() {
                @Override
                public void onPageLoaded(WebView wv) {
                    injectBrowserGuard(wv);
                }
            });
        } catch (Exception ignored) {}
    }

    private static boolean isApkUrl(String url) {
        if (url == null) return false;
        String u = url.toLowerCase();
        return u.contains("/api/download-apk") || u.contains(".apk");
    }

    /**
     * Make sure an APK URL can never reach an external browser again, even when
     * the server is still serving the OLD auth.js (which calls Browser.open).
     *
     * GOTCHA that dictates the shape of this code: a Capacitor plugin object is
     * a Proxy whose `get` trap has a catch-all `default` branch returning a
     * freshly built method wrapper (@capacitor/core registerPlugin). So
     * `Plugins.Browser.open = fn` does NOT stick — the trap keeps handing back
     * the generated one — and any marker read off it comes back truthy. The
     * only assignable surface is `Capacitor.Plugins` itself, a plain object
     * (`Plugins[pluginName] = proxy`). So we swap the WHOLE Browser entry for a
     * delegating proxy instead of patching a method on it.
     *
     * Retries for ~10s: the Browser plugin is registered by the web bundle,
     * which may not have run yet when the page-loaded callback fires.
     */
    private void injectBrowserGuard(final WebView wv) {
        final String js =
            "(function(){var C=window.Capacitor;if(!C)return;var P=C.Plugins;if(!P||P.__u151)return;" +
            "function apk(u){return typeof u==='string'&&(u.indexOf('/api/download-apk')!==-1||/\\.apk(\\?|$)/i.test(u));}" +
            "var n=0;(function p(){try{if(P.__u151)return;var R=P.Browser;" +
            "if(R){P.Browser=new Proxy({},{get:function(_,k){" +
            "if(k==='open')return function(a){if(a&&apk(a.url)&&window.AndroidUpdater){" +
            "try{window.AndroidUpdater.start(a.url);}catch(e){}return Promise.resolve();}return R.open(a);};" +
            "return R[k];}});P.__u151=1;return;}}catch(e){}" +
            "if(n++<20)setTimeout(p,500);})();})();";
        try {
            wv.post(() -> {
                try { wv.evaluateJavascript(js, null); } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
    }

    public class UpdaterJsBridge {
        /** Download the APK natively, then hand it to the package installer. */
        @JavascriptInterface
        public void start(String url) {
            // [2026-10-07] /hack: qualunque pagina nella WebView poteva far
            // scaricare un APK da qualunque indirizzo. Ora solo dal Pi.
            if (offline != null && !offline.apkAmmesso(url)) {
                android.util.Log.w("151-UPDATER", "APK rifiutato: indirizzo non del Pi");
                final WebView wv = getBridge().getWebView();
                if (wv != null) wv.post(() -> wv.evaluateJavascript(
                    "window.__updateEvent&&window.__updateEvent({state:'error',code:'unknown',message:'Aggiornamento solo dal Raspberry Pi.'})", null));
                return;
            }
            if (updater != null) updater.start(url);
        }

        @JavascriptInterface
        public void cancel() { if (updater != null) updater.cancel(); }

        @JavascriptInterface
        public boolean isBusy() { return updater != null && updater.isBusy(); }

        /** Lets the web side prove the native path exists before offering it. */
        @JavascriptInterface
        public boolean available() { return true; }
    }

    private void enableWebViewMicPermission() {
        WebView webView = getBridge().getWebView();
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }

    /**
     * Inject window.AndroidAudioFocus.{request,abandon}() into the WebView
     * so dictation.js can duck other media while recording.
     */
    private void installAudioFocusBridge() {
        WebView webView = getBridge().getWebView();
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        webView.addJavascriptInterface(new AudioFocusJsBridge(), "AndroidAudioFocus");
    }

    public class AudioFocusJsBridge {
        @JavascriptInterface
        public void request() {
            runOnUiThread(() -> {
                try {
                    if (audioManager == null) return;
                    if (Build.VERSION.SDK_INT >= 26) {
                        AudioAttributes attrs = new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build();
                        audioFocusRequest = new AudioFocusRequest.Builder(
                                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                                .setAudioAttributes(attrs)
                                .setOnAudioFocusChangeListener(focusListener)
                                .build();
                        audioManager.requestAudioFocus(audioFocusRequest);
                    } else {
                        audioManager.requestAudioFocus(focusListener,
                                AudioManager.STREAM_VOICE_CALL,
                                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
                    }
                } catch (Exception e) {
                    // swallow — focus is best-effort
                }
            });
        }

        @JavascriptInterface
        public void abandon() {
            runOnUiThread(() -> {
                try {
                    if (audioManager == null) return;
                    if (Build.VERSION.SDK_INT >= 26 && audioFocusRequest != null) {
                        audioManager.abandonAudioFocusRequest(audioFocusRequest);
                        audioFocusRequest = null;
                    } else {
                        audioManager.abandonAudioFocus(focusListener);
                    }
                } catch (Exception e) {
                    // swallow
                }
            });
        }
    }

    /**
     * Solo ciò che l'app usa davvero:
     * il microfono per la dettatura (dictation.js) e, da Android 13, le notifiche.
     * Già concessi → Android non chiede niente.
     */
    private void requestNeededPermissions() {
        ArrayList<String> all = new ArrayList<>();
        all.add(android.Manifest.permission.RECORD_AUDIO);
        if (Build.VERSION.SDK_INT >= 33) all.add("android.permission.POST_NOTIFICATIONS");
        ArrayList<String> needed = new ArrayList<>();
        for (String perm : all) {
            try {
                if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) needed.add(perm);
            } catch (Exception ignored) {}
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        }
    }
}
