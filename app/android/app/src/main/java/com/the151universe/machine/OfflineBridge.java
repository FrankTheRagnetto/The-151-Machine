package com.the151universe.machine;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * LA MODALITÀ OFFLINE, lato telefono (2026-10-07, seconda versione).
 *
 * il proprietario: «una sola interfaccia, sempre la Machine di sempre». Quindi niente
 * pagina a parte: quando il Raspberry Pi non risponde, il telefono serve LA
 * STESSA app dalla copia che l'APK ha dentro (assets/public, messa lì da
 * `npx cap sync`), allo STESSO indirizzo del Pi. Stessa origine vuol dire:
 * stesso localStorage, stesso Capacitor (Filesystem, convertFileSrc), stessi
 * scaricati — anche con una VPN accesa, perché nulla di tutto questo passa
 * dalla rete. Ogni /api/* risponde subito 503 `{"offline":true}`: l'app sa
 * all'istante che il Pi manca e non resta ad aspettare.
 *
 * Perché la prima versione (pagina offline.html + ponte che controllava «chi
 * chiama» leggendo l'indirizzo della pagina) ha mostrato «Nothing downloaded
 * yet» e nessun portale con Mullvad acceso: i portali erano una lista fissa,
 * quindi vuota poteva tornare SOLO se il controllo del chiamante falliva. Il
 * controllo leggeva `urlPrincipale`, scritto dalle chiamate della WebView
 * (onPageStarted/onPageCommitVisible) che arrivano dopo, e in ordine non
 * garantito, rispetto al JavaScript della pagina; sul ramo lento (Mullvad: la
 * richiesta al Pi resta appesa, la guardia degli 8 s cambia pagina) restava
 * sull'indirizzo del Pi. Sul ramo veloce (Tailscale spento: il nome non esiste,
 * errore subito) arrivava giusto. Questa versione non ha più niente del genere:
 * i dati vengono dall'app stessa, non da un ponte con controlli di pagina.
 *
 * Cosa fa:
 *   · SONDA del Pi: GET <server.url>/api/health, al massimo SONDA_MS (anche il
 *     DNS, che con una VPN può restare appeso), a ogni rete nuova o persa
 *     (ConnectivityManager), ogni OGNI_MS finché il Pi manca, e prima di ogni
 *     pagina principale se l'ultima risposta è vecchia.
 *     [27/10/2026, il proprietario: «va in grigio e torna da solo»] Chi decide «giù» è
 *     GiudiceRete: da «su» servono 2 sonde mancate DI FILA (la seconda parte
 *     dopo RIPROVA_MS). Un cambio di «capacità» (il segnale Wi-Fi che oscilla,
 *     a raffica) non lancia più sonde finché il Pi è su: era la pioggia di
 *     occasioni per un colpo mancato.
 *   · SERVITORE: richieste verso il Pi (stesso schema, host e porta) quando
 *     il Pi manca → file dalla copia nell'APK; /api/* → 503 offline. Mai
 *     toccati: /_capacitor_file_ e /_capacitor_content_ (i file del telefono,
 *     li serve Capacitor) e tutto ciò che non è del Pi.
 *   · RETE DI SICUREZZA: la pagina principale del Pi fallisce comunque (il Pi
 *     è morto fra la sonda e la richiesta) → si segna «Pi giù» e si ricarica,
 *     stavolta dalla copia. Mai più schermo blu.
 *   · PONTE `AndroidRete` (nessun segreto, /hack 07/10): piRaggiungibile(),
 *     paginaDalTelefono(). (1.20, 12/10: tolti apri(slug) e internet(), che
 *     servivano solo ai 4 siti della scuola — tolti dal proprietario.)
 */
public class OfflineBridge {

