package com.the151universe.machine;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;

/**
 * FULLY NATIVE APK UPDATE (2026-08-16, v10).
 *
 * WHY THIS EXISTS — the bug it kills:
 * the Update button used to hand the APK URL to Capacitor's Browser plugin,
 * i.e. to the SYSTEM BROWSER (Brave). Brave repeatedly reached 113/113 MB and
 * then never finalised: no file in Downloads, no install prompt, update dead.
 * A third-party browser is a moving part we do not control and cannot debug.
 *
 * The whole flow is now inside the app:
 *   1. Android's own DownloadManager fetches the APK into our app-private
 *      external dir (no storage permission needed, auto-cleaned on uninstall).
 *   2. Progress is polled from the DownloadManager cursor and pushed to the
 *      WebView, so the progress bar lives INSIDE the app.
 *   3. On completion we fire the package-installer intent ourselves with a
 *      FileProvider content:// URI (a raw file:// URI throws FileUriExposed
 *      since Android 7).
 *
 * Nothing here ever opens a browser.
 *
 * JS contract (see public/js/auth.js):
 *   window.AndroidUpdater.start(url)  — begin download+install
 *   window.AndroidUpdater.cancel()    — abort a running download
 *   window.AndroidUpdater.isBusy()    — true while downloading
 *   window.__updateEvent({state,...}) — called BY US, on the UI thread:
 *       {state:'progress', pct, downloaded, total}
 *       {state:'installing'}                       (installer intent fired)
 *       {state:'error', code, message}             codes: space | network |
 *                                                  permission | file | unknown
 */
public class UpdateInstaller {

    /** Sub-folder of getExternalFilesDir(null) — mirrored in res/xml/file_paths.xml. */
    private static final String SUB_DIR = "updates";
    private static final String FILE_NAME = "151-machine-update.apk";

    /**
     * The APK is ~114 MB and DownloadManager needs room for the file plus its
     * own staging copy. Refusing up-front with a clear message beats failing at
     * 90% with reason 1006.
     */
    private static final long MIN_FREE_BYTES = 400L * 1024 * 1024;

    private static final long POLL_MS = 500;

    private final MainActivity act;
    private final Handler ui = new Handler(Looper.getMainLooper());

    private long downloadId = -1;
    private File target;
    /** Set when the install intent was blocked by the "unknown sources" gate. */
    private boolean installPending = false;

    UpdateInstaller(MainActivity act) {
        this.act = act;
    }

    // ---------------------------------------------------------------- start

    boolean isBusy() {
        return downloadId != -1;
    }

