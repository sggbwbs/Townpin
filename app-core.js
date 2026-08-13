const API_BASE = '/api';

// PWA installability -- see sw.js for exactly what it does and doesn't
// cache (short version: never touches /api/, only speeds up repeat
// loads of the static shell).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
// Paired with FOUNDING_COUPON_ID in api/create-checkout-session.js -- when
// you remove that coupon there (or unset the env var), also flip this to
// false so the on-site badge/copy stops promising a discount checkout no
// longer applies.
const FOUNDING_DISCOUNT_ACTIVE = true;

// Mirrors the server-side pricing in api/_pricing.js, used only to
// display the right price before checkout -- the server always
// recalculates and charges the real amount itself, this is never trusted
// as the actual charge. Flat 29.90€/slot, no volume discount.
function pricePerSquareEur(count){
  return 29.90;
}

// Every dynamic price display in app-chat.js was interpolating a raw
// JS number directly -- €{price} style. Two real problems with that:
// (1) JS numbers silently drop trailing zeros, so 29.90 becomes the
// number 29.9, which renders as the confirmed, reported bug "29.9€"
// instead of "29,90€" -- looks unfinished/unprofessional, not what was
// actually charged. (2) none of those were locale-aware either --
// Finnish uses a comma as the decimal separator, not a period, but
// every dynamic price showed a period regardless of language. This
// fixes both at once, in one place, rather than patching each call site
// with its own .toFixed().
function formatPrice(amount){
  const fixed = amount.toFixed(2);
  return lang === 'fi' ? fixed.replace('.', ',') : fixed;
}

// Approximate populations, used only for autocomplete ranking and picking a
// sensible board size for a new town — not authoritative figures.
const FINNISH_CITIES = [
  {name:"Helsinki", population:700000},
  {name:"Espoo", population:313000},
  {name:"Tampere", population:244000},
  {name:"Vantaa", population:239000},
  {name:"Oulu", population:215000},
  {name:"Turku", population:202000},
  {name:"Jyväskylä", population:145000},
  {name:"Kuopio", population:123000},
  {name:"Lahti", population:120000},
  {name:"Pori", population:83000},
  {name:"Kouvola", population:80000},
  {name:"Joensuu", population:79000},
  {name:"Lappeenranta", population:73000},
  {name:"Hämeenlinna", population:68000},
  {name:"Vaasa", population:68000},
  {name:"Seinäjoki", population:65000},
  {name:"Rovaniemi", population:63000},
  {name:"Mikkeli", population:53000},
  {name:"Kotka", population:51000},
  {name:"Salo", population:51000},
  {name:"Porvoo", population:51000},
  {name:"Kokkola", population:48000},
  {name:"Hyvinkää", population:46000},
  {name:"Lohja", population:46000},
  {name:"Järvenpää", population:45000},
  {name:"Rauma", population:39000},
  {name:"Kerava", population:37000},
  {name:"Kajaani", population:35000},
  {name:"Nokia", population:34000},
  {name:"Kaarina", population:34000},
  {name:"Ylöjärvi", population:34000},
  {name:"Savonlinna", population:33000},
  {name:"Kangasala", population:32000},
  {name:"Riihimäki", population:30000},
  {name:"Vihti", population:30000},
  {name:"Imatra", population:25000},
  {name:"Raisio", population:25000},
  {name:"Lempäälä", population:25000},
  {name:"Kirkkonummi", population:42000},
  {name:"Tuusula", population:41000},
  {name:"Raahe", population:24000},
  {name:"Nurmijärvi", population:45000},
  {name:"Siilinjärvi", population:22000},
  {name:"Tornio", population:22000},
  {name:"Sipoo", population:22000},
  {name:"Iisalmi", population:21000},
  {name:"Naantali", population:20000},
  {name:"Varkaus", population:20000},
  {name:"Heinola", population:18000},
  {name:"Äänekoski", population:18700},
  {name:"Kempele", population:18000},
  {name:"Jämsä", population:19000},
  {name:"Laukaa", population:19000},
  {name:"Nivala", population:10500},
  {name:"Pietarsaari", population:20000},
  {name:"Valkeakoski", population:20000},
  {name:"Kemi", population:20500},
  {name:"Loviisa", population:15000},
  {name:"Kuusamo", population:15300},
  {name:"Kalajoki", population:12700},
  {name:"Ylivieska", population:15000},
  {name:"Forssa", population:16000},
  {name:"Loimaa", population:16000},
  {name:"Uusikaupunki", population:15000},
  {name:"Janakkala", population:16000},
  {name:"Sastamala", population:24000},
  {name:"Akaa", population:16000},
  {name:"Kauhava", population:15600},
  {name:"Lieto", population:21000},
  {name:"Liminka", population:12000},
  {name:"Kangasniemi", population:5300},
  {name:"Kankaanpää", population:12000},
  {name:"Kauhajoki", population:12800},
  {name:"Kurikka", population:13600},
  {name:"Lapua", population:14400},
  {name:"Ilmajoki", population:12300},
  {name:"Liperi", population:12500},
  {name:"Kontiolahti", population:15000},
  {name:"Muurame", population:10500},
  {name:"Saarijärvi", population:9600},
  {name:"Orimattila", population:16000},
  {name:"Hollola", population:24000},
  {name:"Hämeenkyrö", population:10000},
  {name:"Huittinen", population:9500},
  {name:"Eura", population:9200},
  {name:"Muhos", population:9200},
  {name:"Ii", population:9700},
  {name:"Pudasjärvi", population:7900},
  {name:"Oulainen", population:7700},
  {name:"Haapajärvi", population:6900},
  {name:"Tyrnävä", population:7500},
  {name:"Leppävirta", population:9700},
  {name:"Lapinlahti", population:9700},
  {name:"Suonenjoki", population:6800},
  {name:"Kiuruvesi", population:8400},
  {name:"Lieksa", population:10500},
  {name:"Outokumpu", population:6500},
  {name:"Nurmes", population:7500},
  {name:"Ilomantsi", population:4600},
  {name:"Juuka", population:4700},
  {name:"Keuruu", population:9000},
  {name:"Viitasaari", population:6100},
  {name:"Petäjävesi", population:3900},
  {name:"Hankasalmi", population:4900},
  {name:"Joutsa", population:3400},
  {name:"Karstula", population:4100},
  {name:"Alajärvi", population:9600},
  {name:"Alavus", population:8700},
  {name:"Jalasjärvi", population:7000},
  {name:"Teuva", population:4700},
  {name:"Ähtäri", population:5800},
  {name:"Kuortane", population:3500},
  {name:"Vimpeli", population:2500},
  {name:"Laihia", population:8100},
  {name:"Mustasaari", population:20000},
  {name:"Närpiö", population:9200},
  {name:"Pedersöre", population:11300},
  {name:"Uusikaarlepyy", population:7600},
  {name:"Kristiinankaupunki", population:6700},
  {name:"Kannus", population:5500},
  {name:"Kaustinen", population:4300},
  {name:"Toholampi", population:3200},
  {name:"Veteli", population:3000},
  {name:"Perho", population:2600},
  {name:"Haapavesi", population:6700},
  {name:"Sievi", population:5300},
  {name:"Pyhäjärvi", population:5100},
  {name:"Vaala", population:3000},
  {name:"Utajärvi", population:2600},
  {name:"Taivalkoski", population:3900},
  {name:"Reisjärvi", population:2600},
  {name:"Sotkamo", population:10200},
  {name:"Suomussalmi", population:7900},
  {name:"Kuhmo", population:8000},
  {name:"Paltamo", population:3600},
  {name:"Puolanka", population:2400},
  {name:"Hyrynsalmi", population:2100},
  {name:"Kemijärvi", population:7300},
  {name:"Sodankylä", population:8600},
  {name:"Inari", population:6800},
  {name:"Ranua", population:3700},
  {name:"Posio", population:3000},
  {name:"Salla", population:3200},
  {name:"Kolari", population:3800},
  {name:"Ylitornio", population:3900},
  {name:"Tervola", population:2900},
  {name:"Simo", population:3200},
  {name:"Keminmaa", population:8000},
  {name:"Pello", population:3300},
  {name:"Muonio", population:2300},
  {name:"Enontekiö", population:1800},
  {name:"Utsjoki", population:1200},
  {name:"Savukoski", population:1000},
  {name:"Pelkosenniemi", population:900},
  {name:"Karkkila", population:9000},
  {name:"Raasepori", population:27000},
  {name:"Hanko", population:8000},
  {name:"Mäntsälä", population:21000},
  {name:"Askola", population:5000},
  {name:"Pornainen", population:5500},
  {name:"Siuntio", population:6300},
  {name:"Inkoo", population:5500},
  {name:"Myrskylä", population:1900},
  {name:"Pukkila", population:1900},
  {name:"Somero", population:8800},
  {name:"Parainen", population:15000},
  {name:"Kemiönsaari", population:6800},
  {name:"Masku", population:10000},
  {name:"Mynämäki", population:7500},
  {name:"Nousiainen", population:5300},
  {name:"Aura", population:3900},
  {name:"Pöytyä", population:7800},
  {name:"Sauvo", population:3000},
  {name:"Taivassalo", population:1500},
  {name:"Vehmaa", population:2200},
  {name:"Laitila", population:8300},
  {name:"Pyhäranta", population:2100},
  {name:"Rusko", population:6000},
  {name:"Koski Tl", population:2400},
  {name:"Marttila", population:1800},
  {name:"Oripää", population:1400},
  {name:"Eurajoki", population:5900},
  {name:"Harjavalta", population:6600},
  {name:"Nakkila", population:5300},
  {name:"Ulvila", population:13000},
  {name:"Kokemäki", population:6900},
  {name:"Merikarvia", population:2900},
  {name:"Siikainen", population:1400},
  {name:"Karvia", population:2500},
  {name:"Jämijärvi", population:1900},
  {name:"Pomarkku", population:2200},
  {name:"Säkylä", population:4300},
  {name:"Mänttä-Vilppula", population:9500},
  {name:"Orivesi", population:9000},
  {name:"Ikaalinen", population:5700},
  {name:"Parkano", population:6000},
  {name:"Ruovesi", population:4400},
  {name:"Virrat", population:6600},
  {name:"Juupajoki", population:1900},
  {name:"Kihniö", population:1900},
  {name:"Punkalaidun", population:2900},
  {name:"Urjala", population:4600},
  {name:"Vesilahti", population:4700},
  {name:"Pirkkala", population:20000},
  {name:"Pälkäne", population:6500},
  {name:"Hattula", population:9800},
  {name:"Loppi", population:7900},
  {name:"Hausjärvi", population:8600},
  {name:"Jokioinen", population:5600},
  {name:"Ypäjä", population:2300},
  {name:"Humppila", population:2200},
  {name:"Tammela", population:6300},
  {name:"Asikkala", population:8000},
  {name:"Hartola", population:2600},
  {name:"Sysmä", population:3800},
  {name:"Padasjoki", population:2900},
  {name:"Kärkölä", population:4700},
  {name:"Iitti", population:6500},
  {name:"Hamina", population:20000},
  {name:"Miehikkälä", population:1900},
  {name:"Virolahti", population:3200},
  {name:"Pyhtää", population:5300},
  {name:"Savitaipale", population:3200},
  {name:"Taipalsaari", population:4700},
  {name:"Luumäki", population:4400},
  {name:"Lemi", population:2900},
  {name:"Parikkala", population:4600},
  {name:"Rautjärvi", population:3300},
  {name:"Ruokolahti", population:4400},
  {name:"Pieksämäki", population:17000},
  {name:"Juva", population:6000},
  {name:"Mäntyharju", population:6000},
  {name:"Hirvensalmi", population:2100},
  {name:"Puumala", population:2100},
  {name:"Rantasalmi", population:3200},
  {name:"Joroinen", population:4900},
  {name:"Enonkoski", population:1300},
  {name:"Heinävesi", population:3000},
  {name:"Sulkava", population:2400},
  {name:"Sonkajärvi", population:4000},
  {name:"Vieremä", population:3300},
  {name:"Keitele", population:2200},
  {name:"Rautavaara", population:1500},
  {name:"Tervo", population:1500},
  {name:"Tuusniemi", population:2400},
  {name:"Vesanto", population:2000},
  {name:"Kaavi", population:2900},
  {name:"Rautalampi", population:2100},
  {name:"Pielavesi", population:3900},
  {name:"Kitee", population:6600},
  {name:"Kesälahti", population:2400},
  {name:"Polvijärvi", population:4200},
  {name:"Tohmajärvi", population:4400},
  {name:"Rääkkylä", population:2200},
  {name:"Uurainen", population:3600},
  {name:"Konnevesi", population:2600},
  {name:"Toivakka", population:2400},
  {name:"Kannonkoski", population:1400},
  {name:"Kivijärvi", population:1100},
  {name:"Kinnula", population:1300},
  {name:"Multia", population:1600},
  {name:"Karijoki", population:1200},
  {name:"Isojoki", population:2100},
  {name:"Lappajärvi", population:3100},
  {name:"Soini", population:2200},
  {name:"Evijärvi", population:2300},
  {name:"Maalahti", population:5700},
  {name:"Luoto", population:5400},
  {name:"Kruunupyy", population:6800},
  {name:"Vöyri", population:6500},
  {name:"Isokyrö", population:4700},
  {name:"Kaskinen", population:1200},
  {name:"Halsua", population:1100},
  {name:"Lestijärvi", population:700},
  {name:"Alavieska", population:2600},
  {name:"Merijärvi", population:1100},
  {name:"Pyhäjoki", population:3100},
  {name:"Pyhäntä", population:1500},
  {name:"Ristijärvi", population:1200},
  {name:"Maarianhamina", population:11700},
  {name:"Jomala", population:5000},
  {name:"Finström", population:2700},
  {name:"Lemland", population:2100},
  {name:"Saltvik", population:1900},
  {name:"Hammarland", population:1600},
  {name:"Sund", population:1000},
  {name:"Vårdö", population:400},
  {name:"Lumparland", population:400},
  {name:"Sottunga", population:101},
  {name:"Kökar", population:227},
  {name:"Kumlinge", population:273},
  {name:"Brändö", population:460},
  {name:"Föglö", population:570},
  {name:"Geta", population:500},
  {name:"Eckerö", population:900}
];

