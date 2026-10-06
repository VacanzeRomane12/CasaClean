import { SITE } from "@/constants/metadata";

/*
 * Documenti legali — Italiano
 * ---------------------------
 * La versione italiana di informativa privacy e termini di servizio. È la
 * versione che prevale in caso di discrepanza (v. "Lingua" nei termini), quindi
 * ogni modifica sostanziale va fatta QUI e riportata in `en.js`, mai il
 * contrario per approssimazione.
 *
 * Stessa struttura dati di `en.js`: gli `id` delle sezioni sono identici nelle
 * due lingue, così l'indice e i link con ancora funzionano cambiando lingua.
 *
 * NON È CONSULENZA LEGALE: il testo descrive fedelmente il comportamento del
 * prodotto, ma va rivisto da un legale (e i dati societari segnaposto vanno
 * confermati) prima della pubblicazione.
 */

const UPDATED = "2026-10-06";

const identityRows = [
  ["Denominazione", SITE.legalName],
  ["Marchio", SITE.name],
  [
    "Sede legale",
    `${SITE.address.street}, ${SITE.address.postalCode} ${SITE.address.city} (${SITE.address.region}), Italia`,
  ],
  ["Email", SITE.email],
  ["Telefono", SITE.phone],
  ["Partita IVA", "Indicata per esteso su ogni fattura emessa"],
];

