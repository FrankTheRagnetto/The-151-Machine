package com.the151universe.machine;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import java.util.List;

/**
 * Registrazione vocale a schermo bloccato / app in secondo piano (29/09/2026).
 *
 * Da Android 11 un'app che NON si vede riceve SILENZIO dal microfono, a meno
 * che non tenga un servizio in primo piano di tipo "microphone" acceso mentre
 * era ancora visibile. Senza, la dettatura si "fermava" appena il proprietario bloccava il
 * telefono o usciva dall'app. Questo servizio vive SOLO fra il tap che avvia la
 * registrazione e quello che la ferma (window.AndroidMic.start/stop, chiamati da
 * public/js/dictation.js). Nessun wake lock, START_NOT_STICKY. Se resta acceso
 * senza nessuna registrazione, la guardia lo spegne da solo (vedi sotto).
 *
 * Sostituisce ConnectionService, dormiente dal 16/08 e mai più avviato.
 */
public class MicService extends Service {

    public static final String CHANNEL_ID = "mic_recording";
    private static final int NOTIF_ID = 1513;

    public static final String ACTION_START = "mic.recording.START";
    public static final String ACTION_STOP  = "mic.recording.STOP";

    /*
     * Guardia contro il servizio orfano. Se la pagina che
     * l'ha acceso muore senza dire stop (ricaricamento, Activity distrutta,
     * pagina d'errore), nessuno lo spegne più e la Machine resta fra le «app
     * attive» di Samsung in sottofondo. Ogni 60 s si guarda se sul telefono
     * c'è una registrazione attiva: dopo 2 giri di fila senza, si spegne da
     * solo. Le API pubbliche non dicono DI CHI è la registrazione
     * (getClientUid è di sistema): si guarda il telefono intero, quindi una
     * presa viva della Machine non viene MAI spenta (al massimo un orfano
     * sopravvive finché un'altra app registra).
     */
    static final long GUARDIA_OGNI_MS = 60_000L;
    static final int GUARDIA_GIRI_MUTI = 2;
    private final Handler guardia = new Handler(Looper.getMainLooper());
    private int giriMuti = 0;
    private final Runnable controllo = new Runnable() {
        @Override public void run() {
            if (qualcunoRegistra()) giriMuti = 0; else giriMuti++;
            if (giriMuti >= GUARDIA_GIRI_MUTI) { spegni(); return; }
            guardia.postDelayed(this, GUARDIA_OGNI_MS);
        }
    };

    /** Nel dubbio (API vecchia, errore) risponde sì: la guardia non spegne mai alla cieca. */
    private boolean qualcunoRegistra() {
        if (Build.VERSION.SDK_INT < 24) return true;
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return true;
            List<AudioRecordingConfiguration> attive = am.getActiveRecordingConfigurations();
            return attive != null && !attive.isEmpty();
        } catch (Exception e) {
            return true;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = (intent != null && intent.getAction() != null) ? intent.getAction() : ACTION_STOP;
        if (ACTION_START.equals(action)) {
            try {
                createChannel();
                if (Build.VERSION.SDK_INT >= 30) {
                    startForeground(NOTIF_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
                } else {
                    startForeground(NOTIF_ID, buildNotification());
                }
                giriMuti = 0;
                guardia.removeCallbacks(controllo);
                guardia.postDelayed(controllo, GUARDIA_OGNI_MS);
                return START_NOT_STICKY;
            } catch (Exception ignored) { /* cade nel ramo stop */ }
        }
        spegni();
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        spegni();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        guardia.removeCallbacks(controllo);
        super.onDestroy();
    }

    private void spegni() {
        guardia.removeCallbacks(controllo);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Registrazione vocale", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        // «it takes several seconds for the notification»:
        // da Android 12 la notifica di un servizio in primo piano di tipo
        // microfono viene RIMANDATA fino a 10 s, a meno che l'app non chieda
        // di mostrarla subito. Il microfono è acceso da subito: deve dirlo da subito.
        if (Build.VERSION.SDK_INT >= 31) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        // Stessa icona di tutte le notifiche dell'app (11/10/2026), viola dell'accento.
        return b.setSmallIcon(R.drawable.ic_stat_machine)
                .setColor(0xFFA78BFA)
                .setContentTitle("The 151 Machine")
                .setContentText("Sto registrando — apri l'app e tocca il microfono per fermare")
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }
}