let currentTown = null;
let previewMode = false; // set from the ?preview=1 URL param in init() -- see there for what this actually unlocks and why it's safe
let currentSquares = [];

let lang = 'fi';

const STRINGS = {
  fi: {
    pitchEyebrow: 'Oma yrityksesi tähän?',
    logoBannerEmpty: 'Ole ensimmäinen yritys taulussa!',
    heroTitle: 'Näytä yrityksesi <span>koko Oululle.</span>',
    heroSub: 'PaikallisCanvas on Oulun yritysten yhteinen ilmoitustaulu verkossa — jokainen mainospaikka taulussa on eri yritys. Näkyvyyttä syntyy kahdella tavalla: oikeat oululaiset selaavat taulua katsomassa päivän uutisia, tapahtumia ja säätä, ja samalla yrityksesi saa oman esittelysivun, joka voi löytyä Google-hausta täysin itsekseen — vaikka kukaan ei koskaan avaisi itse taulua. Kumpaakaan emme voi taata: taulun kävijämäärä riippuu sivuston käytöstä ja Google-näkyvyys hakukoneen omista säännöistä. Mainospaikka maksaa 29,90€/kk, lisäät logosi ja linkkisi itse, etkä sido itseäsi mihinkään määräaikaan.',
    value1b: '29,90€/kk',
    value1: 'murto-osa siitä, mitä somemainontaan yleensä kuluu kuukaudessa',
    value2b: 'Löydettävissä Googlesta', value2: 'yrityksesi saa oman esittelysivun, joka voi näkyä hakutuloksissa vaikka kukaan ei selaisi itse taulua',
    value3b: 'Peruutettavissa milloin vain', value3: 'ei sopimusaikaa eikä irtisanomisaikaa',
    value4b: 'Näet oikeat kävijämäärät', value4: 'et vain lupausta -- joka kerta kun joku avaa sivusi, näet sen omalta hallintapaneeliltasi',
    volumeNote: '29,90 €/kk per mainospaikka. Jokainen mainospaikka on samankokoinen.',
    factsTitle: 'Miksi paikallinen näkyvyys kannattaa',
    fact1: 'kaikista Google-hauista koskee jotain paikallista',
    fact2: 'hakijoista, jotka etsivät jotain "lähellä", käy yrityksessä 24 tunnin sisällä',
    fact3: 'kuluttajista etsii paikallisia yrityksiä netistä ennen kuin asioi niiden kanssa',
    factsNote: 'Lähde: Google / Think with Google, BrightLocal. Luvut kuvaavat yleistä hakukäyttäytymistä Suomessa ja muualla — emme väitä, että ne kuvaavat suoraan tämän palvelun tuomaa liikennettä juuri sinun yrityksellesi.',
    earlyBanner: '🚀 -50% ensimmäisestä kuukaudesta! Palvelu on juuri julkaistu — liity ensimmäisten joukossa mukaan ja näy heti kärjessä, ennen kuin taulu täyttyy.',
    hiwTitle: 'Näin se toimii',
    hiw2: 'Valitse haluamasi mainospaikkojen määrä',
    hiw3: 'Täytä yrityksesi tiedot ja maksa turvallisesti Stripen kautta',
    hiw4: 'Mainospaikka ja sen esittelysivu ovat käytössä heti maksun jälkeen',
    faqTitle: 'Usein kysyttyä',
    faqQ1: 'Onko tämä luotettava palvelu?',
    faqA1: 'Maksut käsittelee Stripe, jota käyttävät miljoonat yritykset ympäri maailman — emme koskaan näe tai tallenna korttitietojasi.',
    faqQ2: 'Mitä oikeasti saan rahalleni?',
    faqA2: 'Banneripaikan ilmoitustaululla omalla logollasi, sekä oman esittelysivun, joka linkittää suoraan yrityksesi omalle verkkosivulle.',
    faqQ3: 'Voinko peruuttaa milloin vain?',
    faqA3: 'Kyllä. Tilaus on kuukausittainen eikä sido sinua mihinkään määräaikaan. Kun peruutat, mainospaikka pysyy näkyvissä jo maksetun jakson loppuun asti, minkä jälkeen se vapautuu.',
    faqQ4: 'Tarkistetaanko ilmoitukset?',
    faqA4: 'Kyllä — jokainen ilmoitus tarkistetaan automaattisesti ennen julkaisua, ja epäasiallisen sisällön voi poistaa milloin tahansa.',
    faqQ5: 'Näynkö heti Google-haussa?',
    faqA5: 'Sivusi julkaistaan heti, mutta hakukoneiden indeksointi voi viedä muutamasta päivästä pariin viikkoon — emme voi luvata tarkkaa aikataulua tai sijoitusta hakutuloksissa.',
    faqQ6: 'Kuukausitilaus vai kertamaksu — kumpi kannattaa?',
    faqA6: 'Molemmat toimivat samalla banneripaikalla. Kuukausitilaus veloittaa kuukausittain ja voit peruuttaa milloin vain. Kertamaksulla maksat 3, 6 tai 12 kuukauden jakson kerralla etukäteen ja saat alennuksen (12 kk = 2 kuukautta ilmaiseksi) — jakso ei uusiudu automaattisesti, joten et joudu muistamaan peruuttaa.',
    eventsSourceNote: 'Lähde: Kaleva',
    viewAllEventsLink: 'katso kaikki tapahtumat ↗',
    eventsCountOne: '1 tapahtuma tänään',
    eventsCountMany: '{count} tapahtumaa tänään',
    newsCatOulu: 'Oulun seutu',
    newsCatUusimmat: 'Uusimmat',
    newsCatPohjoisSuomi: 'Pohjois-Suomi',
    newsCatKotimaa: 'Kotimaa',
    newsCatUlkomaat: 'Ulkomaat',
    askHeroTitle: 'Kaikki Oulussa<br>yhdestä paikasta',
    askHeroSub: 'Löydä tapahtumat, yritykset, uutiset, tarjoukset ja paikalliset palvelut helposti.',
    askHeroPlaceholder: 'Mitä haluaisit tehdä tänään?',
    askHeroButton: 'Kysy',
    askReopenChatBtn: 'Näytä keskustelu',
    askDesktopChatTitle: 'Kysy tekoälyoppaalta',
    askClearChatBtn: 'Tyhjennä',
    askClearChatBtnLabel: 'Tyhjennä keskustelu',
    nearbyTitle: 'Lähelläsi',
    nearbySub: 'Näytä paikalliset yritykset lähimmästä kauimpaan sijaintisi perusteella.',
    nearbyUseLocationBtn: 'Käytä sijaintiani',
    nearbyPrivacyNote: 'Sijaintiasi ei tallenneta -- sitä käytetään vain tämän listan järjestämiseen selaimessasi.',
    nearbyLocating: 'Haetaan sijaintia…',
    nearbyErrorUnsupported: 'Selaimesi ei tue sijainninhakua.',
    nearbyErrorDenied: 'Sijainnin käyttö evätty. Tarkista sekä selaimen sijaintilupa (selaimen asetukset) että laitteesi sijaintipalvelut (käyttöjärjestelmän asetukset) -- kumpi tahansa pois päältä aiheuttaa tämän saman virheen.',
    nearbyErrorFailed: 'Sijaintia ei saatu haettua. Yritä uudelleen.',
    nearbyEmpty: 'Ei vielä sijaintitietoja sisältäviä yrityksiä.',
    favoritesTitle: 'Suosikkisi',
    digestTitle: 'Älä missaa mitään',
    digestSub: 'Saat aamuisin klo 8 lyhyen koonnin päivän tapahtumista, uutisista ja suosikkiyrityksistäsi sähköpostiisi.',
    digestEmailPlaceholder: 'sähköposti@esimerkki.fi',
    digestSubmitBtn: 'Tilaa',
    digestPrivacyNote: 'Voit peruuttaa tilauksen milloin tahansa jokaisen viestin lopusta löytyvällä linkillä.',
    digestSuccessMsg: 'Tarkista sähköpostisi ja vahvista tilaus klikkaamalla lähettämäämme linkkiä.',
    digestErrorInvalidEmail: 'Tarkista sähköpostiosoite.',
    digestErrorGeneric: 'Jokin meni pieleen. Yritä hetken kuluttua uudelleen.',
    digestToastConfirmed: 'Kiitos! Tilauksesi on nyt vahvistettu.',
    digestToastUnsubscribed: 'Tilaus peruutettu. Et saa enää koonteja.',
    digestToastInvalid: 'Linkki ei ole enää voimassa.',
    accountVerifyConfirmed: 'Kiitos! Sähköpostiosoitteesi on nyt vahvistettu.',
    accountVerifyInvalid: 'Vahvistuslinkki ei ole enää voimassa.',
    favoritesSub: 'Tallennetut yritykset yhdessä paikassa.',
    favoritesEmpty: 'Ei vielä tallennettuja suosikkeja. Paina sydäntä yrityksen kohdalla tallentaaksesi sen.',
    favoritesTabFavorites: 'Suosikkisi',
    favoritesTabRecent: 'Katsomasi äskettäin',
    recentlyViewedEmpty: 'Ei vielä katsottuja yrityksiä. Käy yrityksen sivulla, niin se näkyy täällä.',
    favoriteToggleLabel: 'Tallenna suosikiksi',
    askAiDisclaimer: 'Vastaukset ovat tekoälyn tuottamia ja voivat sisältää virheitä.',
    askFeedbackPrompt: 'Oliko tästä apua?',
    askFeedbackCommentPlaceholder: 'Mikä meni pieleen? (valinnainen)',
    askFeedbackSend: 'Lähetä palaute',
    askFeedbackThanks: 'Kiitos palautteesta!',
    siteFeedbackLink: 'Anna palautetta palvelusta',
    siteFeedbackTitle: 'Anna palautetta palvelusta',
    siteFeedbackSub: 'Mikä toimii, mikä ei, mitä toivoisit lisää -- kaikki kelpaa.',
    siteFeedbackPlaceholder: 'Kerro mielipiteesi...',
    siteFeedbackEmailPlaceholder: 'Sähköposti (valinnainen, jos toivot vastausta)',
    siteFeedbackSend: 'Lähetä palaute',
    siteFeedbackEmptyErr: 'Kirjoita viesti ensin.',
    siteFeedbackThanksTitle: 'Kiitos palautteesta!',
    siteFeedbackThanksSub: 'Luemme jokaisen viestin -- tämä auttaa meitä kehittämään palvelua.',
    askMentionsNote: 'maksanut mainostaja tällä alustalla -- ei tavallinen hakutulos',
    askAdvertiserTag: 'Mainostaja',
    askFollowupPlaceholder: 'Kysy jotain muuta…',
    installBannerTextChrome: 'Asenna PaikallisCanvas puhelimeesi nopeampaa käyttöä varten.',
    installBannerButton: 'Asenna',
    installBannerTextIOS: 'Lisää PaikallisCanvas kotinäytöllesi: napauta jakamispainiketta ja valitse "Lisää Koti-valikkoon".',
    askThinking: 'Mietitään…',
    askError: 'Jokin meni pieleen. Kokeile hetken kuluttua uudelleen.',
    askRateLimited: 'Liian monta kysymystä tänään -- kokeile huomenna uudelleen.',
    askNeedLogin: 'Päivän 5 ilmaista kysymystä on käytetty (palautuu klo 00 Suomen aikaa). Kirjaudu sisään jatkaaksesi tai osta lisää.',
    askNeedCredits: 'Päivän ilmaiset kysymykset on käytetty (palautuu klo 00 Suomen aikaa). Osta 5 lisää 0,99 €:lla.',
    askLoginBtn: 'Kirjaudu / rekisteröidy',
    askBuyCreditsBtn: 'Osta 5 lisää -- 0,99 €',
    loginBtnLabel: 'Kirjaudu',
    authLoginTitle: 'Kirjaudu sisään',
    authRegisterTitle: 'Luo tili',
    authSub: 'Kirjautuneena saat 5 ilmaista tekoälykysymystä päivässä (palautuu joka yö klo 00 Suomen aikaa) ja voit ostaa lisää.',
    authEmailPlaceholder: 'Sähköposti',
    authPasswordPlaceholder: 'Salasana (väh. 8 merkkiä)',
    authNewPasswordPlaceholder: 'Uusi salasana (väh. 8 merkkiä)',
    authConsentLabel: 'Saa käyttää hakujani ja klikkauksiani suositusten personointiin. Vapaaehtoista -- voit peruuttaa milloin vain poistamalla tilisi.',
    authLoginButton: 'Kirjaudu',
    authRegisterButton: 'Luo tili',
    authForgotLink: 'Unohditko salasanan? <a onclick="setAuthMode(\'forgot\')">Palauta se</a>',
    authForgotTitle: 'Palauta salasana',
    authForgotButton: 'Lähetä palautuslinkki',
    authForgotSentMessage: 'Jos tämä sähköposti on rekisteröity, lähetimme sille palautuslinkin.',
    authVerifySentMessage: 'Tarkista sähköpostisi ja vahvista tilisi klikkaamalla lähettämäämme linkkiä ennen kirjautumista.',
    authUnverifiedError: 'Vahvista sähköpostiosoitteesi ennen kirjautumista -- tarkista postilaatikkosi.',
    authResendVerificationBtn: 'Lähetä vahvistuslinkki uudelleen',
    authResetTitle: 'Aseta uusi salasana',
    authResetButton: 'Tallenna uusi salasana',
    authBackToLogin: 'Takaisin <a onclick="setAuthMode(\'login\')">kirjautumiseen</a>',
    authSwitchToRegister: 'Eikö sinulla ole tiliä? <a onclick="setAuthMode(\'register\')">Rekisteröidy</a>',
    authSwitchToLogin: 'Onko sinulla jo tili? <a onclick="setAuthMode(\'login\')">Kirjaudu</a>',
    authAccountTitle: 'Oma tili',
    authBuyCredits: 'Osta 5 lisää -- 0,99 €',
    authLogout: 'Kirjaudu ulos',
    authDeleteAccount: 'Poista tilini',
    authDeleteConfirm: 'Tämä poistaa tilisi ja kaikki siihen liittyvät tiedot pysyvästi. Jatketaanko?',
    authGenericError: 'Jokin meni pieleen. Yritä uudelleen.',
    newsSectionTitle: 'Tuoreimmat uutiset',
    eventsSectionTitle: 'Tapahtumat tänään',
    noEventsThisWeek: 'Ei tiedossa olevia tapahtumia tälle viikolle.',
    featuredBadge: 'Suositeltu',
    weatherSourceNote: 'Sää: Open-Meteo.com',
    showMore: 'Näytä lisää',
    showLess: 'Näytä vähemmän',
    otherTown: 'Etsitkö toista kaupunkia? →',
    townPlaceholder: 'Kaupungin nimi (esim. Tampere)',
    viewBoard: 'Katso taulu →',
    claimedOf: '{n} / {t} mainospaikkaa varattu',
    modalTitle: 'Varaa banneripaikat',
    lCompany: 'Yrityksen nimi', lWebsite: 'Verkkosivun osoite <span style="font-weight:400;color:var(--ink-dim);">(valinnainen, jos ei vielä ole)</span>',
    lEmail: 'Sähköposti — kuittia ja tilauksen hallintaa varten',
    lLogo: 'Logo <span style="font-weight:400;color:var(--ink-dim);">(valinnainen)</span>',
    chooseFile: '📁 Valitse kuva puhelimesta/koneelta',
    autofillLoading: 'Haetaan tietoja sivultasi…',
    autofillFound: 'Löysimme tietoja sivultasi ja täytimme ne puolestasi ✓',
    cropHint: 'Siirrä ja zoomaa kuvaa niin, että se sopii valitsemasi alueen muotoon.',
    useThisCrop: '✓ Käytä tätä rajausta',
    logoSelected: 'Logo valittu ✓',
    removeLogo: 'Poista',
    lLogoUrl: 'Tai liitä kuvan osoite <span style="font-weight:400;color:var(--ink-dim);">(jos et lataa tiedostoa)</span>',
    uploading: 'Ladataan…',
    lTagline: 'Lyhyt iskulause <span style="font-weight:400;color:var(--ink-dim);">(valinnainen, näkyy sivullasi)</span>',
    lAddress: 'Yrityksen osoite <span style="font-weight:400;color:var(--ink-dim);">(pakollinen, näkyy kartalla)</span>',
    addressPlaceholder: 'Katuosoite, kaupunki',
    lPlanType: 'Maksutapa',
    planMonthly: 'Kuukausitilaus',
    planPrepaid: 'Maksa etukäteen',
    twoMonthsFree: '2 kk ilmaiseksi',
    prepaidRenewNote: 'Kertamaksu, ei automaattista uusiutumista. Banneripaikat ovat käytössä valitsemasi ajanjakson loppuun asti.',
    prepaidConfirmText: 'Vahvistan, että tämä on rekisteröity yritys. Kertamaksu {price}€ ({months} kk), ei automaattista uusiutumista.',
    lAdditionalTowns: 'Julkaise myös muissa kaupungeissa',
    additionalTownsHint: 'Sama ilmoitus, lisää kaupunkeja — valitse mainospaikkojen määrä per kaupunki, järjestelmä valitsee ne puolestasi.',
    additionalTownPlaceholder: 'Kaupungin nimi…',
    lIndustry: 'Toimiala',
    indRavintola: 'Ravintola ja kahvila', indKauneus: 'Kauneus ja hyvinvointi',
    indRakentaminen: 'Rakentaminen ja remontointi', indTerveys: 'Terveys ja lääkäripalvelut',
    indKauppa: 'Vähittäiskauppa', indAjoneuvot: 'Ajoneuvot ja korjaamo',
    pickIndustry: '— Valitse toimiala —',
    indIt: 'IT ja digitaaliset palvelut', indKoulutus: 'Koulutus',
    indKiinteisto: 'Kiinteistö ja asuminen', indTalous: 'Lakipalvelut ja talous',
    indTapahtumat: 'Tapahtumat ja viihde', indMuu: 'Muu',
    indKuljetus: 'Kuljetus ja logistiikka', indSiivous: 'Siivous ja kotipalvelut',
    indElainlaakari: 'Eläinlääkäri ja lemmikkipalvelut', indValokuvaus: 'Valokuvaus ja media',
    indMatkailu: 'Matkailu ja majoitus', indUrheilu: 'Urheilu ja liikunta',
    indKasityo: 'Käsityö ja taide', indMaatalous: 'Maatalous ja puutarha',
    allCategories: 'Kaikki toimialat',
    confirmText: 'Vahvistan, että tämä on rekisteröity yritys. Ensimmäinen kuukausi -50% ({halfPrice}€), sen jälkeen {price}€/kk kunnes peruutan.',
    confirmTextNoTrial: 'Vahvistan, että tämä on rekisteröity yritys. Veloitus {price}€/kk, kunnes peruutan.',
    trialNote: '🎉 -50% ensimmäisestä kuukaudesta',
    legalLinkText: 'Ehdot ja tietosuoja',
    legalTitle: 'Ehdot ja tietosuoja',
    legalBody: `<p><b>Palvelun tarjoaa:</b> PaikallisCanvas, Y-tunnus 3637817-9.</p>
      <p><b>Yhteystiedot:</b> <a href="mailto:paikalliscanvas@gmail.com">paikalliscanvas@gmail.com</a></p>
      <p><b>Mitä saat:</b> kiinteän banneripaikan kaupunkisi PaikallisCanvas-taulusta, joka linkittää antamaasi verkko-osoitteeseen, sekä oman erillisen verkkosivun. Näkyvillä heti maksun jälkeen.</p>
      <p><b>Peruuttamisoikeus:</b> vahvistamalla ostoksen yritysostoksi, vahvistat ettei kuluttajansuojalain 14 päivän peruutusoikeus sovellu, ja että näkyvyys alkaa heti.</p>
      <p><b>Sisältö:</b> voimme poistaa minkä tahansa ilmoituksen harkintamme mukaan (esim. laiton, haitallinen tai harhaanjohtava sisältö) ilman hyvitystä.</p>
      <p><b>Sisällön oikeudet:</b> lisäämällä logon tai muuta sisältöä vahvistat, että sinulla on oikeus käyttää sitä. Vastaat itse siitä, ettei sisältösi loukkaa kolmannen osapuolen oikeuksia; voimme poistaa epäillyn loukkauksen ilmoituksen perusteella.</p>
      <p><b>Tekoäly:</b> hakuvastaukset ja yritysten "automaattisesti löydetty tieto" -kuvaukset ovat tekoälyn tuottamia tai koostamia ja voivat satunnaisesti sisältää virheitä. Tarkista tärkeät tiedot (esim. aukioloajat) suoraan yritykseltä. Yritykset voivat muokata tai poistaa oman kuvauksensa hallintapaneelissa (/manage).</p>
      <p><b>Tiedot:</b> tallennamme yrityksen nimen, sähköpostin ja verkko-osoitteen tilauksen toimittamista ja laskutusta varten, sekä IP-osoitteita väärinkäytösten estämiseksi (esim. varauslukot, kirjautumisyritysten ja tekoälyhaun rajoitus). Väärinkäytöslokit säilytetään vain muutamia kuukausia. Käytämme tietojen käsittelyyn seuraavia palveluntarjoajia: Stripe (maksut), Supabase (tietokanta) ja Anthropic (tekoälyvastaukset ja -kuvaukset). Emme myy tietoja eteenpäin. Ota yhteyttä yllä olevaan sähköpostiin tietojesi tarkastamiseksi tai poistamiseksi.</p>
      <p><b>Maksut:</b> käsittelee Stripe. Emme näe tai tallenna korttitietojasi.</p>`,
    perMonth: ' / kk',
    thenPerMonth: 'sitten {price}€/kk',
    renewNote: 'Uusiutuu automaattisesti. Peruuta milloin vain — banneripaikat vapautuvat takaisin.',
    continueBtn: 'Jatka maksuun →',
    footerText: 'paikallinen tekoälyopas',
    fillRequired: 'Täytä yrityksen nimi, verkkosivu ja sähköposti.',
    addressRequiredErr: 'Yrityksen osoite on pakollinen — se näkyy kartalla.',
    confirmRequired: 'Vahvista, että tämä on yritystilaus, ennen kuin jatkat.',
    invalidUrl: 'Verkkosivun osoite vaikuttaa virheelliseltä — muista https://',
    redirecting: 'Ohjataan maksuun…',
    takenErr: 'Yksi valituista banneripaikoista vietiin juuri — yritä uudelleen.',
    networkErr: 'Verkkovirhe — yritä uudelleen.',
    townNotAvailable: 'Tätä kaupunkia ei ole vielä avattu. Aloitamme Oulusta ja laajennamme pian.',
    squareTitle: '{n} paikkaa — {town}',
    squareTitleOne: '1 paikka — {town}',
    qtyLabel: 'Kuinka ison mainospaikan haluat?',
    qtySizePreviewNote: 'Näin logosi näkyy taulussa (suuntaa antava). Jokainen mainospaikka on samankokoinen.',
    todayCardMockupLabel: 'Näin näyttäisit koko "Tänään"-kortilla, jonka moni jakaa somessa:',
    todayCardMockupTag: 'Mainos',
    todayCardMockupText: 'Yrityksesi oma teksti tähän',
    todayCardMockupDate: 'Perjantai 31. heinäkuuta',
    todayCardMockupEventsLabel: 'Suosituimmat tapahtumat',
    todayCardMockupEvent1: '① klo 18.00 · Kesäteatteri',
    todayCardMockupEvent2: '② klo 19.00 · Kesäkonsertti',
    todayCardMockupEvent3: '③ klo 16.00 · Perhepiknik',
    claimTitle: 'Varaa mainospaikka — 29,90€/kk',
    cancelSelection: 'Peruuta',
    continueSelection: 'Jatka →',
    squaresSelected: '{n} paikkaa · {price}€/kk',
    squareSelected: '1 paikka · {price}€/kk',
    noSuggestion: 'Kaupunkia ei löytynyt tietokannasta — voit silti hakea sitä, taulu luodaan automaattisesti.'
  },
  en: {
    pitchEyebrow: 'Room for your business here?',
    logoBannerEmpty: 'Be the first business on the board!',
    heroTitle: 'Put your business in front of <span>all of Oulu.</span>',
    heroSub: "PaikallisCanvas is a shared online board for Oulu's businesses — every ad slot is a different company. Visibility comes from two places: real Oulu residents browsing the board for the day's news, events and weather, and your business getting its own showcase page that can turn up on Google entirely on its own — even if nobody ever opens the board itself. We can't guarantee either one: board traffic depends on site usage, and Google visibility on the search engine's own rules. Either way, a slot is just €29.90/month, you add your own logo and link, and there's no contract to lock you in.",
    value1b: '€29.90/month',
    value1: 'a fraction of a typical monthly social media ad budget',
    value2b: 'Findable on Google', value2: 'your business gets its own showcase page on our site that can appear in search results, even if nobody browses the board itself',
    value3b: 'Cancel anytime', value3: 'no contract period, no notice period',
    value4b: 'See real visitor counts', value4: "not just a promise -- every time someone opens your page, you'll see it on your own dashboard",
    volumeNote: '€29.90/mo per slot. Every slot is the same size.',
    factsTitle: 'Why local visibility matters',
    fact1: 'of all Google searches are for something local',
    fact2: 'of people who search for something "nearby" visit a business within 24 hours',
    fact3: 'of consumers search online for local businesses before doing business with them',
    factsNote: 'Source: Google / Think with Google, BrightLocal. These figures describe general search behavior, not a promise about the traffic this specific service will bring your business.',
    earlyBanner: "🚀 50% off your first month! Just launched — join early and get top visibility before the board fills up.",
    hiwTitle: 'How it works',
    hiw2: 'Choose how many ad slots to get',
    hiw3: 'Fill in your business details and pay securely via Stripe',
    hiw4: 'Your slot and its showcase page go live right after payment',
    faqTitle: 'Frequently asked questions',
    faqQ1: 'Is this a legitimate service?',
    faqA1: 'Payments are processed by Stripe, used by millions of businesses worldwide — we never see or store your card details.',
    faqQ2: 'What do I actually get for my money?',
    faqA2: 'A ad slot on the community board with your own logo, plus your own showcase page on our site that links directly to your actual business website.',
    faqQ3: 'Can I cancel anytime?',
    faqA3: 'Yes. It\'s a monthly subscription with no fixed term. When you cancel, your slot stays live until the end of the period you\'ve already paid for, then it\'s freed up.',
    faqQ4: 'Are listings checked?',
    faqA4: 'Yes — every listing is automatically screened before it goes live, and inappropriate content can be removed at any time.',
    faqQ5: 'Will I show up on Google right away?',
    faqA5: 'Your page goes live immediately, but search engine indexing can take anywhere from a few days to a couple of weeks — we can\'t promise an exact timeline or ranking.',
    faqQ6: 'Monthly subscription or one-time payment — which is better?',
    faqA6: 'Both work on the same slot. The monthly subscription bills every month and you can cancel anytime. Prepaid lets you pay for a 3, 6, or 12-month term upfront at a discount (12 months = 2 months free) — it doesn\'t auto-renew, so there\'s nothing to remember to cancel.',
    eventsSourceNote: 'Source: Kaleva',
    viewAllEventsLink: 'see all events ↗',
    eventsCountOne: '1 event today',
    eventsCountMany: '{count} events today',
    newsCatOulu: 'Oulu region',
    newsCatUusimmat: 'Latest',
    newsCatPohjoisSuomi: 'Northern Finland',
    newsCatKotimaa: 'Domestic',
    newsCatUlkomaat: 'World',
    askHeroTitle: 'Everything in Oulu<br>in one place',
    askHeroSub: 'Find events, businesses, news, deals, and local services with ease.',
    askHeroPlaceholder: 'What would you like to do today?',
    askHeroButton: 'Ask',
    askReopenChatBtn: 'Show conversation',
    askDesktopChatTitle: 'Ask the AI guide',
    askClearChatBtn: 'Clear',
    askClearChatBtnLabel: 'Clear conversation',
    nearbyTitle: 'Near you',
    nearbySub: 'Show local businesses sorted from nearest to farthest based on your location.',
    nearbyUseLocationBtn: 'Use my location',
    nearbyPrivacyNote: "Your location isn't stored -- it's only used to sort this list, in your browser.",
    nearbyLocating: 'Finding your location…',
    nearbyErrorUnsupported: "Your browser doesn't support location lookup.",
    nearbyErrorDenied: "Location access denied. Check both your browser's site permission (browser settings) and your device's location services (system settings) -- either one being off causes this same error.",
    nearbyErrorFailed: 'Could not get your location. Please try again.',
    nearbyEmpty: 'No businesses with location data yet.',
    favoritesTitle: 'Your favorites',
    digestTitle: "Don't miss anything",
    digestSub: "Get a short daily digest at 8am -- today's events, news, and your favorited businesses -- straight to your inbox.",
    digestEmailPlaceholder: 'your@email.com',
    digestSubmitBtn: 'Subscribe',
    digestPrivacyNote: 'You can unsubscribe anytime using the link at the bottom of every email.',
    digestSuccessMsg: 'Check your inbox and confirm your subscription by clicking the link we sent.',
    digestErrorInvalidEmail: 'Please check your email address.',
    digestErrorGeneric: 'Something went wrong. Please try again in a moment.',
    digestToastConfirmed: "Thanks! Your subscription is now confirmed.",
    digestToastUnsubscribed: "You've been unsubscribed and won't receive more digests.",
    digestToastInvalid: 'That link is no longer valid.',
    accountVerifyConfirmed: 'Thanks! Your email address is now verified.',
    accountVerifyInvalid: 'That verification link is no longer valid.',
    favoritesSub: 'Saved businesses, all in one place.',
    favoritesEmpty: 'No favorites saved yet. Tap the heart on a business to save it.',
    favoritesTabFavorites: 'Favorites',
    favoritesTabRecent: 'Recently viewed',
    recentlyViewedEmpty: "No businesses viewed yet. Visit a business's page and it'll show up here.",
    favoriteToggleLabel: 'Save as favorite',
    askAiDisclaimer: 'Answers are AI-generated and may contain errors.',
    askFeedbackPrompt: 'Was this helpful?',
    askFeedbackCommentPlaceholder: "What went wrong? (optional)",
    askFeedbackSend: 'Send feedback',
    askFeedbackThanks: 'Thanks for the feedback!',
    siteFeedbackLink: 'Give feedback about the service',
    siteFeedbackTitle: 'Give feedback about the service',
    siteFeedbackSub: "What's working, what isn't, what you'd like to see -- anything goes.",
    siteFeedbackPlaceholder: 'Tell us what you think...',
    siteFeedbackEmailPlaceholder: 'Email (optional, if you want a reply)',
    siteFeedbackSend: 'Send feedback',
    siteFeedbackEmptyErr: 'Write a message first.',
    siteFeedbackThanksTitle: 'Thanks for the feedback!',
    siteFeedbackThanksSub: 'We read every message -- it genuinely helps us improve the service.',
    askMentionsNote: 'a paying advertiser on this platform -- not an ordinary search result',
    askAdvertiserTag: 'Advertiser',
    askFollowupPlaceholder: 'Ask something else…',
    installBannerTextChrome: 'Install PaikallisCanvas on your phone for faster access.',
    installBannerButton: 'Install',
    installBannerTextIOS: 'Add PaikallisCanvas to your home screen: tap the share button, then choose "Add to Home Screen".',
    askThinking: 'Thinking…',
    askError: 'Something went wrong. Please try again in a moment.',
    askRateLimited: 'Too many questions today -- try again tomorrow.',
    askNeedLogin: "Today's 5 free questions are used up (resets at midnight Finland time). Log in to keep going, or buy more.",
    askNeedCredits: "Today's free questions are used up (resets at midnight Finland time). Buy 5 more for €0.99.",
    askLoginBtn: 'Log in / register',
    askBuyCreditsBtn: 'Buy 5 more -- €0.99',
    loginBtnLabel: 'Log in',
    authLoginTitle: 'Log in',
    authRegisterTitle: 'Create an account',
    authSub: "Logged in, you get 5 free AI questions a day (resets every night at midnight Finland time) and can buy more.",
    authEmailPlaceholder: 'Email',
    authPasswordPlaceholder: 'Password (8+ characters)',
    authNewPasswordPlaceholder: 'New password (8+ characters)',
    authConsentLabel: "Allow my searches and clicks to be used to personalize recommendations. Optional -- you can withdraw anytime by deleting your account.",
    authLoginButton: 'Log in',
    authRegisterButton: 'Create account',
    authForgotLink: 'Forgot your password? <a onclick="setAuthMode(\'forgot\')">Reset it</a>',
    authForgotTitle: 'Reset password',
    authForgotButton: 'Send reset link',
    authForgotSentMessage: "If that email is registered, we've sent it a reset link.",
    authVerifySentMessage: 'Check your inbox and confirm your account by clicking the link we sent before logging in.',
    authUnverifiedError: 'Please verify your email before logging in -- check your inbox.',
    authResendVerificationBtn: 'Resend verification link',
    authResetTitle: 'Set a new password',
    authResetButton: 'Save new password',
    authBackToLogin: 'Back to <a onclick="setAuthMode(\'login\')">login</a>',
    authSwitchToRegister: 'No account yet? <a onclick="setAuthMode(\'register\')">Register</a>',
    authSwitchToLogin: 'Already have an account? <a onclick="setAuthMode(\'login\')">Log in</a>',
    authAccountTitle: 'My account',
    authBuyCredits: 'Buy 5 more -- €0.99',
    authLogout: 'Log out',
    authDeleteAccount: 'Delete my account',
    authDeleteConfirm: 'This permanently deletes your account and all associated data. Continue?',
    authGenericError: 'Something went wrong. Please try again.',
    newsSectionTitle: 'Latest news',
    eventsSectionTitle: 'Events today',
    noEventsThisWeek: 'No known events for this week.',
    featuredBadge: 'Featured',
    weatherSourceNote: 'Weather: Open-Meteo.com',
    showMore: 'Show more',
    showLess: 'Show less',
    otherTown: 'Looking for another town? →',
    townPlaceholder: 'Enter your town (e.g. Tampere)',
    viewBoard: 'View board →',
    claimedOf: '{n} / {t} slots claimed',
    modalTitle: 'Claim your ad slots',
    lCompany: 'Company name', lWebsite: 'Website URL <span style="font-weight:400;color:var(--ink-dim);">(optional, if you don\'t have one yet)</span>',
    lEmail: 'Contact email — for your receipt & managing the subscription',
    lLogo: 'Logo <span style="font-weight:400;color:var(--ink-dim);">(optional)</span>',
    chooseFile: '📁 Choose an image from your phone/computer',
    autofillLoading: 'Fetching info from your site…',
    autofillFound: 'Found info on your site and filled it in for you ✓',
    cropHint: 'Drag and zoom the image to fit the shape of the area you selected.',
    useThisCrop: '✓ Use this crop',
    logoSelected: 'Logo selected ✓',
    removeLogo: 'Remove',
    lLogoUrl: 'Or paste an image URL <span style="font-weight:400;color:var(--ink-dim);">(if you don\'t upload a file)</span>',
    uploading: 'Uploading…',
    lTagline: 'Short tagline <span style="font-weight:400;color:var(--ink-dim);">(optional, shown on your page)</span>',
    lAddress: 'Business address <span style="font-weight:400;color:var(--ink-dim);">(required, shown on the map)</span>',
    addressPlaceholder: 'Street address, city',
    lPlanType: 'Payment plan',
    planMonthly: 'Monthly subscription',
    planPrepaid: 'Pay upfront',
    twoMonthsFree: '2 months free',
    prepaidRenewNote: 'One-time payment, no auto-renewal. Slots stay live until the end of the term you picked.',
    prepaidConfirmText: 'I confirm this is a registered business. One-time payment of €{price} ({months} months), no auto-renewal.',
    lAdditionalTowns: 'Also post in additional towns',
    additionalTownsHint: 'Same listing, more towns — choose how many slots per town, automatically placed for you.',
    additionalTownPlaceholder: 'Town name…',
    lIndustry: 'Industry',
    indRavintola: 'Restaurant and café', indKauneus: 'Beauty and wellness',
    indRakentaminen: 'Construction and renovation', indTerveys: 'Health and medical',
    indKauppa: 'Retail', indAjoneuvot: 'Vehicles and repair',
    pickIndustry: '— Choose an industry —',
    indIt: 'IT and digital services', indKoulutus: 'Education',
    indKiinteisto: 'Real estate and housing', indTalous: 'Legal and financial services',
    indTapahtumat: 'Events and entertainment', indMuu: 'Other',
    indKuljetus: 'Transport and logistics', indSiivous: 'Cleaning and home services',
    indElainlaakari: 'Veterinary and pet services', indValokuvaus: 'Photography and media',
    indMatkailu: 'Tourism and accommodation', indUrheilu: 'Sports and fitness',
    indKasityo: 'Crafts and art', indMaatalous: 'Agriculture and garden',
    allCategories: 'All categories',
    confirmText: 'I confirm this is a registered business. First month 50% off (€{halfPrice}), then €{price}/month until I cancel.',
    confirmTextNoTrial: 'I confirm this is a registered business, billed €{price}/month until I cancel.',
    trialNote: '🎉 50% off first month',
    legalLinkText: 'Terms & Privacy',
    legalTitle: 'Terms & Privacy',
    legalBody: `<p><b>This service is provided by:</b> PaikallisCanvas, Business ID (Y-tunnus) 3637817-9.</p>
      <p><b>Contact:</b> <a href="mailto:paikalliscanvas@gmail.com">paikalliscanvas@gmail.com</a></p>
      <p><b>What you get:</b> a fixed ad slot on your town's PaikallisCanvas board, linking to the URL you provide, plus its own separate webpage. Live immediately after payment.</p>
      <p><b>Right of withdrawal:</b> by confirming this as a business purchase, you confirm the EU consumer 14-day withdrawal right does not apply, and that visibility begins immediately.</p>
      <p><b>Content:</b> we may remove any listing at our discretion (e.g. illegal, harmful, or misleading content) without refund.</p>
      <p><b>Content rights:</b> by adding a logo or other content, you confirm you have the right to use it. You're responsible for ensuring your content doesn't infringe anyone else's rights; we may remove suspected infringing content on request.</p>
      <p><b>AI content:</b> search answers and businesses' "automatically found" descriptions are AI-generated or AI-assembled and can occasionally be inaccurate. Please verify important details (e.g. opening hours) directly with the business. Businesses can edit or remove their own description in the self-service dashboard (/manage).</p>
      <p><b>Data:</b> we store your company name, email, and website URL to fulfil and bill the subscription, plus IP addresses to prevent abuse (e.g. reservation limits, login attempts, and the AI search's rate limit). Abuse-prevention logs are kept for a few months at most. We use the following processors to handle this data: Stripe (payments), Supabase (database), and Anthropic (AI answers and descriptions). We don't sell this data. Contact the email above to review or delete your data.</p>
      <p><b>Payments:</b> handled by Stripe. We never see or store your card details.</p>`,
    perMonth: ' / month',
    thenPerMonth: 'then €{price}/month',
    renewNote: 'Renews automatically. Cancel anytime — your slots open back up.',
    continueBtn: 'Continue to payment →',
    footerText: 'your local AI guide',
    fillRequired: 'Please fill in company name, website and email.',
    addressRequiredErr: 'A business address is required — it will be shown on the map.',
    confirmRequired: 'Please confirm this is a business subscription before continuing.',
    invalidUrl: 'Website URL looks invalid — include https://',
    redirecting: 'Redirecting to payment…',
    takenErr: 'One of the auto-assigned slots was just taken — please try again.',
    networkErr: 'Network error — please try again.',
    townNotAvailable: "This town isn't open yet. We're starting with Oulu and will expand soon.",
    squareTitle: '{n} slots — {town}',
    squareTitleOne: '1 slot — {town}',
    qtyLabel: 'How big an ad slot would you like?',
    qtySizePreviewNote: 'How your logo will show on the board (approximate). Every slot is the same size.',
    todayCardMockupLabel: 'How you\'d look on the whole "Today" card, which a lot of people share on social media:',
    todayCardMockupTag: 'Ad',
    todayCardMockupText: 'Your own text goes here',
    todayCardMockupDate: 'Friday, July 31',
    todayCardMockupEventsLabel: 'Top events today',
    todayCardMockupEvent1: '① 6:00 PM · Summer theater',
    todayCardMockupEvent2: '② 7:00 PM · Summer concert',
    todayCardMockupEvent3: '③ 4:00 PM · Family picnic',
    claimTitle: 'Claim an ad slot — €29.90/month',
    cancelSelection: 'Cancel',
    continueSelection: 'Continue →',
    squaresSelected: '{n} slots · €{price}/mo',
    squareSelected: '1 slot · €{price}/mo',
    noSuggestion: "Town not in our list — you can still search it, the board is created automatically."
  }
};

