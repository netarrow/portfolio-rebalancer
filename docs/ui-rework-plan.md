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

Un PDF con gli stessi mockup è in `docs/mock-ui-rework.pdf` (local-only, escluso
da git); il confronto pagina per pagina con le fasi è in §2b.

**Fonte primaria per l'implementazione: il canvas, non il PDF.** Il canvas
contiene il sorgente di ogni pagina (struttura, dati di esempio, colori,
font Figtree + JetBrains Mono, link tra pagine), leggibile file per file:

| File nel canvas | Pagina | Note |
|---|---|---|
| `project/Sidebar.dc.html` | Menu (componente) | Importato da tutte le pagine con `active=…` |
| `project/Main.dc.html` | Home · Cosa fare ora | |
| `project/Strategia.dc.html` | Strategia · target a cascata | "Porta a target" → Operazioni; rimanda a Obiettivi e Liquidità |
| `project/Obiettivi.dc.html` | Obiettivi · lista unica | |
| `project/Operazioni.dc.html` | Operazioni · coda unica | |
| `project/Piani.dc.html` | Piani · PAC e funding | Sorgente "Budget" o "Cash", qualunque sia l'integrazione |
| `project/Liquidita.dc.html` | Liquidità · politiche per conto | |
| `project/Spese.dc.html` | Spese · per natura | Capire; voci da YNAB o manuali, natura, "Gestita in" → Obiettivi/Piani |
| `project/Impostazioni.dc.html` | Impostazioni · integrazioni | YNAB (connessione, cosa importa, collegamento conti) + Prezzi di mercato |
| `project/AsIs*.dc.html` | Pagina canvas "As-is (U2)" | Le 11 voci con sole pagine classiche, vedi §2c |

Patrimonio, Proiezioni e Dati non hanno pagina disegnata: esistono solo
come voci di menu (coerente con U2, che lì incorpora le pagine classiche).
Di Impostazioni è disegnata solo la scheda Integrazioni; le altre schede
restano quelle classiche.

### Note di progetto del canvas (non presenti nel PDF)

Descrivono lo **stato finale** di ogni pagina, cioè dopo le revisioni dati
indicate tra parentesi (vedi §2b e §3):

- **Home** — Dashboard alleggerita: KPI + una sola lista degli avvisi oggi
  sparsi (scostamenti, rate PAC, virtual bond da concretizzare, interessi,
  saldi YNAB, flag Free mancanti); ogni avviso apre la pagina giusta già
  compilata.
- **Strategia** — unisce target macro e per goal (Settings), Goal flows
  (Fund Relocation), Asset Allocation e rapporto parent/child; un solo
  archivio per livello; il mix macro diventa un controllo derivato e la
  piramide per classe di asset sparisce come target (**R7**).
- **Obiettivi** — unisce YNAB Goals, spese pianificate del Forecast, target
  in € dei portafogli e soglie del Summary; copertura = cash + investito in
  unità, una sola misura per tutte le pagine (**R6**); il Forecast legge da
  qui senza copia (**R5**).
- **Operazioni** — coda unica: ribilanciamento, Relocation, Withdrawal,
  funding YNAB e rate PAC aggiungono mosse qui; un solo prezzo, un solo
  prima/dopo, un solo Esegui che aggiorna anche la copertura degli
  Obiettivi (**R3**, **R6**).
- **Piani** — unisce PAC e categorie di budget → asset/portafoglio/obiettivo
  (sorgente, destinazione, frequenza); che la sorgente sia una categoria YNAB
  o cash su un conto, il piano è lo stesso; il Forecast li usa per proiettare
  gli investimenti futuri (**R9**, **R5**).
- **Liquidità** — unisce minimo broker, accantonamenti (portafogli, PAC,
  virtual bond), working capital YNAB, target liquidità di Asset Allocation
  e fondo d'emergenza = target del livello Protection (**R2**, **R8**).
- **Spese** — il concetto astratto dietro Summary e la natura delle
  categorie YNAB: ogni voce ha natura, conto e fonte (YNAB o manuale);
  alimenta fondo d'emergenza, target Protection e uscite delle Proiezioni;
  accantonamenti e investimenti restano visibili per la natura ma si
  gestiscono in Obiettivi e Piani (**R11**, **R2**).