    void start(final String url) {
        ui.post(() -> {
            try {
                if (downloadId != -1) return;          // already running
                if (url == null || url.isEmpty()) {
                    fail("unknown", "Indirizzo dell'aggiornamento mancante.");
                    return;
                }

                File dir = new File(act.getExternalFilesDir(null), SUB_DIR);
                if (!dir.exists() && !dir.mkdirs()) {
                    fail("file", "Non riesco a creare la cartella per l'aggiornamento.");
                    return;
                }

                // A leftover from a previous attempt would make DownloadManager
                // fail with ERROR_FILE_ALREADY_EXISTS (1009).
                target = new File(dir, FILE_NAME);
                if (target.exists() && !target.delete()) {
                    fail("file", "Non riesco a rimuovere il download precedente.");
                    return;
                }

                if (dir.getUsableSpace() < MIN_FREE_BYTES) {
                    fail("space", "Spazio insufficiente: servono circa 400 MB liberi. "
                            + "Libera spazio e riprova.");
                    return;
                }

                DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) {
                    fail("unknown", "Gestore download di Android non disponibile.");
                    return;
                }

                DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                req.setTitle("The 151 Machine");
                req.setDescription("Scarico l'aggiornamento…");
                req.setMimeType("application/vnd.android.package-archive");
                req.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setAllowedOverMetered(true);
                req.setAllowedOverRoaming(true);
                // App-private external storage: no permission required, and the
                // file disappears if the app is uninstalled.
                req.setDestinationInExternalFilesDir(
                        act, null, SUB_DIR + "/" + FILE_NAME);

                downloadId = dm.enqueue(req);
                emit("{\"state\":\"progress\",\"pct\":0,\"downloaded\":0,\"total\":0}");
                ui.postDelayed(this::poll, POLL_MS);
            } catch (Exception e) {
                fail("unknown", "Non riesco ad avviare il download: " + e.getMessage());
            }
        });
    }

    void cancel() {
        ui.post(() -> {
            try {
                if (downloadId == -1) return;
                DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) dm.remove(downloadId);
            } catch (Exception ignored) {
            } finally {
                downloadId = -1;
            }
        });
    }

    // --------------------------------------------------------------- polling

    private void poll() {
        if (downloadId == -1) return;
        DownloadManager dm = (DownloadManager) act.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) { fail("unknown", "Gestore download non disponibile."); return; }

        Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(downloadId));
            if (c == null || !c.moveToFirst()) {
                // Row vanished — the user wiped it from the download list.
                fail("network", "Download interrotto. Tocca Riprova.");
                return;
            }
            int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long done = c.getLong(c.getColumnIndexOrThrow(
                    DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = c.getLong(c.getColumnIndexOrThrow(
                    DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            int reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));

            switch (status) {
                case DownloadManager.STATUS_SUCCESSFUL:
                    downloadId = -1;
                    emit("{\"state\":\"progress\",\"pct\":100,\"downloaded\":" + done
                            + ",\"total\":" + Math.max(total, done) + "}");
                    install();
                    return;

                case DownloadManager.STATUS_FAILED:
                    downloadId = -1;
                    failFromReason(reason);
                    return;

                default: {
                    int pct = (total > 0) ? (int) ((done * 100L) / total) : 0;
                    if (pct > 99) pct = 99;   // 100 is reserved for "really done"
                    emit("{\"state\":\"progress\",\"pct\":" + pct + ",\"downloaded\":" + done
                            + ",\"total\":" + total + "}");
                    ui.postDelayed(this::poll, POLL_MS);
                }
            }
        } catch (Exception e) {
            downloadId = -1;
            fail("unknown", "Errore durante il download: " + e.getMessage());
        } finally {
            if (c != null) try { c.close(); } catch (Exception ignored) {}
        }
    }

    private void failFromReason(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                fail("space", "Spazio insufficiente sul telefono. Libera spazio e riprova.");
                break;
            case DownloadManager.ERROR_DEVICE_NOT_FOUND:
                fail("space", "Memoria non disponibile. Riprova.");
                break;
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS:
            case DownloadManager.ERROR_FILE_ERROR:
                fail("file", "Non riesco a salvare il file. Riprova.");
                break;
            case DownloadManager.ERROR_CANNOT_RESUME:
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                fail("network", "Download interrotto (connessione). Tocca Riprova.");
                break;
            default:
                fail("network", "Download non riuscito. Tocca Riprova.");
        }
    }

    // --------------------------------------------------------------- install

    /**
     * Fire Android's package installer. Two things are mandatory here:
     * (a) a FileProvider content:// URI — a file:// URI throws
     *     FileUriExposedException on Android 7+;
     * (b) FLAG_GRANT_READ_URI_PERMISSION — otherwise the installer process
     *     cannot read our private file and the dialog dies silently.
     */
    private void install() {
        try {
            if (target == null || !target.exists() || target.length() == 0) {
                fail("file", "Il file scaricato non c'è più. Tocca Riprova.");
                return;
            }

            // "Install unknown apps" gate (Android 8+). It is per-app and must be
            // granted by hand ONCE; we deep-link straight to the right screen.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !act.getPackageManager().canRequestPackageInstalls()) {
                installPending = true;
                emit("{\"state\":\"error\",\"code\":\"permission\",\"message\":"
                        + jsonStr("Android chiede il permesso di installare aggiornamenti. "
                        + "Attivalo nella schermata che si apre, poi torna qui: "
                        + "l'installazione riparte da sola.") + "}");
                toast("Attiva \"Consenti da questa fonte\", poi torna all'app.");
                try {
                    act.startActivity(new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + act.getPackageName()))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (Exception e) {
                    // Some OEM builds lack the per-app screen — fall back to the list.
                    try {
                        act.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    } catch (Exception ignored) {}
                }
                return;
            }

            installPending = false;
            Uri uri = FileProvider.getUriForFile(
                    act, act.getPackageName() + ".fileprovider", target);
            Intent i = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            emit("{\"state\":\"installing\"}");
            act.startActivity(i);
        } catch (Exception e) {
            fail("unknown", "Non riesco ad aprire l'installazione: " + e.getMessage());
        }
    }

    /**
     * Called from MainActivity.onResume(). Covers the one case that would
     * otherwise strand the update: the user leaves to grant "install unknown
     * apps" and comes back — the APK is already on disk, so we just retry the
     * installer instead of making him download 114 MB again.
     */
    void onActivityResumed() {
        if (!installPending) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !act.getPackageManager().canRequestPackageInstalls()) {
            return;                       // still not granted — leave it pending
        }
        installPending = false;
        ui.postDelayed(this::install, 300);
    }

    // ----------------------------------------------------------------- glue

    private void fail(String code, String message) {
        downloadId = -1;
        emit("{\"state\":\"error\",\"code\":" + jsonStr(code)
                + ",\"message\":" + jsonStr(message) + "}");
        toast(message);
    }

    private void toast(final String msg) {
        ui.post(() -> {
            try { Toast.makeText(act, msg, Toast.LENGTH_LONG).show(); } catch (Exception ignored) {}
        });
    }

    /**
     * Push an event into the WebView. Guarded with `window.__updateEvent &&`
     * so an OLD web build (which knows nothing about this bridge) simply
     * ignores it — the download still completes and still installs, it just
     * shows the system notification instead of an in-app bar.
     */
    private void emit(final String json) {
        try {
            final WebView wv = act.getBridge().getWebView();
            if (wv == null) return;
            wv.post(() -> {
                try {
                    wv.evaluateJavascript(
                            "window.__updateEvent && window.__updateEvent(" + json + ")", null);
                } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
    }

    private static String jsonStr(String s) {
        if (s == null) return "\"\"";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"':  b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n");  break;
                case '\r': b.append("\\r");  break;
                case '\t': b.append("\\t");  break;
                default:
                    if (ch < 0x20) b.append(String.format("\\u%04x", (int) ch));
                    else b.append(ch);
            }
        }
        return b.append('"').toString();
    }

    /** Sweep a stale APK (called on next start; a fresh run deletes it anyway). */
    static void cleanup(Context ctx) {
        try {
            File f = new File(new File(ctx.getExternalFilesDir(null), SUB_DIR), FILE_NAME);
            if (f.exists()) f.delete();
        } catch (Exception ignored) {}
    }
}
