import { SITE } from "@/constants/metadata";

/*
 * Legal documents — English
 * -------------------------
 * The privacy policy and terms of service, authored as data so one renderer
 * (`pages/Legal/LegalDocument`) can lay out every language identically and the
 * table of contents can be derived instead of maintained.
 *
 * Every operative statement here mirrors behaviour that actually exists in this
 * codebase — the cancellation fee (`server/utils/cancellation.util.js`), the VAT
 * and reverse-charge rule (`server/utils/tax.util.js`), invoicing, recurring
 * charges, review moderation, what `DELETE /auth/me` really deletes. Change the
 * code and this text has to change with it, in BOTH languages.
 *
 * Company identity is read from `SITE` rather than retyped, so the registered
 * details can never drift from the rest of the site. Values that only the server
 * knows (the VAT number printed on invoices, the applicable VAT rate) are
 * described rather than quoted — stating a wrong one would be worse than none.
 *
 * NOT LEGAL ADVICE: this is a complete, honest description of how the product
 * behaves, written in the shape Italian/EU law expects. Have it reviewed by a
 * lawyer, and confirm the placeholder company details, before going live.
 */

const UPDATED = "2026-10-06";

const identityRows = [
  ["Legal name", SITE.legalName],
  ["Trading as", SITE.name],
  [
    "Registered office",
    `${SITE.address.street}, ${SITE.address.postalCode} ${SITE.address.city} (${SITE.address.region}), Italy`,
  ],
  ["Email", SITE.email],
  ["Phone", SITE.phone],
  ["VAT number", "Shown in full on every invoice we issue"],
];

