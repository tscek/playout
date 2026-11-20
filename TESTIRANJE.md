# Test 1. koraka

Cilj: preveriti, da se aplikacija namesti, motor zažene in da video teče na drugem zaslonu z zvokom, brez zamika med sliko in zvokom.

## Namestitev

1. Prenesi `Playout-Setup-….exe` (povezavo dobiš v pogovoru).
2. Zaženi ga. Ker program (še) ni digitalno podpisan, Windows lahko pokaže modro okno "Windows je zaščitil vaš računalnik".
   Klikni **Več informacij** → **Vseeno zaženi**.
3. Po namestitvi se Playout zažene sam. Zgoraj levo mora čez nekaj sekund pisati zeleno **Motor: teče**.

## Test A: brez drugega zaslona

1. **Nastavitve** → spodaj **Dodaj testne posnetke**. Zapri nastavitve.
2. Klikni `AV-sync-test-1080p50.mp4` in pritisni **PREDVAJAJ IZBRANO** (ali Enter).
3. Odpre se okno "Playout PROGRAM (test)". Vsako sekundo mora zasvetiti bel kvadrat in hkrati zapiskati.
   Če pisk zaostaja ali prehiteva blisk, mi napiši, za približno koliko.
4. Pritisni **POČISTI PROGRAM** (ali Esc). Okno ostane, a je črno.

## Test B: drugi zaslon (ATEM ali monitor prek docka)

1. Priklopi zaslon na HP Dock G4.
2. **Nastavitve** → **Osveži seznam zaslonov** → pri **Izhod PROGRAM** izberi zunanji zaslon → **Shrani**.
   Motor se za trenutek ponovno zažene.
3. Predvajaj testni video. Slika mora biti čez cel zunanji zaslon, brez robov in brez miške.
4. Pri **Zvočni izhod** po želji izberi drugo napravo in ponovi.

## Test C: zanesljivost

1. Med predvajanjem odpri Upravitelja opravil (Ctrl+Shift+Esc), poišči **casparcg.exe** in klikni **Končaj opravilo**.
   V nekaj sekundah se mora motor sam znova zagnati in video nadaljevati približno tam, kjer je bil.

## Kaj mi pošlješ

- Kaj je delovalo in kaj ne (dovolj je nekaj besed).
- Če se motor ne zažene: **Dnevnik** → posnetek zaslona ali kopija zadnjih vrstic.