function t(key){ return STRINGS[lang][key] || key; }

/* ---- PWA install banner ---- */
const INSTALL_DISMISS_KEY = 'installBannerDismissed';
let deferredInstallPrompt = null;
let installBannerMode = null;

function isStandaloneApp(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOSDevice(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function installBannerDismissed(){
  try { return localStorage.getItem(INSTALL_DISMISS_KEY) === '1'; } catch (e) { return false; }
}

function showInstallBanner(mode){
  if (isStandaloneApp() || installBannerDismissed()) return;
  installBannerMode = mode;
  const banner = document.getElementById('installBanner');
  const textEl = document.getElementById('installBannerText');
  const btn = document.getElementById('installBannerBtn');
  if (mode === 'prompt'){
    textEl.textContent = t('installBannerTextChrome');
    btn.textContent = t('installBannerButton');
    btn.style.display = 'inline-block';
  } else {
    textEl.textContent = t('installBannerTextIOS');
    btn.style.display = 'none';
  }
  banner.style.display = 'flex';
}

// Chrome/Edge/Android: this fires only once the browser's own
// installability criteria are met (manifest + service worker present,
// served over https). We suppress the browser's default mini-infobar
// and show our own banner instead, so there's an actual, discoverable
// "Install" option on the page rather than relying on people finding it
// buried in the browser's own menu.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner('prompt');
});

