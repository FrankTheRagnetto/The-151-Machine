package com.the151universe.machine;

/**
 * Il giudice della sonda.
 *
 * Prima UNA sonda mancata (2,5 s, su un Wi-Fi che misurato dal PC perde il 3%
 * dei pacchetti e tocca 0,4–0,8 s) bastava a dire «PC giù» → tutto grigio,
 * e la sonda dopo lo riportava su. Adesso:
 *   · all'avvio (non so ancora niente) una mancata basta: niente attesa
 *     inutile quando il PC è davvero spento;
 *   · da «su», servono MANCATE_PER_GIU mancate DI FILA; una risposta buona
 *     azzera il conto.
 *   · giu() = certezza (la pagina principale non è arrivata): giù subito.
 *
 * [07/11/2026] Il telefono passa da Starlink: la
 * strada verso il PC cambia ~1 volta al minuto (220 cambi in un giorno,
 * journalctl tailscaled) con buchi di pochi secondi, e due mancate di fila
 * (~5 s) bastavano al grigio. Adesso da «su» servono ANCHE PAZIENZA_MS di
 * silenzio contati dalla PRIMA mancata della fila (non dall'ultima buona:
 * al rientro dall'app ferma un'ora non sarebbe pazienza). PC spento davvero
 * = grigio dopo ~12 s invece di ~5 s: il prezzo scelto.
 *
 * Java puro, niente Android: la prova lo compila e lo fa girare sul PC
 * (tests/sonda-due-colpi.test.js).
 */
final class GiudiceRete {

    static final int MANCATE_PER_GIU = 2;
    /** Silenzio minimo, dalla prima mancata della fila, prima del grigio. */
    static final long PAZIENZA_MS = 12000;

    private Boolean su = null;
    private int mancate = 0;
    private long primaMancata = 0;

    /** Una risposta della sonda. Ritorna lo stato nuovo (mai null). */
    synchronized Boolean segna(boolean ok) {
        return segna(ok, System.nanoTime() / 1_000_000L);
    }

    /** Come sopra, con l'orologio (monotono, in ms) dato da fuori: la prova. */
    synchronized Boolean segna(boolean ok, long oraMs) {
        if (ok) {
            mancate = 0;
            su = Boolean.TRUE;
        } else {
            if (mancate == 0) primaMancata = oraMs;
            mancate++;
            if (su == null
                || (mancate >= MANCATE_PER_GIU && oraMs - primaMancata >= PAZIENZA_MS)) {
                su = Boolean.FALSE;
            }
        }
        return su;
    }

    /** Certezza che il PC non c'è: giù subito. */
    synchronized Boolean giu() {
        mancate = MANCATE_PER_GIU;
        su = Boolean.FALSE;
        return su;
    }
}
