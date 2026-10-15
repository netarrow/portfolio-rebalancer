# UI Rework — piano operativo

> Branch: `ui-rework`. Approccio concordato: **i dati restano quelli attuali**
> (stesse chiavi `localStorage`, stesso `PortfolioContext`, stesse action).
> Si costruisce una seconda UI che legge/scrive **esclusivamente** tramite le
> action esistenti, con uno switch live per tornare alla UI classica in ogni
> momento. Le revisioni del modello dati (dove oggi esistono sovrapposizioni)
> arrivano *dopo*, una alla volta, a piccoli passi.

Mockup di riferimento (Artifact, privati — condividere dal menu Share se
servono a terzi):

- Nuova UI (canvas): https://claude.ai/code/artifact/7b2e6e83-4747-44f3-9b6d-be07d34dd9ea
- Mappa delle dipendenze della UI attuale: https://claude.ai/code/artifact/a1250c0f-a31b-45cd-81fb-d07349e295bd

Un PDF con gli stessi mockup verrà caricato per procedere all'implementazione.

---

## 0. Principio guida

La nuova UI è **un secondo modo di presentare gli stessi dati**. Ogni pagina
nuova:

1. legge dal `PortfolioContext` con gli stessi hook di oggi (`usePortfolio()`);
2. scrive **solo** chiamando le action che esistono già (`addTransaction`,
   `updatePortfolio`, `setYnabMapping`, ecc.) — mai una nuova chiave
   `localStorage` che la UI classica non sappia interpretare, salvo le
   eccezioni esplicitamente segnalate come "solo preferenza schermo" (vedi
   §1) o "coda in-memory" (vedi §2, fase U5).

Questo garantisce che le due UI non possano mai divergere sui dati: sono lo
stesso state, letto in due modi.

---

## 1. Switch live tra UI classica e nuova

- **Preferenza per dispositivo**, non per dato: `pr_ui_mode` = `classic` |
  `next` in `localStorage`. **Esclusa dal backup JSON e dal sync Azure**
  (va aggiunta alla lista delle chiavi local-only, come `portfolio_premium_price_key`).
- **Override da URL**: `?ui=next` / `?ui=classic` — utile per test e screenshot
  senza toccare la preferenza salvata.