document.getElementById('installBannerBtn').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById('installBanner').style.display = 'none';
});

document.getElementById('installBannerClose').addEventListener('click', () => {
  document.getElementById('installBanner').style.display = 'none';
  try { localStorage.setItem(INSTALL_DISMISS_KEY, '1'); } catch (e) {}
});

window.addEventListener('appinstalled', () => {
  document.getElementById('installBanner').style.display = 'none';
});

// iOS Safari never fires beforeinstallprompt at all -- "Add to Home
// Screen" only exists behind the manual share-sheet there, so this is
// the only way those visitors ever find out it's possible.
if (isIOSDevice() && !isStandaloneApp()) {
  showInstallBanner('ios');
}

/* ---- light/dark theme toggle ---- */
const ICON_SUN = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
const ICON_MOON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeToggle').innerHTML = theme === 'light' ? ICON_MOON : ICON_SUN;
  try { localStorage.setItem('theme', theme); } catch (e) {}
}
document.getElementById('themeToggle').addEventListener('click', ()=>{
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  applyTheme(current === 'light' ? 'dark' : 'light');
});
// sync the button's icon with whatever the early head-script already applied
applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

document.getElementById('legalLink').addEventListener('click', (e)=>{
  e.preventDefault();
  document.getElementById('legalOverlay').style.display = 'flex';
});
document.getElementById('legalClose').addEventListener('click', ()=>{
  document.getElementById('legalOverlay').style.display = 'none';
});
document.getElementById('legalOverlay').addEventListener('click', (e)=>{
  if (e.target.id === 'legalOverlay') e.currentTarget.style.display = 'none';
});