export const privacy = {
  id: "privacy",
  title: "Privacy Policy",
  updated: UPDATED,
  intro: [
    `This policy explains what personal data ${SITE.legalName} — trading as ${SITE.name} — collects when you use this website and book a cleaning, why we collect it, who we share it with and what you can do about it.`,
    "We have written it in plain language rather than legal boilerplate. It describes what the service actually does: nothing here is aspirational.",
  ],
  sections: [
    {
      id: "controller",
      heading: "1. Who is responsible for your data",
      blocks: [
        {
          type: "p",
          text: "The data controller is the company below. Write to us at the email address for anything in this policy — access, correction, deletion or a complaint.",
        },
        { type: "table", head: ["", ""], rows: identityRows },
        {
          type: "p",
          text: "We have not appointed a Data Protection Officer, as we are not required to. Privacy requests are handled by the same team that answers the contact form.",
        },
      ],
    },
    {
      id: "data",
      heading: "2. What we collect",
      blocks: [
        {
          type: "p",
          text: "We collect only what a cleaning booking actually needs. Most of it you type in yourself.",
        },
        {
          type: "table",
          head: ["Category", "What it includes"],
          rows: [
            [
              "Account",
              "Full name, email address, phone number, your personal identification number if you choose to save it for future bookings, and your password — stored only as a bcrypt hash we cannot reverse. If you sign in with Google we store your Google account id and profile picture instead of a password.",
            ],
            [
              "Booking",
              "Your personal identification number (national ID or tax code — required for every reservation and kept with it), the service address (street, house number, doorbell name), property size, date, start time, duration, number of cleaners, any add-ons and cleaning tools you select, and the notes you leave for the cleaner.",
            ],
            [
              "Payment",
              "Your Stripe customer reference, the reference of a card you chose to save, the amount charged and the invoice issued. Card numbers never reach our servers — Stripe collects and stores them.",
            ],
            [
              "Business / VAT",
              "For business customers: company name, VAT number, and the verification result Stripe returns from the EU VIES database.",
            ],
            [
              "Reviews",
              "The rating and text you write about a completed booking, and which booking it relates to.",
            ],
            [
              "Messages",
              "Anything you send through the contact form — name, email, phone, topic, message — together with our replies.",
            ],
            [
              "Technical",
              "Your IP address and basic request details, used to apply rate limits and block abuse, plus diagnostic data if the site throws an error.",
            ],
          ],
        },
        {
          type: "p",
          text: "We do not collect special categories of data (health, beliefs, and so on). Please do not put such information in a booking note or a message.",
        },
      ],
    },
    {
      id: "sources",
      heading: "3. Where it comes from",
      blocks: [
        {
          type: "ul",
          items: [
            "From you — when you create an account, book, write a review or contact us.",
            "From Google — if you choose to sign in with Google, we receive your name, email address, profile picture and account id.",
            "From Stripe — the outcome of a payment, and the result of checking a business VAT number against VIES.",
            "From your browser — the technical data described above, automatically, with every request.",
          ],
        },
      ],
    },
    {
      id: "purposes",
      heading: "4. Why we use it, and on what legal basis",
      blocks: [
        {
          type: "table",
          head: ["Purpose", "Legal basis (GDPR Art. 6)"],
          rows: [
            [
              "Creating and running your account, including verifying your email address",
              "Performance of a contract — Art. 6(1)(b)",
            ],
            [
              "Arranging and carrying out the cleaning you booked, and sending the professional what they need to do the job",
              "Performance of a contract — Art. 6(1)(b)",
            ],
            [
              "Taking payment, handling refunds and running recurring plans",
              "Performance of a contract — Art. 6(1)(b)",
            ],
            [
              "Issuing, sending and keeping invoices and accounting records",
              "Legal obligation — Art. 6(1)(c)",
            ],
            [
              "Service emails: confirmation, invoice, cancellation and refund notices",
              "Performance of a contract — Art. 6(1)(b)",
            ],
            [
              "Answering your messages and handling complaints under our guarantee",
              "Performance of a contract, or our legitimate interest in replying to enquiries — Art. 6(1)(b)/(f)",
            ],
            [
              "Publishing a review you chose to submit, after moderation",
              "Your consent, given by submitting it — Art. 6(1)(a)",
            ],
            [
              "Keeping the service secure: rate limiting, blocking abusive traffic, locking accounts after repeated failed sign-ins, fixing errors",
              "Our legitimate interest in a working, non-abusable service — Art. 6(1)(f)",
            ],
            [
              "Newsletter, if you subscribe",
              "Your consent, withdrawable at any time — Art. 6(1)(a)",
            ],
            [
              "Establishing, exercising or defending legal claims",
              "Our legitimate interest — Art. 6(1)(f)",
            ],
          ],
        },
        {
          type: "p",
          text: "We do not profile you, and we make no decisions about you by automated means that produce legal effects.",
        },
      ],
    },
    {
      id: "cookies",
      heading: "5. Cookies and local storage",
      blocks: [
        {
          type: "p",
          text: "This site uses no advertising or analytics cookies, and no tracking pixels. What we do store is limited to what the site needs to function:",
        },
        {
          type: "table",
          head: ["Name", "Type", "Purpose and lifetime"],
          rows: [
            [
              "lt",
              "Cookie (httpOnly)",
              "Keeps you signed in. Holds a signed token containing your user id only — never your role or password. Expires after 7 days, or immediately when you sign out.",
            ],
            [
              "casaclean:locale",
              "Local storage",
              "Remembers your chosen language. Stays until you clear your browser data.",
            ],
            [
              "casaclean:theme",
              "Local storage",
              "Remembers light or dark appearance. Stays until you clear your browser data.",
            ],
          ],
        },
        {
          type: "p",
          text: "Because these are strictly necessary or set at your own request, no consent banner is required for them. Stripe may set its own cookies on the payment step for fraud prevention, governed by Stripe's privacy policy.",
        },
        {
          type: "p",
          text: "Our pages load fonts from Google Fonts, which means your browser contacts a Google server and Google receives your IP address in the process. Nothing else is sent.",
        },
      ],
    },
    {
      id: "sharing",
      heading: "6. Who we share it with",
      blocks: [
        {
          type: "p",
          text: "We never sell your data and we never share it for anyone else's marketing. We use a small number of providers, each acting on our instructions as a processor:",
        },
        {
          type: "table",
          head: ["Recipient", "What they receive and why"],
          rows: [
            [
              "Stripe",
              "Payment and card details, your name and email, and a business VAT number for verification. Stripe is the payment processor and a controller in its own right for fraud prevention.",
            ],
            [
              "Our email provider",
              "Your email address and the content of the message being sent — confirmations, invoices, verification and reset links, replies.",
            ],
            [
              "Google",
              "Your sign-in details, if you use Google Sign-In. Separately, a booking address may be sent to the Google Maps geocoding service so our team can plot the day's jobs.",
            ],
            [
              "Sentry",
              "Technical error reports. These can incidentally contain the URL you were on and your user id.",
            ],
            [
              "Hosting and database provider",
              "Everything stored by the service, as the infrastructure it runs on.",
            ],
            [
              "The cleaning professional assigned to your booking",
              "Your name, address, arrival time, the job details and any notes you left — the minimum they need to turn up and do the work.",
            ],
          ],
        },
        {
          type: "p",
          text: "We may also disclose data where the law requires it, or to establish or defend a legal claim.",
        },
      ],
    },
    {
      id: "transfers",
      heading: "7. Transfers outside the EEA",
      blocks: [
        {
          type: "p",
          text: "Some of the providers above are established in, or process data from, the United States. Where data leaves the European Economic Area it is protected by an adequacy decision of the European Commission, or by Standard Contractual Clauses together with additional safeguards. You may ask us for a copy of the mechanism relied on.",
        },
      ],
    },
    {
      id: "retention",
      heading: "8. How long we keep it",
      blocks: [
        {
          type: "table",
          head: ["Data", "Kept for"],
          rows: [
            ["Account details", "Until you delete your account."],
            [
              "Bookings, payments and invoices",
              "Ten years from the end of the tax year, as Italian accounting law requires (art. 2220 Civil Code).",
            ],
            ["Contact messages and replies", "Up to 24 months after the matter is closed."],
            [
              "Reviews",
              "Until you delete them or delete your account, whichever comes first.",
            ],
            [
              "Email verification links",
              "24 hours. Password reset links: 30 minutes. Only a hash of each link is stored.",
            ],
            ["Technical error reports", "Up to 90 days."],
          ],
        },
        {
          type: "p",
          text: "When you delete your account we cancel any active recurring plan, delete your reviews, and remove your account record. Past bookings and their invoices are kept as financial records but are detached from the deleted account. Deletion is blocked while you still have an upcoming booking — cancel it first, so no money or scheduling is left in limbo.",
        },
      ],
    },
    {
      id: "rights",
      heading: "9. Your rights",
      blocks: [
        {
          type: "p",
          text: "Under the GDPR you can ask us to:",
        },
        {
          type: "ul",
          items: [
            "give you a copy of the data we hold about you (access);",
            "correct anything inaccurate or incomplete (rectification);",
            "delete your data (erasure), except what we must keep for accounting or legal claims;",
            "restrict or object to a use we base on legitimate interest;",
            "give you your data in a portable, machine-readable format;",
            "withdraw a consent you gave — for a review or the newsletter — without affecting what we did before you withdrew it.",
          ],
        },
        {
          type: "p",
          text: `You can do much of this yourself from your profile page: change your details, set or change your password, and delete your account. For anything else, email ${SITE.email}. We answer within one month.`,
        },
        {
          type: "p",
          text: "If you think we have handled your data badly, you can complain to the Italian supervisory authority — Garante per la protezione dei dati personali, Piazza Venezia 11, 00187 Rome (garanteprivacy.it) — or to the authority where you live.",
        },
      ],
    },
    {
      id: "security",
      heading: "10. How we protect it",
      blocks: [
        {
          type: "ul",
          items: [
            "Passwords are stored only as bcrypt hashes, never in a readable form.",
            "Your session lives in an httpOnly cookie a script cannot read, and carries your user id only — your permissions are re-checked against the database on every request.",
            "Changing your password ends every other session immediately.",
            "Every state-changing request is protected against cross-site request forgery, and traffic is rate limited; repeated failed sign-ins lock an account temporarily.",
            "Email verification and password reset links are stored only as hashes, so even a database leak cannot be used to take over an account.",
            "Traffic is encrypted in transit, and access to the admin panel is restricted to authorised staff.",
          ],
        },
        {
          type: "p",
          text: "No system is perfectly secure. If a breach ever puts your rights at risk, we will notify the Garante and you, as the GDPR requires.",
        },
      ],
    },
    {
      id: "children",
      heading: "11. Children",
      blocks: [
        {
          type: "p",
          text: "This service is for adults. You must be at least 18 to create an account or book, and we do not knowingly collect data from children. If you believe a child has given us data, tell us and we will delete it.",
        },
      ],
    },
    {
      id: "changes",
      heading: "12. Changes to this policy",
      blocks: [
        {
          type: "p",
          text: "If we change how we handle your data we will update this page and the date at the top. For a change that materially affects you, we will tell you by email before it takes effect.",
        },
      ],
    },
  ],
};