- **`App.tsx`**:
  - restano in comune `SecurityProvider`, `UnlockGate`, `PortfolioProvider`;
  - sotto, si monta `<ClassicApp/>` (l'attuale `renderView`, spostato
    così com'è in un file proprio) oppure `<NextApp/>`, caricata con
    `React.lazy` così il bundle classico non cresce quando non serve;
  - un bottone "Prova la nuova interfaccia / Torna alla classica" nell'header
    di entrambe.
- **Corrispondenza delle pagine**: tabella `viewMap` che collega ogni vista
  classica (`View` in `App.tsx`) al percorso corrispondente nella UI nuova,
  così cambiando UI si resta nello stesso punto logico.
- **Router nella UI nuova**: leggero, a hash (`#/strategia/portafogli`), oggi
  assente — va introdotto solo lì, senza toccare la UI classica.
- **Default finale**: quando la nuova UI è pronta, il default si sposta con
  una variabile letta dal server (`DEFAULT_UI`, esposta da un nuovo
  `GET /api/version`). È l'unica modifica lato server prevista in questo
  piano.
- **Stili**: la UI nuova vive sotto una classe radice (es. `.next-ui`) e
  riusa i token di `src/styles/variables.css`. I componenti classici
  incorporati per riuso mantengono il proprio CSS invariato.

---

## 2. Le fasi (dati invariati)

| Fase | Contenuto | Risultato | Dimensione |
|---|---|---|---|
| **U0** | `npm run verify` che lancia i 28 script `scripts/verify-*.ts`; job CI dedicato prima della build Docker; `scripts/take_screenshots.js` esteso per fotografare **entrambe** le UI sul mock | Ogni PR dimostra che i numeri non cambiano | S |
| **U1** | `NextApp`: menu laterale **Decidere / Agire / Capire / Fonti**, router a hash, layout mobile; ogni voce **incorpora la pagina classica** corrispondente (nessun contenuto nuovo ancora) | UI nuova completa e usabile dal primo giorno, anche se "vuota" dentro | M |
| **U2** | Composizione delle pagine esistenti nelle nuove sezioni: YNAB a schede (Categorie = mapping+funding, Conti = Off-budget, Spesa = Summary, Connessione = card estratta da Settings); Capire = Stats+Performance+Forecast; Dati = Transazioni+Portafogli+Broker; Strategia v1 a schede (Livelli = Goal flows, Portafogli = Asset Allocation, Gruppi, Asset) | Struttura del mockup presente, con contenuti riusati | M |
| **U3** | Estrazione di funzioni di lettura pure in `src/readModels/` (leggono i dati attuali, zero scrittura); test che confrontano i numeri con la UI classica; poi **Home**: KPI, lista "Da fare", scadenze | La pagina più utile del mockup è viva | M |
| **U4** | Pagine ridisegnate sui dati di oggi: Obiettivi, Liquidità, Piani, Strategia v2, YNAB → Categorie (dettaglio sotto) | Le pagine del mockup, senza nuovi dati | L |
| **U5** | Operazioni v1: il motore già a catena di Fund Relocation diventa la pagina Operazioni, con Withdrawal e Spend come preset; la coda vive in **contesto UI** (sopravvive al cambio pagina, ma non è salvata su disco finché non arriva R3) | Coda funzionante per relocation, withdrawal, spend | M |
| **U6** | Confronto finale screenshot + numeri tra le due UI; `DEFAULT_UI=next`; classica raggiungibile con `?ui=classic` | Nuova UI predefinita, ritorno sempre possibile | S |

### Dettaglio U3 — fonti della Home

| Avviso | Da dove legge oggi |
|---|---|
| Scostamento dai target | Calcoli di `AllocationOverview` / `groupRebalance`, estratti in funzione pura |
| Rata PAC in scadenza | `utils/pacSchedule.ts` → `generateInstalments` |
| Virtual bond in finestra | `virtualBonds` + finestra mesi del bond |
| Interessi da accreditare | `utils/brokerRemuneration.ts` |
| Obiettivo scoperto | `components/YnabGoals/goalRows.ts` → `buildGoalRow` |
| Flag Free mancante | `utils/freeCommissions.ts` (stessa logica della lista transazioni) |
| Saldo YNAB da riallineare | Richiede chiamata a YNAB: mostrato come "da verificare", apre la modal esistente (`BrokerLiquiditySyncModal`) |

### Dettaglio U4 — pagine ridisegnate, zero dati nuovi

- **Obiettivi** — lista e dettaglio su `goalRows`; riusa `GoalSetupModal` e
  `AllocationModal`; i toggle "Includi nelle proiezioni" / "Può usare la
  liquidità" scrivono `enabled` / `erosionAllowed` di `plannedForecastExpenses`
  (esistono già); "Dove si usa" è calcolato, non salvato.
- **Liquidità** — `useYnabCoverage` (in `components/YnabImport/useYnabCoverage.ts`)
  calcola già liquidità per conto, working capital e fondo d'emergenza; sopra
  si aggiungono minimi/accantonamenti/remunerazione broker; azioni riusano
  `BrokerLiquiditySyncModal`.
- **Piani** — tabella su `pacPlans` + `ynabMappings` (tipo asset/portafoglio);
  modifica apre i form esistenti (`PacPlanForm`, riga di mapping YNAB).
- **Strategia v2** — cascata **in sola lettura** sui valori di oggi; i
  conflitti (es. target di Goal flows ≠ target per livello in Settings)
  compaiono come badge informativi, non si risolvono qui; le modifiche
  passano dalle action attuali.
- **YNAB → Categorie** — editor "una riga per categoria" che chiama setter
  già esistenti: `setYnabMapping`, `setYnabMappingSource`,
  `setYnabMappingEmergency`, `setYnabCategoryMacro`, `ensureCategoryGoal`.

**Cosa resta fuori finché non si toccano i dati**: coda salvata unica per
tutti i tipi di mossa (ribilanciamento/funding/PAC restano eseguiti dalle
loro pagine, solo collegati dalla coda), piani con un obiettivo come
destinazione diretta, valori unificati (si vedono i conflitti, non si
risolvono).

---

## 3. Revisioni dati — dopo, una alla volta

Ogni revisione è una PR indipendente con lo stesso schema:

- un numero di versione per quell'area;
- una migrazione **idempotente** al caricamento;
- backup che accetta i file vecchi (retro-compatibilità su `BackupData` /
  `parseBackupData` in `src/utils/backupPayload.ts`, oggi a `BACKUP_VERSION = 7`);
- uno script `verify-*` dedicato in `scripts/`.

**Regola d'oro**: finché la UI classica esiste, ogni revisione deve
funzionare in **entrambe**. Additive subito, strutturali dopo U6.

| # | Revisione | Tipo | Quando | Incoerenza che risolve |
|---|---|---|---|---|
| R1 | Aliquote fiscali in una tabella sola | Solo codice | Subito | Cash tassato 12,5% in un posto, 26% in un altro (`withdrawalCalculations.ts` vs `portfolioCalculations.ts:539`) |
| R2 | Fondo d'emergenza con una regola sola | Solo codice | Subito | Summary (costante fissa) vs Coverage YNAB (`emergencyMonths`) vs target % di Protection: tre cifre scollegate |
| R3 | Coda operazioni salvata (`pr_ops_queue_v1`) + adapter per ribilanciamento/funding/PAC | Additiva | Dopo U5 | — |
| R4 | Avvisi di coerenza (sola lettura): cash+allocazioni ≠ target obiettivo; € Asset Allocation ≠ somma target in €; virtual bond che scade dopo l'obiettivo; `portfolio.liquidity` > cash libero del broker | Solo lettura | Anche durante U4 | Tutti i 13 punti elencati in §4 |
| R5 | Forecast legge gli obiettivi direttamente (niente più copia `plannedForecastExpenses`) | Migrazione | Dopo U6 | Copia che diverge dal sync |
| R6 | Copertura obiettivi in unità per tutti (estende `ynabGoalQuotes` oltre il solo caso migrato) + accredito dalle operazioni | Migrazione | Dopo R3 | Tre misure diverse di "quanto è investito" |
| R7 | Cascata target: un solo target per livello; Asset Allocation come override | Migrazione + wizard | Dopo U6 | Growth/Protection/Security con due classificazioni diverse |
| R8 | `portfolio.liquidity` → accantonamento sul broker preferito | Migrazione + wizard | Dopo U6 | Due campi cash per portafoglio non collegati |
| R9 | Collegamento YNAB unico per conto; piani unificati (PAC + mapping) | Migrazione | Ultime | 4 tabelle di mapping broker↔YNAB oggi scollegate |

---

## 4. Le 13 incoerenze note (promemoria per R4 e seguenti)

🔴 Cambiano le decisioni:
1. Due target indipendenti per lo stesso livello (Settings per-classe-asset vs Goal flows `goal_mode_targets`).
2. Dimensione di un portafoglio dichiarata in 3 modi scollegati (Asset Allocation, Goal flows, somma target in €).
3. Target dell'obiettivo YNAB non collegato al target delle allocazioni sulla riga del portafoglio.
4. "Chi finanzia una spesa" dichiarato due volte (allocazioni YNAB Goals vs `allowedGoalIds` nel Forecast).

🟠 Copie che divergono nel tempo:
5. `PlannedForecastExpense` copia importo/data dall'obiettivo YNAB.
6. Scadenza virtual bond (propria) vs scadenza dell'obiettivo collegato.
7. Tre misure di "quanto è investito": allocazioni €, unità congelate, solo-cash (Summary).
8. `portfolio.liquidity` (manuale) vs `liquidityAllocations` (accantonamento broker reale).

🟡 Regole duplicate:
9. Fondo d'emergenza: 3 definizioni (Summary, Coverage YNAB, target % Protection).
10. Target di liquidità: 3 fonti (Asset Allocation, minimi broker, working capital YNAB).
11. Mix macro non collegato ai target reali dei portafogli.
12. Broker scelto separatamente per rebalance, PAC, mapping YNAB.
13. Aliquote fiscali in due posti (vedi R1).

---

## 5. Prossimi passi immediati

1. Caricare il PDF con i mockup (in arrivo) e allinearlo a questo file.
2. PR 1: **U0** — script `npm run verify` + job CI.
3. PR 2: **U1** — shell `NextApp` + switch `pr_ui_mode` + `viewMap`.
4. In parallelo, quando comodo: **R1** e **R2** (piccole, non toccano la UI).
5. Poi U2 → U3 (Home) → U4 → U5 → U6, nell'ordine preferito.

Tutto il lavoro di questa branch (`ui-rework`) deve poter convivere con
`main` senza conflitti di dati: ogni merge intermedio lascia l'app
funzionante sia in UI classica sia nuova.