    static final int SONDA_MS = 2500;
    static final long OGNI_MS = 5000;
    static final long VECCHIA_MS = 5000;
    /** Dopo una sonda mancata col Pi su: la conferma (sopra il limite di 1 s). */
    static final long RIPROVA_MS = 1100;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("js", "application/javascript");
        MIME.put("mjs", "application/javascript");
        MIME.put("css", "text/css");
        MIME.put("html", "text/html");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("woff2", "font/woff2");
        MIME.put("woff", "font/woff");
        MIME.put("wasm", "application/wasm");
    }

    private final MainActivity act;
    private final Bridge bridge;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService sonde = Executors.newCachedThreadPool();
    private final String urlPi;
    private final String hostPi;
    private final String schemaPi;
    private final int portaPi;

    /** null = non so ancora; true/false = ultima risposta della sonda. */
    private volatile Boolean piSu = null;
    private final GiudiceRete giudice = new GiudiceRete();
    private volatile long sondaAlle = 0;
    private volatile boolean paginaLocale = false;
    private volatile int ricarichePerErrore = 0;
    private volatile boolean inPrimoPiano = true;

    private final Runnable giro = new Runnable() {
        @Override public void run() {
            if (!inPrimoPiano) return;
            if (Boolean.FALSE.equals(piSu)) sondaInSfondo();
            ui.postDelayed(this, OGNI_MS);
        }
    };

    OfflineBridge(MainActivity act, Bridge bridge) {
        this.act = act;
        this.bridge = bridge;
        this.urlPi = bridge.getServerUrl();
        String h = null, sc = null;
        int po = -1;
        try { Uri u = Uri.parse(urlPi); h = u.getHost(); sc = u.getScheme(); po = u.getPort(); } catch (Exception ignored) {}
        this.hostPi = h;
        this.schemaPi = sc;
        this.portaPi = po;
    }

    /** Da MainActivity.onCreate, subito dopo super.onCreate. */
    void installa() {
        WebView wv = bridge.getWebView();
        if (wv == null || urlPi == null || hostPi == null) return;
        bridge.setWebViewClient(new ClientConCopia(bridge));
        wv.addJavascriptInterface(new Ponte(), "AndroidRete");
        try {
            ConnectivityManager cm = (ConnectivityManager) act.getSystemService(Context.CONNECTIVITY_SERVICE);
            cm.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override public void onAvailable(Network n) { sondaInSfondo(); }
                @Override public void onLost(Network n) { sondaInSfondo(); }
                // Arriva a raffica (anche per la forza del segnale): serve solo a risalire.
                @Override public void onCapabilitiesChanged(Network n, android.net.NetworkCapabilities c) {
                    if (Boolean.FALSE.equals(piSu)) sondaInSfondo();
                }
            });
        } catch (Exception ignored) {}
        ui.postDelayed(giro, OGNI_MS);
    }

    void onResume() { inPrimoPiano = true; ui.removeCallbacks(giro); ui.post(giro); sondaInSfondo(); }
    void onPause() { inPrimoPiano = false; ui.removeCallbacks(giro); }

    // ─── La sonda ──────────────────────────────────────────────────────────

    /** Il Pi risponde? Al massimo SONDA_MS, DNS compreso. */
    private boolean sonda() {
        Future<Boolean> f = sonde.submit(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(urlPi + "/api/health").openConnection();
                c.setConnectTimeout(SONDA_MS);
                c.setReadTimeout(SONDA_MS);
                c.setUseCaches(false);
                c.setRequestProperty("x-151-sonda", "1");
                return c.getResponseCode() == 200;
            } catch (Exception e) {
                return false;
            } finally {
                if (c != null) c.disconnect();
            }
        });
        boolean ok;
        try { ok = f.get(SONDA_MS, TimeUnit.MILLISECONDS); }
        catch (Exception e) { f.cancel(true); ok = false; }
        segna(ok);
        return ok;
    }

    private void segna(boolean ok) {
        Boolean ora = giudice.segna(ok);
        if (ok) ricarichePerErrore = 0;
        // Mancata ma ancora «su»: la conferma subito, non al prossimo evento.
        if (!ok && Boolean.TRUE.equals(ora)) {
            android.util.Log.i("151-RETE", "sonda mancata, riprovo");
            ui.postDelayed(this::sondaInSfondo, RIPROVA_MS);
        }
        cambia(ora);
    }

    /** Certezza (la pagina principale non è arrivata): giù subito. */
    private void segnaGiu() { cambia(giudice.giu()); }

    private void cambia(Boolean ora) {
        Boolean prima = piSu;
        piSu = ora;
        sondaAlle = System.currentTimeMillis();
        if (prima == null || !prima.equals(ora)) {
            final boolean ok = Boolean.TRUE.equals(ora);
            android.util.Log.i("151-RETE", "Pi " + (ok ? "raggiungibile" : "NON raggiungibile"));
            ui.post(() -> {
                WebView wv = bridge.getWebView();
                if (wv != null) wv.evaluateJavascript("window.__retePiCambiata&&window.__retePiCambiata()", null);
            });
        }
    }

    private volatile long ultimaSondaChiesta = 0;
    /** Una sonda in sfondo, al massimo una al secondo (la rete cambia a raffica). */
    private void sondaInSfondo() {
        // [2026-11-10 BATTERIA ] Solo con l'app davanti. Prima i callback di
        // rete (onAvailable, onLost, onCapabilitiesChanged a raffica col segnale)
        // e la riprova dopo una mancata sondavano anche con l'app in tasca: col
        // PC giù fino a una richiesta al secondo, tutto il giorno. Al ritorno
        // onResume rimette inPrimoPiano e sonda subito; la pagina che carica
        // (piGiu → sonda) non passa di qui e resta com'era.
        if (!inPrimoPiano) return;
        long ora = System.currentTimeMillis();
        if (ora - ultimaSondaChiesta < 1000) return;
        ultimaSondaChiesta = ora;
        sonde.submit(this::sonda);
    }

    private boolean piGiu() {
        Boolean s = piSu;
        if (s == null || System.currentTimeMillis() - sondaAlle > VECCHIA_MS) sonda();
        return Boolean.FALSE.equals(piSu);
    }

    // ─── Il servitore ──────────────────────────────────────────────────────

    /** Stesso schema, host E porta di server.url: un altro servizio del Pi non vale. */
    private boolean eDelPi(Uri u) {
        return u != null && hostPi != null && hostPi.equalsIgnoreCase(u.getHost())
            && schemaPi != null && schemaPi.equalsIgnoreCase(u.getScheme())
            && u.getPort() == portaPi;
    }

    private static boolean fileDelTelefono(String path) {
        return path.startsWith("/_capacitor_file_") || path.startsWith("/_capacitor_content_");
    }

    private WebResourceResponse daCopia(String path) {
        String p = (path == null || path.isEmpty() || path.equals("/")) ? "/index.html" : path;
        if (p.contains("..")) return risposta(404, "text/plain", "not found");
        String ext = p.substring(p.lastIndexOf('.') + 1).toLowerCase();
        String mime = MIME.get(ext);
        if (mime == null) mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mime == null) mime = "application/octet-stream";
        try {
            AssetManager am = act.getAssets();
            InputStream in = am.open("public" + p);
            WebResourceResponse r = new WebResourceResponse(mime, "utf-8", in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-store");
            h.put("X-151-Copia", "telefono");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception e) {
            return risposta(404, "text/plain", "not in the phone copy");
        }
    }

    private static WebResourceResponse risposta(int code, String mime, String body) {
        WebResourceResponse r = new WebResourceResponse(mime, "utf-8",
            new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("X-151-Copia", "telefono");
        r.setStatusCodeAndReasonPhrase(code, code == 503 ? "Offline" : "Not Found");
        r.setResponseHeaders(h);
        return r;
    }

    private class ClientConCopia extends BridgeWebViewClient {
        ClientConCopia(Bridge b) { super(b); }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (eDelPi(u)) {
                String path = u.getPath() == null ? "/" : u.getPath();
                if (!fileDelTelefono(path)) {
                    boolean giu = req.isForMainFrame() ? piGiu() : Boolean.FALSE.equals(piSu);
                    if (req.isForMainFrame()) paginaLocale = giu;
                    if (giu) {
                        if (path.startsWith("/api/")) {
                            return risposta(503, "application/json",
                                "{\"ok\":false,\"offline\":true,\"chatAvailable\":false,\"cliAvailable\":false}");
                        }
                        if ("GET".equalsIgnoreCase(req.getMethod())) return daCopia(path);
                    }
                }
            }
            return super.shouldInterceptRequest(view, req);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
            super.onReceivedError(view, req, error);
            // La pagina del Pi non è arrivata: Pi giù, si riprova dalla copia.
            if (req.isForMainFrame() && eDelPi(req.getUrl()) && ricarichePerErrore < 2) {
                ricarichePerErrore++;
                segnaGiu();
                ui.post(() -> { WebView wv = bridge.getWebView(); if (wv != null) wv.loadUrl(urlPi); });
            }
        }
    }

    // ─── Il ponte ──────────────────────────────────────────────────────────

    public class Ponte {
        /** Il Pi risponde? (ultima sonda; true finché non si sa). */
        @JavascriptInterface
        public boolean piRaggiungibile() { return !Boolean.FALSE.equals(piSu); }

        /** Questa pagina l'ha servita il telefono, dalla copia nell'APK? */
        @JavascriptInterface
        public boolean paginaDalTelefono() { return paginaLocale; }
    }

    /** Per AndroidUpdater (paletto 7 di /hack): l'APK si scarica solo dal Pi. */
    boolean apkAmmesso(String url) {
        try {
            Uri u = Uri.parse(url);
            return eDelPi(u) && "/api/download-apk".equals(u.getPath());
        } catch (Exception e) { return false; }
    }
}