export const privacy = {
  id: "privacy",
  title: "Informativa sulla privacy",
  updated: UPDATED,
  intro: [
    `Questa informativa spiega quali dati personali ${SITE.legalName} — che opera con il marchio ${SITE.name} — raccoglie quando usi questo sito e prenoti una pulizia, perché li raccoglie, con chi li condivide e quali diritti hai.`,
    "È scritta in linguaggio semplice invece che in formule legali, e descrive ciò che il servizio fa davvero: nulla di quanto segue è un'intenzione futura.",
  ],
  sections: [
    {
      id: "controller",
      heading: "1. Chi tratta i tuoi dati",
      blocks: [
        {
          type: "p",
          text: "Il titolare del trattamento è la società indicata qui sotto. Scrivici all'indirizzo email per qualsiasi questione riguardi questa informativa: accesso, rettifica, cancellazione o reclamo.",
        },
        { type: "table", head: ["", ""], rows: identityRows },
        {
          type: "p",
          text: "Non abbiamo nominato un Responsabile della protezione dei dati, non essendovi tenuti. Le richieste in materia di privacy sono gestite dallo stesso team che risponde al modulo di contatto.",
        },
      ],
    },
    {
      id: "data",
      heading: "2. Quali dati raccogliamo",
      blocks: [
        {
          type: "p",
          text: "Raccogliamo solo ciò che serve davvero per una prenotazione di pulizia. La maggior parte dei dati la inserisci tu.",
        },
        {
          type: "table",
          head: ["Categoria", "Che cosa comprende"],
          rows: [
            [
              "Account",
              "Nome e cognome, indirizzo email, numero di telefono, il tuo codice fiscale o numero di documento se scegli di salvarlo per le prenotazioni future, e la password — conservata solo come hash bcrypt, non reversibile. Se accedi con Google conserviamo l'identificativo del tuo account Google e l'immagine del profilo al posto della password.",
            ],
            [
              "Prenotazione",
              "Il tuo codice fiscale o numero di documento (obbligatorio per ogni prenotazione e conservato insieme ad essa), l'indirizzo dell'intervento (via, numero civico, nome sul citofono), la metratura, la data, l'ora di inizio, la durata, il numero di addetti, gli extra e le attrezzature che selezioni e le note che lasci per chi esegue il servizio.",
            ],
            [
              "Pagamento",
              "Il tuo riferimento cliente Stripe, il riferimento di una carta che hai scelto di salvare, l'importo addebitato e la fattura emessa. I numeri di carta non arrivano mai ai nostri server: li raccoglie e conserva Stripe.",
            ],
            [
              "Dati fiscali (aziende)",
              "Per i clienti business: ragione sociale, partita IVA ed esito della verifica che Stripe ottiene dalla banca dati europea VIES.",
            ],
            [
              "Recensioni",
              "Il voto e il testo che scrivi su una prenotazione conclusa e la prenotazione a cui si riferiscono.",
            ],
            [
              "Messaggi",
              "Quanto invii tramite il modulo di contatto — nome, email, telefono, argomento, messaggio — insieme alle nostre risposte.",
            ],
            [
              "Dati tecnici",
              "Il tuo indirizzo IP e i dati essenziali della richiesta, usati per applicare i limiti di traffico e bloccare gli abusi, oltre ai dati diagnostici in caso di errore del sito.",
            ],
          ],
        },
        {
          type: "p",
          text: "Non raccogliamo categorie particolari di dati (salute, convinzioni personali e simili). Ti chiediamo di non inserire informazioni di questo tipo nelle note di prenotazione o nei messaggi.",
        },
      ],
    },
    {
      id: "sources",
      heading: "3. Da dove arrivano",
      blocks: [
        {
          type: "ul",
          items: [
            "Da te — quando crei un account, prenoti, scrivi una recensione o ci contatti.",
            "Da Google — se scegli di accedere con Google riceviamo nome, indirizzo email, immagine del profilo e identificativo dell'account.",
            "Da Stripe — l'esito di un pagamento e il risultato della verifica di una partita IVA sul VIES.",
            "Dal tuo browser — automaticamente, a ogni richiesta, i dati tecnici descritti sopra.",
          ],
        },
      ],
    },
    {
      id: "purposes",
      heading: "4. Perché li usiamo e con quale base giuridica",
      blocks: [
        {
          type: "table",
          head: ["Finalità", "Base giuridica (art. 6 GDPR)"],
          rows: [
            [
              "Creare e gestire il tuo account, inclusa la verifica dell'indirizzo email",
              "Esecuzione di un contratto — art. 6, par. 1, lett. b)",
            ],
            [
              "Organizzare ed eseguire la pulizia prenotata e fornire al professionista quanto gli serve per svolgerla",
              "Esecuzione di un contratto — art. 6, par. 1, lett. b)",
            ],
            [
              "Incassare i pagamenti, gestire i rimborsi e i piani ricorrenti",
              "Esecuzione di un contratto — art. 6, par. 1, lett. b)",
            ],
            [
              "Emettere, inviare e conservare fatture e scritture contabili",
              "Obbligo legale — art. 6, par. 1, lett. c)",
            ],
            [
              "Email di servizio: conferma, fattura, avvisi di annullamento e rimborso",
              "Esecuzione di un contratto — art. 6, par. 1, lett. b)",
            ],
            [
              "Rispondere ai tuoi messaggi e gestire i reclami nell'ambito della nostra garanzia",
              "Esecuzione di un contratto o legittimo interesse a rispondere alle richieste — art. 6, par. 1, lett. b)/f)",
            ],
            [
              "Pubblicare, dopo moderazione, una recensione che hai scelto di inviare",
              "Consenso, prestato con l'invio — art. 6, par. 1, lett. a)",
            ],
            [
              "Mantenere sicuro il servizio: limiti di traffico, blocco del traffico abusivo, blocco temporaneo dell'account dopo ripetuti accessi falliti, correzione degli errori",
              "Legittimo interesse a un servizio funzionante e non abusabile — art. 6, par. 1, lett. f)",
            ],
            [
              "Newsletter, se ti iscrivi",
              "Consenso, revocabile in qualsiasi momento — art. 6, par. 1, lett. a)",
            ],
            [
              "Accertare, esercitare o difendere un diritto in sede giudiziaria",
              "Legittimo interesse — art. 6, par. 1, lett. f)",
            ],
          ],
        },
        {
          type: "p",
          text: "Non facciamo profilazione e non prendiamo decisioni automatizzate che producano effetti giuridici nei tuoi confronti.",
        },
      ],
    },
    {
      id: "cookies",
      heading: "5. Cookie e memoria locale",
      blocks: [
        {
          type: "p",
          text: "Questo sito non usa cookie pubblicitari o di analisi, né pixel di tracciamento. Ciò che conserviamo si limita a quanto serve al funzionamento del sito:",
        },
        {
          type: "table",
          head: ["Nome", "Tipo", "Finalità e durata"],
          rows: [
            [
              "lt",
              "Cookie (httpOnly)",
              "Ti mantiene autenticato. Contiene un token firmato con il solo identificativo utente — mai il tuo ruolo né la password. Scade dopo 7 giorni o immediatamente al logout.",
            ],
            [
              "casaclean:locale",
              "Memoria locale",
              "Ricorda la lingua scelta. Resta finché non cancelli i dati del browser.",
            ],
            [
              "casaclean:theme",
              "Memoria locale",
              "Ricorda l'aspetto chiaro o scuro. Resta finché non cancelli i dati del browser.",
            ],
          ],
        },
        {
          type: "p",
          text: "Trattandosi di strumenti tecnici necessari o impostati su tua richiesta, per essi non è richiesto alcun banner di consenso. Stripe può impostare propri cookie nella fase di pagamento per finalità antifrode, secondo la propria informativa.",
        },
        {
          type: "p",
          text: "Le nostre pagine caricano i caratteri tipografici da Google Fonts: il tuo browser contatta quindi un server Google, che in questo modo riceve il tuo indirizzo IP. Nient'altro viene trasmesso.",
        },
      ],
    },
    {
      id: "sharing",
      heading: "6. Con chi li condividiamo",
      blocks: [
        {
          type: "p",
          text: "Non vendiamo i tuoi dati e non li condividiamo per finalità di marketing di terzi. Ci avvaliamo di pochi fornitori, ciascuno dei quali agisce come responsabile del trattamento su nostra istruzione:",
        },
        {
          type: "table",
          head: ["Destinatario", "Che cosa riceve e perché"],
          rows: [
            [
              "Stripe",
              "I dati di pagamento e della carta, nome ed email e, per la verifica, la partita IVA aziendale. Stripe è il gestore dei pagamenti e titolare autonomo per le finalità antifrode.",
            ],
            [
              "Il nostro fornitore di posta elettronica",
              "Il tuo indirizzo email e il contenuto del messaggio inviato: conferme, fatture, link di verifica e reimpostazione, risposte.",
            ],
            [
              "Google",
              "I dati di accesso, se usi l'accesso con Google. Separatamente, l'indirizzo di una prenotazione può essere inviato al servizio di geocodifica di Google Maps affinché il nostro team possa pianificare gli interventi della giornata.",
            ],
            [
              "Sentry",
              "Segnalazioni tecniche di errore, che possono incidentalmente contenere l'URL visitato e il tuo identificativo utente.",
            ],
            [
              "Fornitore di hosting e database",
              "Tutti i dati conservati dal servizio, in quanto infrastruttura su cui esso opera.",
            ],
            [
              "Il professionista assegnato alla prenotazione",
              "Nome, indirizzo, orario, dettagli dell'intervento e le note che hai lasciato: il minimo necessario per presentarsi ed eseguire il lavoro.",
            ],
          ],
        },
        {
          type: "p",
          text: "Possiamo inoltre comunicare i dati quando la legge lo impone o per accertare e difendere un diritto.",
        },
      ],
    },
    {
      id: "transfers",
      heading: "7. Trasferimenti fuori dallo SEE",
      blocks: [
        {
          type: "p",
          text: "Alcuni dei fornitori indicati sono stabiliti negli Stati Uniti o vi trattano dati. Quando i dati escono dallo Spazio economico europeo sono protetti da una decisione di adeguatezza della Commissione europea oppure da Clausole contrattuali tipo accompagnate da misure supplementari. Puoi chiederci copia dello strumento utilizzato.",
        },
      ],
    },
    {
      id: "retention",
      heading: "8. Per quanto tempo li conserviamo",
      blocks: [
        {
          type: "table",
          head: ["Dato", "Conservazione"],
          rows: [
            ["Dati dell'account", "Fino alla cancellazione dell'account."],
            [
              "Prenotazioni, pagamenti e fatture",
              "Dieci anni dalla chiusura dell'esercizio, come richiesto dalla normativa contabile italiana (art. 2220 c.c.).",
            ],
            ["Messaggi di contatto e risposte", "Fino a 24 mesi dalla chiusura della richiesta."],
            [
              "Recensioni",
              "Finché non le cancelli o cancelli l'account, se precedente.",
            ],
            [
              "Link di verifica email",
              "24 ore. Link di reimpostazione password: 30 minuti. Di ciascun link è conservato solo l'hash.",
            ],
            ["Segnalazioni tecniche di errore", "Fino a 90 giorni."],
          ],
        },
        {
          type: "p",
          text: "Quando cancelli l'account annulliamo gli eventuali piani ricorrenti attivi, cancelliamo le tue recensioni ed eliminiamo la scheda del tuo account. Le prenotazioni passate e le relative fatture sono conservate come documenti contabili, ma vengono scollegate dall'account cancellato. La cancellazione è bloccata finché hai una prenotazione futura: annullala prima, così non restano in sospeso né denaro né appuntamenti.",
        },
      ],
    },
    {
      id: "rights",
      heading: "9. I tuoi diritti",
      blocks: [
        { type: "p", text: "In base al GDPR puoi chiederci di:" },
        {
          type: "ul",
          items: [
            "ottenere copia dei dati che ti riguardano (accesso);",
            "correggere ciò che è inesatto o incompleto (rettifica);",
            "cancellare i tuoi dati, salvo quelli che dobbiamo conservare per obblighi contabili o per la difesa di un diritto;",
            "limitare un trattamento od opporti a quelli fondati sul legittimo interesse;",
            "ricevere i tuoi dati in un formato strutturato e leggibile da dispositivo automatico (portabilità);",
            "revocare un consenso prestato — per una recensione o per la newsletter — senza che ciò pregiudichi quanto fatto prima della revoca.",
          ],
        },
        {
          type: "p",
          text: `Molte di queste operazioni puoi farle da solo dalla pagina del profilo: modificare i tuoi dati, impostare o cambiare la password, cancellare l'account. Per tutto il resto scrivi a ${SITE.email}. Rispondiamo entro un mese.`,
        },
        {
          type: "p",
          text: "Se ritieni che abbiamo trattato male i tuoi dati puoi proporre reclamo al Garante per la protezione dei dati personali, Piazza Venezia 11, 00187 Roma (garanteprivacy.it), o all'autorità del Paese in cui risiedi.",
        },
      ],
    },
    {
      id: "security",
      heading: "10. Come li proteggiamo",
      blocks: [
        {
          type: "ul",
          items: [
            "Le password sono conservate solo come hash bcrypt, mai in chiaro.",
            "La sessione risiede in un cookie httpOnly che nessuno script può leggere e contiene solo il tuo identificativo utente: i permessi vengono riverificati sul database a ogni richiesta.",
            "Il cambio password chiude immediatamente ogni altra sessione.",
            "Ogni richiesta che modifica dati è protetta contro il cross-site request forgery e il traffico è soggetto a limiti; ripetuti accessi falliti bloccano temporaneamente l'account.",
            "I link di verifica e di reimpostazione password sono conservati solo come hash: nemmeno una fuga di dati dal database permetterebbe di impossessarsi di un account.",
            "Il traffico è cifrato in transito e l'accesso al pannello di amministrazione è riservato al personale autorizzato.",
          ],
        },
        {
          type: "p",
          text: "Nessun sistema è perfettamente sicuro. Se una violazione dovesse mettere a rischio i tuoi diritti, ne informeremo il Garante e te, come prescrive il GDPR.",
        },
      ],
    },
    {
      id: "children",
      heading: "11. Minori",
      blocks: [
        {
          type: "p",
          text: "Il servizio è rivolto agli adulti. Per creare un account o prenotare occorre avere almeno 18 anni e non raccogliamo consapevolmente dati di minori. Se ritieni che un minore ci abbia comunicato dei dati, segnalacelo e provvederemo a cancellarli.",
        },
      ],
    },
    {
      id: "changes",
      heading: "12. Modifiche a questa informativa",
      blocks: [
        {
          type: "p",
          text: "Se cambieremo il modo in cui trattiamo i tuoi dati aggiorneremo questa pagina e la data in alto. Per una modifica che ti riguardi in modo sostanziale te ne daremo notizia via email prima che diventi efficace.",
        },
      ],
    },
  ],
};

