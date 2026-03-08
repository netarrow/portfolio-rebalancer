# Piano responsive: sezione Global Rebalancing (focus iPhone 12 Safari)

## Obiettivo
Rendere la sezione **Global Rebalancing** pienamente leggibile e operabile su mobile (focus iPhone 12, Safari), mantenendo invariato il comportamento desktop e riducendo il rischio regressioni con media query progressive.

## Stato attuale (sintesi)
- Layout a card con tabella larga (`min-width: 1100px`) e scroll orizzontale.
- Presente una sola media query a `max-width: 768px` con interventi minimi.
- Rischi su mobile:
  - eccessivo scroll orizzontale e perdita di contesto colonne;
  - densità elevata dei contenuti nei campi input e metriche;
  - possibili criticità Safari iOS su font-size/input zoom e viewport dinamico.

## Strategia generale
Applicare un approccio **desktop-first con scaling progressivo**:
1. mantenere lo stile desktop come baseline;
2. introdurre breakpoints mirati (1024, 768, 430/390 px);
3. convertire la tabella in una vista “card/stacked rows” solo su smartphone;
4. ottimizzare controlli touch e tipografia per Safari iOS;
5. validare con checklist visuale + funzionale su iPhone 12.

---

## Piano operativo

### Fase 1 — Audit UI e mappatura vincoli
- Inventariare gli elementi della pagina:
  - hero + metric cards;
  - input importo + CTA;
  - warning/error;
  - tabella distribuzione con 11 colonne.
- Definire i contenuti “must-have” su mobile senza overflow critico:
  - Include, Portfolio, Suggested EUR, Target/Projected Weight come priorità;
  - valori secondari in dettaglio espandibile.
- Verificare se esistono token CSS riutilizzabili (`--space-*`, `--radius-*`, font scale).

### Fase 2 — Breakpoint e scala tipografica/spaziature
Introdurre media query progressive:
- **<= 1024px (tablet/landscape):**
  - riduzione padding card;
  - griglia metriche più compatta (`minmax` più basso);
  - font leggermente ridotto su label e tabelle.
- **<= 768px (mobile generico):**
  - CTA full-width;
  - stack verticale completo dei blocchi con gap ridotti;
  - textarea/input con altezza touch-friendly.
- **<= 430px (iPhone 12/13/14 width class):**
  - ottimizzazione puntuale: font-size minimo 16px sui campi input per evitare zoom automatico Safari;
  - riduzione ulteriore padding e spazi verticali;
  - metric cards a 1 colonna.

### Fase 3 — Refactor tabella per mobile
- Mantenere tabella classica per desktop/tablet.
- Su smartphone, passare a visualizzazione alternativa:
  - ogni portfolio come card;
  - intestazioni rese esplicite per ogni valore (label + value);
  - checkbox/include e input peso in testa card;
  - evidenza di `Suggested EUR` e stato esclusione.
- Opzione intermedia (se si evita refactor markup):
  - mantenere tabella ma usare `position: sticky` su prime colonne + dimensioni colonna compatte.
- Preferenza consigliata: **card mobile** (migliore UX iPhone/Safari).

### Fase 4 — Hardening Safari iOS
- Garantire:
  - `font-size >= 16px` su `input/textarea/select`;
  - niente layout dipendenti da `100vh` statico;
  - test con tastiera aperta (focus input importo/peso);
  - controlli touch con area minima ~44px.
- Verificare rendering di numeri lunghi valuta e percentuali con wrapping controllato.

### Fase 5 — QA e anti-regressione
- Snapshot visuali su:
  - Desktop ≥ 1280px;
  - Tablet ~768–1024px;
  - iPhone 12 Safari (390x844 CSS px).
- Test funzionali:
  - edit peso portfolio;
  - include/exclude portfolio;
  - inserimento importo e apply distribution;
  - messaggi warning/blocking.
- Criteri di accettazione:
  - nessun overflow bloccante orizzontale su iPhone 12;
  - azioni principali raggiungibili senza zoom;
  - layout desktop invariato (solo ritocchi non regressivi).

---

## Deliverable suggeriti
1. Aggiornamento CSS nel componente `GlobalRebalancingView` con nuovi breakpoint.
2. Eventuale variante markup mobile per riga tabella -> card.
3. Breve guida QA con matrice dispositivi/breakpoint.
4. Screenshot comparativi desktop vs iPhone 12 Safari.

## Stima effort indicativa
- Solo tuning CSS + tabella scrollabile: **0.5–1 giorno**.
- Refactor tabella in card mobile + QA completo: **1.5–2.5 giorni**.

## Rischi principali
- Complessità della tabella (11 colonne) su schermi stretti.
- Possibili regressioni visive nei breakpoint intermedi.
- Edge case di formattazione importi/percentuali su locale differenti.

## Mitigazioni
- Introdurre cambi incrementalmente per breakpoint.
- Feature flag CSS/marcatori classi per attivare il layout mobile in modo controllato.
- Verifica screenshot e test manuale su Safari iOS reale/simulato prima merge.