document.getElementById('companyInfoCta').addEventListener('click', ()=>{
  document.getElementById('companyInfoOverlay').style.display = 'flex';
});
document.getElementById('bizFeedCta').addEventListener('click', ()=>{
  document.getElementById('companyInfoOverlay').style.display = 'flex';
});
document.getElementById('companyInfoClose').addEventListener('click', ()=>{
  document.getElementById('companyInfoOverlay').style.display = 'none';
});
document.getElementById('companyInfoOverlay').addEventListener('click', (e)=>{
  if (e.target.id === 'companyInfoOverlay') e.currentTarget.style.display = 'none';
});

function setLang(l){
  lang = l;
  document.documentElement.lang = l;
  document.getElementById('langFi').classList.toggle('active', l === 'fi');
  document.getElementById('langEn').classList.toggle('active', l === 'en');
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    el.innerHTML = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  // Single-instance need -- not worth a generic data-i18n-aria-label
  // pattern for just this one button. data-i18n above already handles
  // its visible text.
  const clearChatBtn = document.getElementById('askNewChatBtn');
  if (clearChatBtn){
    clearChatBtn.setAttribute('aria-label', t('askClearChatBtnLabel'));
    clearChatBtn.setAttribute('title', t('askClearChatBtnLabel'));
  }
  sortSelectOptions('fIndustry', null);
  updateClaimedMeta();
  updateSelectionBar();
  renderLocalFeed(currentFeedItems);
  renderWeatherForecast();
  if (installBannerMode) showInstallBanner(installBannerMode);
}