export const terms = {
  id: "terms",
  title: "Termini di servizio",
  updated: UPDATED,
  intro: [
    `Questi termini regolano l'uso del sito e ogni pulizia prenotata tramite esso presso ${SITE.legalName}, che opera con il marchio ${SITE.name} ("noi"). Creando un account o confermando una prenotazione li accetti.`,
    "Leggi con particolare attenzione la sezione 6 (prezzi e pagamento), la sezione 8 (annullamento) e la sezione 10 (diritto di recesso): sono quelle che determinano quanto paghi.",
  ],
  sections: [
    {
      id: "who",
      heading: "1. Con chi stipuli il contratto",
      blocks: [
        { type: "table", head: ["", ""], rows: identityRows },
        {
          type: "p",
          text: "Il contratto per una pulizia è concluso con la società sopra indicata e non con il professionista che esegue materialmente il servizio.",
        },
      ],
    },
    {
      id: "account",
      heading: "2. Il tuo account",
      blocks: [
        {
          type: "ul",
          items: [
            "Devi avere almeno 18 anni e la capacità di concludere un contratto vincolante.",
            "I dati che ci fornisci devono essere esatti: indirizzo, telefono e istruzioni di accesso sono ciò su cui lavora chi esegue il servizio.",
            "Prima di prenotare devi verificare il tuo indirizzo email; il link è valido 24 ore e può essere reinviato.",
            "Sei responsabile della riservatezza della password e di quanto avviene tramite il tuo account. Avvisaci subito se sospetti che qualcun altro vi abbia accesso.",
            "Puoi accedere con Google e aggiungere una password in un secondo momento: da quel momento funzionano entrambi i metodi.",
            "Possiamo sospendere o chiudere un account usato in modo fraudolento o abusivo, o in violazione di questi termini.",
          ],
        },
      ],
    },
    {
      id: "service",
      heading: "3. Che cosa offriamo",
      blocks: [
        {
          type: "p",
          text: "Organizziamo servizi di pulizia domestica e commerciale — ordinaria, profonda, per ingresso e uscita da un immobile, per uffici, case vacanza ed emergenze — eseguiti presso il tuo indirizzo da professionisti selezionati, nelle città elencate nel percorso di prenotazione.",
        },
        {
          type: "ul",
          items: [
            "Prodotti e attrezzature per la pulizia non sono compresi nel prezzo. Puoi aggiungere quelli che ti servono durante la prenotazione, ciascuno con il proprio prezzo, oppure metterli a disposizione tu.",
            "Devi garantire un accesso sicuro all'orario concordato, oltre ad acqua corrente ed energia elettrica. Non è necessario che tu sia presente — chiavi, serratura smart o portineria vanno bene — ma l'accesso resta una tua responsabilità.",
            "Possiamo rifiutare o interrompere un intervento se l'immobile è insicuro, se è sostanzialmente diverso da quanto descritto o se il nostro personale viene trattato in modo offensivo. Quando la causa non dipende da noi, l'intervento può essere trattato come un annullamento tardivo.",
            "Alcune attività esulano dal servizio: rischio biologico, infestazioni, bonifica da muffe, sollevamento di carichi pesanti, lavori in quota oltre lo sgabello e tutto ciò che richieda un'abilitazione professionale specifica.",
          ],
        },
      ],
    },
    {
      id: "booking",
      heading: "4. Come si conclude una prenotazione",
      blocks: [
        {
          type: "p",
          text: "I prezzi esposti sul sito costituiscono un invito a prenotare, non una proposta contrattuale. La tua prenotazione diventa un contratto quando il pagamento va a buon fine e ti inviamo l'email di conferma.",
        },
        {
          type: "ul",
          items: [
            "Un intervento deve iniziare non prima dell'orario di apertura della tua città, iniziare prima dell'orario di chiusura e concludersi — inizio più durata — entro la chiusura. Il percorso di prenotazione ti mostra l'intervallo di orari di inizio che ne risulta.",
            "Non è possibile prenotare per un orario già trascorso.",
            "Le disponibilità non sono garantite. Se dopo la prenotazione non riuscissimo a coprire l'orario, si applica la sezione 9.",
          ],
        },
      ],
    },
    {
      id: "duration",
      heading: "5. Durata e numero di addetti",
      blocks: [
        {
          type: "p",
          text: "Scegli l'orario di inizio al minuto e la durata in ore intere o mezze ore: un intervento di 90 minuti è una prenotazione valida. Scegli inoltre quanti addetti intervengono. Entrambi determinano il prezzo, perciò entrambi si fissano al momento della conferma.",
        },
        {
          type: "p",
          text: "Se il lavoro dovesse richiedere più tempo di quello prenotato, l'addetto te lo segnalerà: ogni prolungamento va concordato e pagato a parte. Non addebitiamo tempo aggiuntivo che tu non abbia accettato.",
        },
      ],
    },
    {
      id: "pricing",
      heading: "6. Prezzi, IVA e pagamento",
      blocks: [
        {
          type: "p",
          text: "Il prezzo di una pulizia è dato dalla tariffa oraria del servizio × la durata prenotata × il numero di addetti, più gli extra e le attrezzature selezionati. Vedi il totale esatto prima di confermare: non ci sono costi nascosti.",
        },
        {
          type: "ul",
          items: [
            "I prezzi di listino sono al netto dell'IVA, che viene aggiunta nella misura applicabile in Italia. Entrambi gli importi sono mostrati prima del pagamento e riportati in fattura.",
            "Se sei un'impresa stabilita in un altro Stato membro dell'UE e la tua partita IVA risulta verificata sul VIES, l'IVA non viene applicata e la fattura riporta la dicitura di inversione contabile ai sensi dell'articolo 196 della Direttiva 2006/112/CE: l'imposta è assolta da te. La verifica non è immediata; finché il numero non è confermato, l'IVA viene addebitata normalmente.",
            "Il pagamento avviene in anticipo, online, con carta tramite Stripe. Non vediamo né conserviamo mai il numero della tua carta.",
            "Per ogni pagamento andato a buon fine viene emessa una fattura, che ti inviamo via email. Se ti serve un'altra copia, richiedicela in qualsiasi momento.",
          ],
        },
      ],
    },
    {
      id: "recurring",
      heading: "7. Piani ricorrenti",
      blocks: [
        {
          type: "p",
          text: "Quando il servizio lo consente puoi impostare una pulizia periodica a intervallo fisso: un numero intero di giorni da 1 a 14, oppure una delle cadenze specifiche previste per quel servizio.",
        },
        {
          type: "ul",
          items: [
            "Ogni ciclo viene calcolato e addebitato automaticamente sulla carta salvata poco prima dell'intervento (per impostazione predefinita il giorno precedente) e genera una propria fattura.",
            "Ogni ciclo è calcolato secondo le regole vigenti in quel momento, compreso il tuo stato ai fini IVA: se la tua registrazione decade, l'IVA torna a essere addebitata.",
            "Puoi sospendere, riattivare o annullare un piano in qualsiasi momento dal tuo account. L'annullamento interrompe gli addebiti futuri ma non annulla un intervento già pagato, che va annullato separatamente ai sensi della sezione 8.",
            "Se un addebito non riesce lo ritentiamo fino a tre volte, poi sospendiamo il piano e te lo comunichiamo.",
            "Possiamo sospendere un piano se il servizio cessa di essere disponibile per il tuo indirizzo. Te ne spiegheremo il motivo e, durante la sospensione, non viene effettuato alcun addebito.",
          ],
        },
      ],
    },
    {
      id: "cancellation",
      heading: "8. Modifica e annullamento di una prenotazione",
      blocks: [
        {
          type: "p",
          text: "Puoi annullare una prenotazione autonomamente, in qualsiasi momento, dal tuo account. Il costo dipende da quando lo fai:",
        },
        {
          type: "table",
          head: ["Quando annulli", "Che cosa succede"],
          rows: [
            [
              "Più di 24 ore prima dell'orario di inizio",
              "La prenotazione è annullata e l'intero importo ti viene rimborsato automaticamente sullo stesso metodo di pagamento.",
            ],
            [
              "Entro 24 ore dall'orario di inizio",
              "La prenotazione è comunque annullata e rimborsata, al netto di una penale per annullamento tardivo pari a un'ora della squadra prenotata (tariffa oraria × numero di addetti). La fascia oraria non è più rivendibile: è questo che la penale copre.",
            ],
          ],
        },
        {
          type: "ul",
          items: [
            "Extra e attrezzature non rientrano mai nella penale — un lavoro mai eseguito non ha alcun costo per noi — e vengono quindi sempre rimborsati per intero.",
            "La penale non può mai superare quanto hai pagato: per un intervento di un'ora assorbe pertanto l'intero corrispettivo della manodopera.",
            "I rimborsi sono disposti sulla carta usata per il pagamento e compaiono di norma entro pochi giorni lavorativi, a seconda della banca.",
            "Se preferisci spostare la prenotazione anziché annullarla, contattaci prima delle 24 ore: faremo il possibile per riprogrammarla senza costi.",
          ],
        },
        {
          type: "p",
          text: "Questa sezione ha natura contrattuale. Se sei un consumatore e ricorre il diritto di recesso di cui alla sezione 10, tale diritto prevale sulla penale qui prevista.",
        },
      ],
    },
    {
      id: "our-changes",
      heading: "9. Se siamo noi a modificare o annullare",
      blocks: [
        {
          type: "p",
          text: "Può capitare che non riusciamo a coprire una prenotazione: malattia, guasto di un mezzo, maltempo grave. In tal caso te lo comunichiamo appena possibile e ti proponiamo di scegliere tra un nuovo appuntamento e il rimborso integrale. Se annulliamo noi, non si applica alcuna penale.",
        },
      ],
    },
    {
      id: "withdrawal",
      heading: "10. Diritto di recesso (consumatori)",
      blocks: [
        {
          type: "p",
          text: "Se sei un consumatore hai 14 giorni dalla conclusione del contratto per recedere senza dover indicare alcun motivo, ai sensi degli articoli 52 e seguenti del Codice del Consumo (D.lgs. 206/2005), che recepisce la Direttiva 2011/83/UE.",
        },
        {
          type: "ul",
          items: [
            "Prenotando una data che cade entro tali 14 giorni, ci chiedi espressamente di iniziare l'esecuzione prima della scadenza del periodo di recesso.",
            "Il diritto di recesso si estingue una volta che la pulizia è stata interamente eseguita.",
            "Se receda dopo l'inizio ma prima del completamento dell'esecuzione, sei tenuto a corrispondere un importo proporzionale a quanto già eseguito; il resto ti viene rimborsato.",
            `Per recedere è sufficiente una dichiarazione esplicita: un'email a ${SITE.email}, oppure l'annullamento dal tuo account indicando che si tratta di un recesso. Rimborsiamo entro 14 giorni dalla comunicazione, con lo stesso metodo di pagamento.`,
          ],
        },
      ],
    },
    {
      id: "your-duties",
      heading: "11. Presso l'immobile",
      blocks: [
        {
          type: "ul",
          items: [
            "Ti chiediamo di riporre denaro, gioielli e oggetti fragili o insostituibili prima dell'intervento.",
            "Segnala nelle note della prenotazione la presenza di animali, allarmi, difficoltà di parcheggio o qualunque elemento dell'immobile che richieda particolare cura.",
            "Comunica in anticipo eventuali pericoli: impianti elettrici difettosi, mobili instabili, vetri rotti, trattamenti antiparassitari recenti.",
            "Il nostro personale non sposta mobili più pesanti di quanto possa gestire in sicurezza da solo, non usa scale oltre i due gradini e non manipola sostanze pericolose.",
          ],
        },
      ],
    },
    {
      id: "guarantee",
      heading: "12. Garanzia e reclami",
      blocks: [
        {
          type: "p",
          text: "Ogni intervento è coperto dalla nostra garanzia. Se qualcosa non è stato pulito a dovere, segnalacelo entro 48 ore dall'intervento con una descrizione e, se possibile, delle foto. Valuteremo la situazione insieme a te e concorderemo come rimediare: di norma un nuovo passaggio sulle aree interessate o, quando ciò non sia praticabile, un rimborso parziale.",
        },
        {
          type: "p",
          text: "Questa garanzia si aggiunge ai diritti che la legge italiana ti riconosce come consumatore e non li limita in alcun modo.",
        },
      ],
    },
    {
      id: "liability",
      heading: "13. Danni e responsabilità",
      blocks: [
        {
          type: "ul",
          items: [
            "Rispondiamo dei danni causati per negligenza dal nostro personale durante l'esecuzione di una prenotazione; i nostri professionisti sono coperti da assicurazione di responsabilità civile a ogni intervento.",
            "Segnala eventuali danni entro 48 ore dall'intervento, così da poter accertare i fatti quando sono ancora verificabili.",
            "Non rispondiamo dell'usura o dei danni preesistenti, di oggetti già difettosi o instabili, dei danni derivanti dalla natura di una superficie o di un materiale che ci hai chiesto di trattare, né delle conseguenze di istruzioni di accesso inesatte.",
            "Nei limiti consentiti dalla legge, non rispondiamo dei danni indiretti o consequenziali e la nostra responsabilità complessiva per una prenotazione è limitata al maggiore tra l'importo pagato per essa e il danno effettivamente cagionato dalla nostra negligenza.",
            "Nulla in questi termini limita la nostra responsabilità per morte o lesioni personali dovute a nostra negligenza, per dolo o colpa grave, né alcuna responsabilità che la legge non consenta di limitare, compresi i diritti inderogabili del consumatore.",
          ],
        },
      ],
    },
    {
      id: "reviews",
      heading: "14. Recensioni e contenuti che invii",
      blocks: [
        {
          type: "ul",
          items: [
            "Puoi recensire una tua prenotazione che risulti conclusa: una recensione per prenotazione.",
            "Le recensioni non vengono pubblicate automaticamente. Le leggiamo prima e compare sul sito solo quella che approviamo.",
            "Una recensione pubblicata mostra il tuo nome e l'iniziale del cognome (\"Giorgi K.\"), il voto, il testo e la data. Il tuo indirizzo email, l'account e la prenotazione non sono mai mostrati.",
            "La modifica del voto o del testo riporta la recensione in moderazione: una recensione approvata non può essere riscritta in silenzio.",
            "Non puoi inviare contenuti illeciti, diffamatori, discriminatori o che identifichino un'altra persona. Possiamo rifiutare o rimuovere contenuti di questo tipo.",
            "Inviando una recensione ci autorizzi a pubblicarla sul sito. Puoi cancellarla in qualsiasi momento.",
          ],
        },
      ],
    },
    {
      id: "acceptable-use",
      heading: "15. Uso del sito",
      blocks: [
        {
          type: "ul",
          items: [
            "Non tentare di violare, sondare o aggirare la sicurezza del sito, i suoi limiti di traffico o gli account di altri utenti.",
            "Non estrarre automaticamente i contenuti del sito, non effettuare prenotazioni con strumenti automatizzati e non usarlo per inviare messaggi indesiderati.",
            "Il sito, i suoi contenuti, la grafica e il software appartengono a noi o ai nostri licenzianti e sono protetti dal diritto d'autore. Puoi usarli per prenotare pulizie e per nient'altro.",
          ],
        },
      ],
    },
    {
      id: "termination",
      heading: "16. Chiusura del rapporto",
      blocks: [
        {
          type: "p",
          text: "Puoi cancellare il tuo account quando vuoi dalla pagina del profilo. Ti sarà chiesto di confermare con la password e dovrai prima annullare le prenotazioni future, che comportano denaro e una squadra già pianificata. La cancellazione dell'account annulla i piani ricorrenti attivi ed elimina le tue recensioni; prenotazioni passate e fatture restano come documenti contabili, scollegate dall'account.",
        },
        {
          type: "p",
          text: "Possiamo sospendere o interrompere il tuo accesso in caso di violazione grave o reiterata di questi termini, di frode o di comportamenti offensivi verso il nostro personale. In tal caso rimborsiamo ogni prenotazione pagata e non ancora eseguita.",
        },
      ],
    },
    {
      id: "data",
      heading: "17. I tuoi dati personali",
      blocks: [
        {
          type: "p",
          text: "Il trattamento dei tuoi dati personali è descritto nella nostra Informativa sulla privacy, che costituisce parte integrante di questi termini.",
        },
      ],
    },
    {
      id: "changes",
      heading: "18. Modifiche ai termini",
      blocks: [
        {
          type: "p",
          text: "Possiamo aggiornare questi termini, ad esempio quando cambia il servizio o la normativa. La versione in vigore al momento in cui confermi una prenotazione è quella che regola quella prenotazione: una modifica successiva non le si applica retroattivamente. Le modifiche sostanziali saranno annunciate via email o sul sito prima di diventare efficaci.",
        },
      ],
    },
    {
      id: "law",
      heading: "19. Legge applicabile e controversie",
      blocks: [
        {
          type: "ul",
          items: [
            "Questi termini sono regolati dalla legge italiana.",
            "Se sei un consumatore conservi la protezione delle norme inderogabili del Paese in cui risiedi e puoi agire davanti al giudice del tuo luogo di residenza.",
            "Se sei un'impresa, è competente in via esclusiva il Foro di Roma.",
            "I consumatori dell'UE possono inoltre ricorrere alla piattaforma europea di risoluzione delle controversie online all'indirizzo ec.europa.eu/consumers/odr o a un organismo di mediazione accreditato.",
            "Prima però parlane con noi: quasi tutti i reclami si risolvono con un'email al nostro team nel giro di un giorno.",
          ],
        },
      ],
    },
    {
      id: "language",
      heading: "20. Lingua",
      blocks: [
        {
          type: "p",
          text: "Questi termini sono pubblicati in italiano e in inglese. In caso di discrepanza tra le due versioni prevale quella italiana.",
        },
      ],
    },
    {
      id: "contact",
      heading: "21. Contatti",
      blocks: [
        {
          type: "p",
          text: `Per domande su questi termini, su una prenotazione o su una fattura scrivi a ${SITE.email} o chiama il ${SITE.phone}. Puoi anche usare il modulo di contatto: rispondiamo entro un giorno lavorativo.`,
        },
      ],
    },
  ],
};

export default { privacy, terms };