- **Impostazioni › Integrazioni** — YNAB non è più una pagina: connessione,
  "cosa porta nell'app" (categorie di spesa → Spese, categorie con obiettivo
  → Obiettivi, categorie da investire → Piani, conti on/off-budget →
  Liquidità) e collegamento dei conti (un solo collegamento per broker —
  on-budget, off-budget, permesso di scrittura, **R9**). Disattivare YNAB
  lascia obiettivi, spese e piani come voci manuali (**R11**).

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

### 0b. Concetti astratti, integrazioni come fonti

Le pagine di **Decidere / Agire / Capire** lavorano solo su concetti
astratti — **Obiettivi, Spese, Piani, Conti** — indipendentemente dal fatto
che siano creati nell'app o arrivino da YNAB. YNAB è un'**integrazione**
configurata in **Impostazioni › Integrazioni** (connessione, cosa importare,
collegamento dei conti), non una pagina di menu. Nelle pagine la fonte
compare solo come etichetta (badge "YNAB" / "Manuale", filtro per fonte).

Conseguenze pratiche:

- nessuna pagina nuova importa da `components/YnabImport/*` per decidere
  *cosa* mostrare: legge dai read model di §2 (U3), che espongono obiettivi,
  spese, piani e conti già normalizzati con un campo `source`;