// Alphabetically sorts a <select>'s options using proper locale rules for
// the current language -- Finnish Ä/Ö sort after Z, not mixed in with A,
// which a plain string sort would get wrong. Re-run every language switch,
// since "alphabetical" means a different order in each language.
function sortSelectOptions(selectId, keepFirstValue){
  const select = document.getElementById(selectId);
  if (!select) return;
  const options = Array.from(select.options);
  const pinned = keepFirstValue !== null ? options.filter(o => o.value === keepFirstValue) : [];
  const rest = keepFirstValue !== null ? options.filter(o => o.value !== keepFirstValue) : options;
  rest.sort((a, b) => a.textContent.localeCompare(b.textContent, lang === 'fi' ? 'fi' : 'en'));
  select.innerHTML = '';
  pinned.concat(rest).forEach(o => select.appendChild(o));
}

// The {n}/{t} display this used to update is gone -- capacity auto-grows
// server-side (see api/_squares.js) rather than being a real cap, so
// showing "X / 100 claimed" was misleading rather than informative.
// Kept as a no-op function rather than removing the call sites entirely,
// since capacity might become worth surfacing again later in an honest way.
function updateClaimedMeta(){
  // intentionally empty
}

/* ---- town search + autocomplete ---- */
const townInput = document.getElementById('townInput');
const suggestionsBox = document.getElementById('suggestions');

