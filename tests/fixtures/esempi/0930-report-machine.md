Ho trovato perché spariva il testo.

**Cosa succede.** La chat cerca il blocco delle scelte con una ricerca cieca su tutto il messaggio. Se una risposta nominasse `<options>` all'inizio e poi avesse il vero pezzo in fondo, la ricerca prenderebbe tutto quello che sta fra le due cose e lo toglierebbe, anche dal tasto Copia.

**Dove.** Nel file della chat che separa il testo dai bottoni: la stessa funzione serve la cronologia e la risposta che arriva in diretta.

**Riparazione che propongo.** Un pezzo solo che riconosce il vero blocco finale: su righe sue, fuori dai blocchi di codice, fatto solo di scelte. Tutto il resto resta testo. Aggiungo un tracciante che scrive nel registro quando un blocco viene tolto, così si vede subito se succede di nuovo.

**Prova.** Una prova pura con i messaggi di oggi: il prompt citato, questo resoconto, il messaggio con due bottoni e quello con sette scelte.

Sessioni: TIENI questa, finché la riparazione non è provata.

<options>
<option>Ripara il filtro dei bottoni + tracciante</option>
<option>Ripara solo il filtro</option>
<option>Per ora niente</option>
</options>