- le action YNAB esistenti (`setYnabMapping`, `setYnabCategoryMacro`, …)
  restano dietro funzioni con nomi di dominio (es. "imposta natura della
  spesa", "imposta destinazione del piano") così domani una seconda fonte
  può avere lo stesso contratto;
- i testi evitano "categoria YNAB" dove basta "voce di spesa" / "categoria
  di budget".

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
| **U1** | `NextApp`: menu laterale **Decidere / Agire / Capire / Fonti** (Capire = Patrimonio, Spese, Proiezioni; Fonti = Dati, Impostazioni — YNAB non ha voce propria), router a hash, layout mobile; ogni voce **incorpora la pagina classica** corrispondente (nessun contenuto nuovo ancora) | UI nuova completa e usabile dal primo giorno, anche se "vuota" dentro | M |
| **U2** | Composizione delle pagine esistenti nelle nuove sezioni, smontando la pagina YNAB: natura categorie + Summary → **Spese**; mapping + funding → **Piani**; YNAB Goals → **Obiettivi**; coverage e saldi → **Liquidità**; connessione, Off-budget e collegamento conti → **Impostazioni › Integrazioni**; Capire = Patrimonio (Stats+Performance), Spese e Proiezioni (Forecast); Dati = Transazioni+Portafogli+Broker; Strategia v1 a schede (Livelli = Goal flows, Portafogli = Asset Allocation, Gruppi, Asset) | Struttura del mockup presente, con contenuti riusati | M |
| **U3** | Estrazione di funzioni di lettura pure in `src/readModels/` (leggono i dati attuali, zero scrittura); test che confrontano i numeri con la UI classica; poi **Home**: KPI, lista "Da fare", scadenze | La pagina più utile del mockup è viva | M |
| **U4** | Pagine ridisegnate sui dati di oggi: Obiettivi, Liquidità, Piani, Spese, Strategia v2, Impostazioni › Integrazioni (dettaglio sotto) | Le pagine del mockup, senza nuovi dati | L |
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
| Saldo conto da riallineare (fonte YNAB) | Richiede chiamata all'integrazione: mostrato come "da verificare", apre la modal esistente (`BrokerLiquiditySyncModal`) |

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
- **Spese** — una riga per voce con natura, conto e fonte; la natura si
  imposta con `setYnabCategoryMacro` (oggi solo per voci da YNAB); medie dal
  Summary. Le voci manuali richiedono **R11**.
- **Editor ex "YNAB → Categorie", ridistribuito** — gli stessi setter già
  esistenti, chiamati dalla pagina del concetto: destinazione e conto di
  partenza in **Piani** (`setYnabMapping`, `setYnabMappingSource`,
  `setYnabMappingEmergency`); natura in **Spese** (`setYnabCategoryMacro`);
  obiettivo in **Obiettivi** (`ensureCategoryGoal`).
- **Impostazioni › Integrazioni** — card YNAB estratta da Settings,
  tabella "cosa porta nell'app" (sola lettura + toggle che esistono già),
  collegamento conti con la modal Off-budget esistente.

**Cosa resta fuori finché non si toccano i dati**: coda salvata unica per
tutti i tipi di mossa (ribilanciamento/funding/PAC restano eseguiti dalle
loro pagine, solo collegati dalla coda), piani con un obiettivo come
destinazione diretta, valori unificati (si vedono i conflitti, non si
risolvono).

---

## 2b. Mockup vs fasi

Confronto pagina per pagina tra il mockup (`docs/mock-ui-rework.pdf`, 8
pagine, local-only) e le fasi. Per ogni pagina: cosa arriva con la sola UI
(dati invariati) e cosa richiede una revisione dati. Fino a quella revisione,
la parte "R" si mostra in forma ridotta (sola lettura, badge o link alla
pagina classica), mai con una chiave nuova.

| Pagina mockup | Con la sola UI | Serve una revisione | Note |
|---|---|---|---|
| **Menu** (Home · Decidere · Agire · Capire · Fonti) | **U1** | — | Capire = **Patrimonio** (Stats + Performance), **Spese**, **Proiezioni** (Forecast); Fonti = **Dati**, **Impostazioni**. Nessuna voce YNAB (§0b) |
| **Home** — KPI, chip di scope Tutti/Famiglia/Persona A, "Da fare", livelli vs target, prossime scadenze | **U3** | — | I chip riusano i Counting-scope esistenti (`scoped*` nel contesto) |
| **Home** — card "Coda operazioni" con commissioni e tasse | **U5** (coda in memoria) | **R3** per la persistenza | Prima di U5 la card non c'è, o mostra solo il link a Fund Relocation |
| **Strategia** — cascata Livelli → Portafogli → Gruppi → Asset, valori attuali e scostamenti | **U4** (sola lettura) | — | I conflitti tra le fonti di target si vedono come badge (incoerenze 1 e 2) |
| **Strategia** — "ogni target si imposta in un posto solo", regola per portafoglio (Eredita / Bloccato / Da Obiettivi / Escluso) | — | **R7** | Fino ad R7 le modifiche aprono gli editor attuali (Settings, Goal flows, Asset Allocation) |
| **Strategia** — mix per classe implicito + avviso "tetto azioni 60%" | Mix implicito: **U4** (calcolato) | Tetto: **dato nuovo** | Oggi non esiste un tetto per classe: da aggiungere come revisione additiva (R10, vedi sotto) |
| **Strategia** — "Porta a target · N mosse in coda" | **U5** (in coda solo il link al ribilanciamento) | **R3** | Ribilanciamento come mossa vera della coda solo con l'adapter di R3 |
| **Obiettivi** — lista, %, cash / investito / mancante, "Dove si usa", toggle | **U4** | — | Toggle = `enabled` / `erosionAllowed` di `plannedForecastExpenses` |
| **Obiettivi** — copertura per strumento in **lotti detenuti** + "gli acquisti dalla coda aggiungono unità" | Solo per gli obiettivi già migrati a `ynabGoalQuotes` | **R6** (+ R3 per l'accredito dalla coda) | Altrimenti si mostra la copertura in € delle allocazioni |
| **Obiettivi** — obiettivo "Manuale" vs "YNAB", "Nuovo obiettivo" | **U4** | **R5** per una fonte unica | Fino a R5 il manuale è una `PlannedForecastExpense` senza categoria YNAB |
| **Operazioni** — passi ordinati vendi → bonifica → compra, costi, prima/dopo, avviso cash negativo | **U5** per relocation / withdrawal / spend | — | Motore a catena di Fund Relocation già esistente |
| **Operazioni** — un'unica coda che mescola Ribilancia + Funding YNAB + Rata PAC | — | **R3** | Fino ad R3 ribilanciamento, funding e PAC restano eseguiti dalle loro pagine, solo collegati |
| **Piani** — tabella PAC + mapping YNAB, stato e prossima data | **U4** | — | Modifica = `PacPlanForm` / riga di mapping YNAB |
| **Piani** — "Nuovo piano" con Da (categoria / cash) → Verso (asset / portafoglio / obiettivo / cash) | Editor separati per tipo | **R9** | Un piano unico per tutte le combinazioni arriva con R9 |
| **Piani** — obiettivo come destinazione diretta | Solo via amount-targets già esistenti (mapping YNAB → obiettivo) | **R9** | — |
| **Piani** — "Nelle Proiezioni" (il Forecast usa i piani) + stima "arriva al 100% a …" | Stima: **U4** (calcolata) | **R5** | Fino a R5 il Forecast tratta il risparmio come oggi |
| **Liquidità** — fondo d'emergenza = target Protection | **U4** con i valori di Coverage YNAB | **R2** | Finché R2 non c'è, le tre cifre (Summary, Coverage, Protection) si mostrano con un badge |
| **Liquidità** — soglie | "Emergenza in mesi", "Capitale circolante": **U4** (`emergencyMonths`, `workingCapitalMonths`); "Obiettivi cash entro N mesi" ≈ `goalHorizonMonths` | "Fascia Security entro 7 anni": **dato nuovo** (R10) | Da verificare se `goalHorizonMonths` coincide con "obiettivi cash" |
| **Liquidità** — tabella conti (saldo, minimo, circolante, obiettivi in cash, riservato, libero, rendimento) | **U4** (`useYnabCoverage` + minimi + `brokerRemuneration`) | **R8** per il "riservato" a portafoglio | Fino a R8 "riservato" = `portfolio.liquidity` con il badge dell'incoerenza 8 |
| **Spese** — KPI entrate/uscite, una riga per voce con natura e fonte, mix per natura, "Dove si usa" | **U2** (Summary incorporato), **U4** (pagina ridisegnata, voci YNAB) | **R11** per voci manuali e per non dipendere dallo storico local-only | Oggi lo storico spese del Summary è solo locale: su un dispositivo senza import la pagina è vuota |
| **Impostazioni › Integrazioni** — card YNAB e Prezzi, "cosa porta nell'app", collegamento conti, connessione | **U2** (card estratta da Settings), **U4** (tabella "cosa porta") | **R9** per il collegamento unico per conto; **R11** per "disattiva → restano manuali" | Il toggle "Importa" per tipo è nuovo: fino a R11 è sola lettura |
| **Dati** — Transazioni · Portafogli · Broker | **U2** | — | Pagine classiche incorporate |

**Nuova revisione emersa dal mockup:**

| # | Revisione | Tipo | Quando | Cosa aggiunge |
|---|---|---|---|---|
| R10 | Soglie di strategia: tetto per classe (es. azioni ≤ 60%) e fascia temporale Security (es. obiettivi entro 7 anni) | Additiva | Anche durante U4 | Due impostazioni nuove, sincronizzate e nel backup; la UI classica le ignora senza effetti |
| R11 | Spese e obiettivi indipendenti dalla fonte: voci di spesa manuali, medie spese sincronizzate (non solo storico locale), campo `source` su obiettivi/spese/piani; disattivare un'integrazione converte le sue voci in manuali | Additiva | Dopo U4 | Rende vera la regola di §0b: oggi Summary e natura esistono solo per categorie YNAB |

---

## 2c. Pagine classiche → UI nuova (stato a fine U2)

Il canvas ha una seconda pagina, **"As-is (U2)"**: le 11 voci del menu nuovo
riempite **solo** con le pagine classiche di oggi, ognuna con l'etichetta
"da …" della sezione di origine e i numeri del mock dell'app (Load Mock
Data). È il riferimento per implementare U1–U2. File: `project/AsIs*.dc.html`,
componenti riusati `AsIsTable` / `AsIsKpis`; il menu (`Sidebar`) ha la
variante `variant="asis"`.

Collocazione di tutte le 17 viste di `View` in `App.tsx` (è anche la base
della `viewMap` di §1):

| Vista classica (`View`) | Voce nuova › scheda | Note |
|---|---|---|
| `dashboard` — SummaryCards, BrokerPerformance | Home | In U3 la Home diventa la lista "Da fare" |
| `dashboard` — AllocationOverview (tabelle per portafoglio, Exec Full/Buy Only, popover costi) | Strategia › Asset | Gli "Exec" in U5 mettono in coda |
| `dashboard` — Simulate Withdrawal | Operazioni › Prelievo | Oggi è una modal |
| `dashboard` — Goal matching, virtual bond "Concretizza" | Obiettivi › Copertura con bond | |
| `dashboard` — ∑ Aggregate | Patrimonio › Posizioni | |
| `goals` (Growth / Protection / Security) | Strategia › Livelli | **Rinominati "Livelli"**: non sono obiettivi |
| `settings` — Macro & Goal Targets | Strategia › Livelli | Secondo archivio target per livello (incoerenza 1) |
| `fundRelocation` — Goal flows | Strategia › Livelli (barra) + Operazioni (mosse) | |
| `fundRelocation` — Portfolios in play, sequenza, From/To/Spend, costi, bonifici | Operazioni › Sposta fondi | |
| `globalRebalancing` (Asset Allocation) | Strategia › Portafogli | |
| `portfolios` — group ratio, market group | Strategia › Gruppi (lettura) · Dati › Portafogli (modifica) | |
| `portfolios` — card, virtual bond, Define New Asset | Dati › Portafogli | |
| `transactions` | Dati › Transazioni | Update Prices anche in Impostazioni › Integrazioni |
| `brokers` — card, commissioni, remunerazione | Dati › Broker | |
| `brokers` — Update liquidity | Liquidità | |
| `stats` | Patrimonio › Distribuzione | |
| `performance` | Patrimonio › Performance | |
| `summary` | Spese | |
| `forecast` | Proiezioni (+ spese pianificate visibili in Obiettivi) | |
| `pac` | Piani › PAC | Piani + rate (Confirm / Skip / Undo) |
| `ynab` — Category mappings Funding, Funding plan, what-if | Piani › Funding da budget | |
| `ynab` — Location & nature | Spese (natura) · Liquidità (dove sta) | |
| `ynab` — Liquidity & coverage | Liquidità | |
| `ynab` — Investment Goals sync | Impostazioni › Integrazioni | |
| `ynabGoals` | Obiettivi | |
| `ynabTracking` (Off-budget) | Impostazioni › Integrazioni | Avvisi "da verificare" → Home |
| `settings` — People, Asset Registry | Impostazioni › Generale | |
| `settings` — Free Buy Promotions | Impostazioni › Broker e promozioni | |
| `settings` — YNAB, Private Update Price, Price History | Impostazioni › Integrazioni | |
| `settings` — Cloud Sync, encryption, Data management, Dev tools, Danger zone | Impostazioni › Backup e sicurezza | |
| `disclaimer` | Impostazioni › Info | + link fisso nel menu |

### Controllo: cosa manca nella pagina Target del canvas

Funzioni che esistono oggi e che le pagine Target non mostrano ancora (vanno
disegnate o almeno previste prima di U4):

1. **Esecuzione del ribilanciamento per portafoglio** (tabella Action / Post
   Act / Buy Only, scelta broker e liquidità, popover costi): Strategia Target
   mostra solo "attuale / target" al passo 4.
2. **Rate PAC** (Confirm / Skip / Undo, residuo parcheggiato): Piani Target ha
   solo la tabella dei piani.
3. **Opzioni del funding plan** (fondi da, taglio ordini, conto del bonifico,
   arrotondamento, soglia commissioni): Operazioni Target le dà per scontate.
4. **Prelievo** e **Spesa** come preset di Operazioni: citati nel piano, non
   disegnati.
5. **Patrimonio, Proiezioni, Dati**: nessuna pagina Target (as-is = classico).
6. **Allocation Simulator** di Stats (cursori, non scrive): nessuna casa nel Target.
7. **Off-budget YNAB** (migrazione, rivalutazione, write-back log) e **Investment
   Goals sync**: solo accennati in Impostazioni Target.
8. **Counting scope**: oggi ripetuto su 6 pagine; nel Target c'è solo in Home
   (con nomi diversi). Proposta: un solo selettore globale in alto.
9. **Disclaimer**, **schermata di sblocco** (encryption), **Load Mock Data**.

### Controllo: incoerenze visibili sul mock dell'app

- Protection ha tre target sullo stesso mock: 42% in Goal flows (≈ €75.600),
  15% di Safety Net in Asset Allocation (€27.006), fondo protezione ≥ €9.940 nel
  Summary (incoerenze 1 e 9).
- Goal Ladder è "Locked at current" (€7.836) in Asset Allocation ma il goal
  matching gli assegna target per €23.000 (incoerenza 2).
- "Quanto cash tenere": 10% del totale (€18.004) in Asset Allocation, minimi
  broker €7.000, protection fund €9.940 (incoerenza 10).
- I "6 mesi" e "7 anni" del Summary sono costanti fisse, distinte da
  `emergencyMonths` / `goalHorizonMonths` (R2, R10).
- I virtual bond nel registro asset compaiono come "Stock · Intl": non hanno
  riga in `assetSettings` e la UI mostra il default
  (`src/components/Settings/TargetSettings.tsx:167`).
- I numeri della pagina Target (€248.300, Fineco, "Persona A") non sono quelli
  del mock dell'app (€180.042, Conto Corrente, Marco / Giulia): da allineare
  prima degli screenshot di U0/U6.

---

## 2d. Schede della pagina Target (to-be)

Il canvas tiene **due pagine**: **Target** (to-be) e **As-is (U2)**. Nel
Target ogni voce di menu è una riga e ogni scheda un artboard, con la barra
delle schede che collega le schermate tra loro (42 schermate). Ogni sezione
porta l'etichetta "oggi in …" con la pagina classica da cui arriva.

| Voce | Schede | Revisioni richieste per la versione piena |
|---|---|---|
| Home | — | — (U3) |
| Strategia | Panoramica · Livelli · Portafogli · Gruppi e asset · Ribilanciamento | R7 (target unico per livello, regole per portafoglio), R8 (cash riservato), R10 (tetti per classe, fasce temporali), R3 ("Metti in coda") |
| Obiettivi | Elenco · Copertura · Scadenze e virtual bond | R5, R6 (copertura in unità per tutti), R4 (bond che scade dopo l'obiettivo) |
| Operazioni | Coda · Nuova mossa · Prelievo · Esecuzione · Storico | U5 per sposta / preleva / spendi; R3 per coda salvata, tipi Ribilancia / Funding / PAC e Storico |
| Piani | Piani · Rate · Funding del mese · Nuovo piano | R9 (piano unico categoria / cash → asset / portafoglio / obiettivo) |
| Liquidità | Panoramica · Conti · Fondo d'emergenza · Interessi | R2 (regola unica), R8 (accantonamenti) |
| Patrimonio | Riepilogo · Distribuzione · Performance · Posizioni | — (ricomposizione di Dashboard, Stats, Performance) |
| Spese | Voci · Anno · Mese per mese | R11 (voci manuali, medie sincronizzate), R2 / R10 per i suggerimenti |
| Proiezioni | Scenario · Flussi · Rischio · Rendimenti | R5 (spese obiettivo lette da Obiettivi) |
| Dati | Transazioni · Portafogli · Broker · Asset | — (colonna "Origine" delle transazioni con R3) |
| Impostazioni | Generale · Broker e promozioni · Integrazioni · Backup e sicurezza · Info | R1 (tabella aliquote in Generale), R9 (collegamento conti) |

Scelte di collocazione nuove rispetto alle pagine classiche:

- **Asset Registry** passa da Settings a **Dati › Asset**; i virtual bond lì
  ereditano la classe "Obbligazioni".
- **Aliquote fiscali** diventano una tabella visibile in **Impostazioni ›
  Generale** (R1), insieme allo switch UI nuova / classica.
- **Ribilanciamento per portafoglio** è una scheda di Strategia: "Esegui"
  diventa "Metti in coda".
- **Esecuzione** in Operazioni è la checklist: spuntare un passo scrive la
  transazione e aggiorna il cash del conto.
- **Simulatore** di Stats resta in Patrimonio › Distribuzione con
  "Trasforma in mosse".

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
| R10 | Soglie di strategia: tetto per classe + fascia temporale Security (vedi §2b) | Additiva | Anche durante U4 | Dato nuovo richiesto dal mockup |
| R11 | Spese/obiettivi/piani indipendenti dalla fonte (vedi §2b, §0b) | Additiva | Dopo U4 | YNAB come integrazione e non come concetto |

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

1. ~~Caricare il PDF con i mockup e allinearlo a questo file.~~ Fatto: vedi §2b.
2. PR 1: **U0** — script `npm run verify` + job CI.
3. PR 2: **U1** — shell `NextApp` + switch `pr_ui_mode` + `viewMap`.
4. In parallelo, quando comodo: **R1** e **R2** (piccole, non toccano la UI).
5. Poi U2 → U3 (Home) → U4 → U5 → U6, nell'ordine preferito.

Tutto il lavoro di questa branch (`ui-rework`) deve poter convivere con
`main` senza conflitti di dati: ogni merge intermedio lascia l'app
funzionante sia in UI classica sia nuova.