townInput.addEventListener('input', ()=>{
  const val = townInput.value.trim().toLowerCase();
  suggestionsBox.innerHTML = '';
  if (!val){ suggestionsBox.classList.remove('open'); return; }
  const matches = FINNISH_CITIES
    .filter(c => c.name.toLowerCase().startsWith(val))
    .sort((a,b) => b.population - a.population)
    .slice(0, 8);
  if (matches.length === 0){ suggestionsBox.classList.remove('open'); return; }
  matches.forEach(c=>{
    const row = document.createElement('div');
    row.className = 'suggestion';
    row.innerHTML = `<span>${c.name}</span><span class="pop">${c.population.toLocaleString()}</span>`;
    row.addEventListener('click', ()=>{
      townInput.value = c.name;
      suggestionsBox.classList.remove('open');
      openBoard(c.name, 'FI', c.population);
    });
    suggestionsBox.appendChild(row);
  });
  suggestionsBox.classList.add('open');
});
document.addEventListener('click', (e)=>{
  if (!e.target.closest('#searchWrap')) suggestionsBox.classList.remove('open');
});

document.getElementById('searchBtn').addEventListener('click', ()=>{
  const val = townInput.value.trim();
  if (!val) return;
  const match = FINNISH_CITIES.find(c => c.name.toLowerCase() === val.toLowerCase());
  openBoard(match ? match.name : val, 'FI', match ? match.population : null);
});
townInput.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter') document.getElementById('searchBtn').click();
});