export const terms = {
  id: "terms",
  title: "Terms of Service",
  updated: UPDATED,
  intro: [
    `These terms govern your use of this website and every cleaning you book through it from ${SITE.legalName}, trading as ${SITE.name} ("we", "us"). By creating an account or confirming a booking you accept them.`,
    "Please read section 6 (prices and payment), section 8 (cancelling) and section 10 (your right of withdrawal) with particular care — they decide what you pay.",
  ],
  sections: [
    {
      id: "who",
      heading: "1. Who you are contracting with",
      blocks: [
        { type: "table", head: ["", ""], rows: identityRows },
        {
          type: "p",
          text: "A contract for a cleaning is concluded with the company above, not with the professional who carries out the work.",
        },
      ],
    },
    {
      id: "account",
      heading: "2. Your account",
      blocks: [
        {
          type: "ul",
          items: [
            "You must be at least 18 and able to enter a binding contract.",
            "The details you give us must be accurate — the address, phone number and access instructions are what the cleaner works from.",
            "You must verify your email address before booking; the link is valid for 24 hours and can be re-sent.",
            "You are responsible for keeping your password confidential and for what happens under your account. Tell us immediately if you think someone else has access.",
            "You may sign in with Google and add a password later; from then on either method works.",
            "We may suspend or close an account that is used fraudulently, abusively, or in breach of these terms.",
          ],
        },
      ],
    },
    {
      id: "service",
      heading: "3. What we provide",
      blocks: [
        {
          type: "p",
          text: "We arrange domestic and commercial cleaning — regular, deep, move-in/move-out, office, holiday-home and emergency cleaning — carried out at your address by vetted professionals, in the cities listed in the booking wizard.",
        },
        {
          type: "ul",
          items: [
            "Cleaning products and equipment are not included in the price. You can add the ones you need while booking, each priced separately, or provide your own.",
            "You must give safe access at the agreed time, along with running water and electricity. You do not have to be present — keys, a smart lock or a concierge all work — but access is your responsibility.",
            "We may decline or stop a job where the property is unsafe, materially different from what you described, or where our staff are treated abusively. Where the fault is not ours, the visit may be treated as a late cancellation.",
            "Some tasks are outside our scope: biohazards, pest infestations, mould remediation, heavy lifting, work at height beyond a step ladder, and anything requiring a licensed trade.",
          ],
        },
      ],
    },
    {
      id: "booking",
      heading: "4. How a booking is made",
      blocks: [
        {
          type: "p",
          text: "The prices shown on the site are an invitation to book, not an offer. Your booking becomes a contract when your payment succeeds and we send you a confirmation email.",
        },
        {
          type: "ul",
          items: [
            "A visit must start at or after the opening time for your city, start before closing time, and finish — start plus duration — by closing time. The wizard shows you the range of start times this leaves.",
            "A booking cannot be placed for a time that has already passed.",
            "Slots are subject to availability. If we cannot staff a slot after you have booked it, section 9 applies.",
          ],
        },
      ],
    },
    {
      id: "duration",
      heading: "5. Duration and number of cleaners",
      blocks: [
        {
          type: "p",
          text: "You choose the start time to the minute and the duration in whole or half hours — a 90-minute visit is a valid booking. You also choose how many cleaners attend. Both decide the price, so both are fixed when you confirm.",
        },
        {
          type: "p",
          text: "If the work turns out to need longer than you booked, the cleaner will tell you; any extension has to be agreed and paid for separately. We do not charge for extra time you did not agree to.",
        },
      ],
    },
    {
      id: "pricing",
      heading: "6. Prices, VAT and payment",
      blocks: [
        {
          type: "p",
          text: "The price of a cleaning is the service's hourly rate × the duration you booked × the number of cleaners, plus any add-ons and cleaning tools you selected. You see the exact total before you confirm — there are no hidden fees.",
        },
        {
          type: "ul",
          items: [
            "Catalogue prices are net of VAT. VAT is added on top at the applicable Italian rate, and both figures are shown before you pay and printed on your invoice.",
            "If you are a business established in another EU member state and your VAT number is verified against the VIES database, no VAT is charged and your invoice carries the reverse-charge notice under Article 196 of Directive 2006/112/EC — you account for the VAT yourself. Verification is not instant: until your number is confirmed, VAT is charged normally.",
            "Payment is taken in advance, online, by card through Stripe. We never see or store your card number.",
            "An invoice is issued for every successful payment and sent to you by email. Ask us at any time if you need another copy.",
          ],
        },
      ],
    },
    {
      id: "recurring",
      heading: "7. Recurring plans",
      blocks: [
        {
          type: "p",
          text: "Where a service allows it, you can set up a repeating cleaning at a fixed interval — any whole number of days from 1 to 14, or one of the specific cadences offered for that service.",
        },
        {
          type: "ul",
          items: [
            "Each cycle is priced and charged automatically to your saved card shortly before the visit (one day in advance by default), and each cycle produces its own invoice.",
            "Each cycle is priced under the rules in force at the time, including your VAT status — so if your VAT registration lapses, VAT starts being charged again.",
            "You can pause, resume or cancel a plan at any time from your account. Cancelling stops future charges; it does not cancel a visit already paid for, which you cancel separately under section 8.",
            "If a charge fails we retry it up to three times, then pause the plan and tell you.",
            "We may pause a plan if the service stops being available for your address. We will tell you why, and no further charges are taken while it is paused.",
          ],
        },
      ],
    },
    {
      id: "cancellation",
      heading: "8. Changing or cancelling a booking",
      blocks: [
        {
          type: "p",
          text: "You can cancel a booking yourself, at any time, from your account. What it costs depends on when:",
        },
        {
          type: "table",
          head: ["When you cancel", "What happens"],
          rows: [
            [
              "More than 24 hours before the start time",
              "The booking is cancelled and the full amount is refunded automatically to your original payment method.",
            ],
            [
              "Within 24 hours of the start time",
              "The booking is still cancelled and refunded, less a late-cancellation fee equal to one hour of the crew you booked (hourly rate × number of cleaners). The slot can no longer be resold, which is what the fee covers.",
            ],
          ],
        },
        {
          type: "ul",
          items: [
            "Add-ons and cleaning tools are never part of the fee — work that never happened costs us nothing — so they are always refunded in full.",
            "The fee can never exceed what you paid. For a one-hour visit it therefore absorbs the whole labour charge.",
            "Refunds are issued to the card you paid with and usually appear within a few business days, depending on your bank.",
            "To move a booking rather than cancel it, contact us before the 24-hour mark and we will do our best to re-schedule at no cost.",
          ],
        },
        {
          type: "p",
          text: "This section is a contractual arrangement. Where you are a consumer and the statutory right of withdrawal in section 10 applies, that right takes precedence over the fee above.",
        },
      ],
    },
    {
      id: "our-changes",
      heading: "9. If we have to change or cancel",
      blocks: [
        {
          type: "p",
          text: "Occasionally we cannot staff a booking — illness, a vehicle breakdown, severe weather. If that happens we will tell you as soon as we know and offer you the choice of a new slot or a full refund. If we cancel, no fee of any kind applies.",
        },
      ],
    },
    {
      id: "withdrawal",
      heading: "10. Your right of withdrawal (consumers)",
      blocks: [
        {
          type: "p",
          text: "If you are a consumer, you have 14 days from concluding the contract to withdraw from it without giving a reason, under articles 52 and following of the Italian Consumer Code (Legislative Decree 206/2005), which implements Directive 2011/83/EU.",
        },
        {
          type: "ul",
          items: [
            "By booking a date that falls inside those 14 days, you expressly ask us to begin performing before the withdrawal period ends.",
            "You lose the right of withdrawal once the cleaning has been fully performed.",
            "If you withdraw after performance has begun but before it is complete, you owe an amount proportionate to what has been performed, and we refund the rest.",
            `To withdraw, it is enough to tell us clearly — by email to ${SITE.email}, or by cancelling from your account and saying it is a withdrawal. We refund within 14 days of being told, using the same payment method.`,
          ],
        },
      ],
    },
    {
      id: "your-duties",
      heading: "11. At the property",
      blocks: [
        {
          type: "ul",
          items: [
            "Please put away cash, jewellery and anything fragile or irreplaceable before the visit.",
            "Tell us in the booking notes about pets, alarms, difficult parking, or anything in the property that needs particular care.",
            "Flag hazards in advance — faulty wiring, unstable furniture, broken glass, recent pest treatment.",
            "Our staff will not move furniture heavier than they can safely handle alone, use ladders beyond a two-step, or handle hazardous substances.",
          ],
        },
      ],
    },
    {
      id: "guarantee",
      heading: "12. Our guarantee and complaints",
      blocks: [
        {
          type: "p",
          text: "Every visit is covered by our guarantee. If something was not cleaned properly, tell us within 48 hours of the visit with a description and, ideally, photos. We will look into it with you and agree how to put it right — normally a return visit to redo the affected areas, or a partial refund where that is not practical.",
        },
        {
          type: "p",
          text: "This guarantee is in addition to, and does not restrict, your statutory rights as a consumer under Italian law.",
        },
      ],
    },
    {
      id: "liability",
      heading: "13. Damage and liability",
      blocks: [
        {
          type: "ul",
          items: [
            "We are liable for damage our staff cause negligently while carrying out a booking, and our professionals are covered by liability insurance on every visit.",
            "Report any damage within 48 hours of the visit so we can investigate while the evidence is fresh.",
            "We are not liable for pre-existing wear or damage, for items that were already faulty or unstable, for damage caused by an unsuitable surface or material you asked us to treat, or for the consequences of inaccurate access instructions.",
            "To the extent the law permits, we are not liable for indirect or consequential loss, and our total liability for a booking is limited to the greater of the amount you paid for it and the loss actually caused by our negligence.",
            "Nothing in these terms limits our liability for death or personal injury caused by our negligence, for fraud or wilful misconduct, or any liability that cannot be limited by law — including a consumer's mandatory rights.",
          ],
        },
      ],
    },
    {
      id: "reviews",
      heading: "14. Reviews and content you submit",
      blocks: [
        {
          type: "ul",
          items: [
            "You can review a booking of yours that has been completed — one review per booking.",
            "Reviews are not published automatically. We read each one first, and only a review we approve appears on the site.",
            "A published review shows your first name and the initial of your surname (\"Giorgi K.\"), the rating, the text and the date. Your email address, account and the booking itself are never shown.",
            "Editing a review's rating or text returns it to moderation, so an approved review cannot be quietly rewritten into something else.",
            "You must not submit anything unlawful, defamatory, discriminatory, or that identifies another person. We may decline or remove such content.",
            "By submitting a review you allow us to display it on the site. You can delete it at any time.",
          ],
        },
      ],
    },
    {
      id: "acceptable-use",
      heading: "15. Using the website",
      blocks: [
        {
          type: "ul",
          items: [
            "Do not attempt to breach, probe or circumvent the security of the site, its rate limits or other users' accounts.",
            "Do not scrape the site, place bookings by automated means, or use it to send unsolicited messages.",
            "The site, its content, design and software are ours or our licensors' and are protected by copyright. You may use them to book cleanings and for nothing else.",
          ],
        },
      ],
    },
    {
      id: "termination",
      heading: "16. Ending the relationship",
      blocks: [
        {
          type: "p",
          text: "You can delete your account whenever you like from your profile page. You will be asked to confirm with your password, and any upcoming bookings must be cancelled first — they involve money and a scheduled crew. Deleting your account cancels active recurring plans and removes your reviews; past bookings and invoices are kept as financial records, detached from your account.",
        },
        {
          type: "p",
          text: "We may suspend or terminate your access for a serious or repeated breach of these terms, for fraud, or for abusive behaviour towards our staff. Where we do, we refund any booking that has been paid for but not yet performed.",
        },
      ],
    },
    {
      id: "data",
      heading: "17. Your personal data",
      blocks: [
        {
          type: "p",
          text: "How we handle your personal data is set out in our Privacy Policy, which forms part of these terms.",
        },
      ],
    },
    {
      id: "changes",
      heading: "18. Changes to these terms",
      blocks: [
        {
          type: "p",
          text: "We may update these terms — for example when the service changes or the law does. The version in force when you confirm a booking is the version that governs that booking; a later change never applies retroactively to it. Material changes will be announced by email or on the site before they take effect.",
        },
      ],
    },
    {
      id: "law",
      heading: "19. Governing law and disputes",
      blocks: [
        {
          type: "ul",
          items: [
            "These terms are governed by Italian law.",
            "If you are a consumer, you keep the protection of the mandatory rules of the country where you live, and you may bring proceedings in the courts of your place of residence.",
            "If you are a business, the courts of Rome, Italy have exclusive jurisdiction.",
            "Consumers in the EU may also use the European Commission's online dispute resolution platform at ec.europa.eu/consumers/odr, or an accredited Italian consumer mediation body.",
            "Talk to us first, though — most complaints are settled by an email to our team within a day.",
          ],
        },
      ],
    },
    {
      id: "language",
      heading: "20. Language",
      blocks: [
        {
          type: "p",
          text: "These terms are published in Italian and English. In the event of a discrepancy between the two versions, the Italian version prevails.",
        },
      ],
    },
    {
      id: "contact",
      heading: "21. Contact",
      blocks: [
        {
          type: "p",
          text: `Questions about these terms, a booking or an invoice: email ${SITE.email} or call ${SITE.phone}. You can also use the contact form — we reply within one business day.`,
        },
      ],
    },
  ],
};

export default { privacy, terms };