async function openBoard(name, country, population){
  const errBox = document.getElementById('homeErr');
  errBox.style.display = 'none';
  resetQuantitySelection();
  try{
    let url = `${API_BASE}/town?name=${encodeURIComponent(name)}&country=${encodeURIComponent(country||'FI')}`;
    if (population) url += `&population=${population}`;
    if (previewMode) url += `&admin=1`; // means nothing without a real admin cookie -- see api/town.js's isAdminRequest check
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok){
      errBox.textContent = data.error === 'not_available' ? t('townNotAvailable') : (data.error || t('networkErr'));
      errBox.style.display='block';
      return;
    }
    currentTown = data.town;
    document.getElementById('townPillName').textContent = currentTown.name;
    applyContentOverrides(currentTown.id); // layers this town's own overrides on top of the shared defaults already applied in init()

    // Fire-and-forget visit counter for the admin dashboard -- never
    // awaited, never allowed to affect the real page load either way.
    fetch(`${API_BASE}/admin/track-visit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ townId: currentTown.id })
    }).catch(() => {});
    // Clean, shareable URL -- strips the "-fi" country suffix from the
    // internal database slug (e.g. "oulu-fi" -> "/oulu"). Vercel needs a
    // matching explicit rewrite entry for each town's clean slug (see
    // vercel.json) -- deliberately not a generic wildcard, which would
    // risk shadowing /admin, /manage, and /generate-hash.
    const cleanSlug = currentTown.slug.replace(/-[a-z]{2}$/i, '');
    history.pushState({}, '', previewMode ? `/${cleanSlug}?preview=1` : `/${cleanSlug}`);
    // Keeps the canonical tag correct for whichever town this actually
    // is, not just the static Oulu default in the raw HTML -- matters
    // once more than one town is public, so each gets treated as its
    // own real page rather than a duplicate of Oulu's.
    if (!previewMode) {
      const canonicalEl = document.getElementById('canonicalLink');
      if (canonicalEl) canonicalEl.href = `https://www.paikalliscanvas.fi/${cleanSlug}`;
      // Same reasoning, kept in sync with the canonical tag above --
      // og:url was previously only ever the static Oulu default. Real
      // limitation worth knowing: this is a client-side update, so it
      // only helps crawlers that actually execute JS -- most social
      // platforms still see whatever's in the raw HTML on first fetch,
      // the same limitation the canonical tag itself already has.
      const ogUrlEl = document.getElementById('ogUrlLink');
      if (ogUrlEl) ogUrlEl.content = `https://www.paikalliscanvas.fi/${cleanSlug}`;
    }
    document.getElementById('boardTitle').textContent = currentTown.name;
    await loadBoard();
  }catch(e){
    errBox.textContent = t('networkErr');
    errBox.style.display = 'block';
  }
}

let currentFeedItems = { news: [], events: [] };
let currentNewsCategory = 'rss-uusimmat';

// Height-matching between each grid row's two cards (events/Tilannehuone,
// news/business) is now handled entirely by #homeGrid's own
// align-items:stretch -- a shorter card automatically fills its row's
// full height at the CSS level, with nothing that depends on JS running
// at the right moment relative to events/news/Tilannehuone/business each
// loading independently. An earlier version of this function tried to
// do the same thing by measuring and setting explicit pixel heights in
// JS, which turned out to be fragile in practice. Kept as a no-op rather
// than removing every call site, since calling it is harmless and some
// of those call sites still make sense as "something relevant just
// changed" hooks if this ever needs real logic again.
function syncColumnHeights(){
  // intentionally empty
}
