# Test v0.10.0: okno vnosa, fade, obremenjenost

Namesti novo verzijo čez staro.

## Novo v 0.10.0

1. **Okno z nastavitvami vnosa**: ⚙ pri vnosu v playlisti ali *⚙ Vnos* / *▤ Plasti* pod preview odpre plavajoče okno.
   Zavihki: *Slika in barve*, *Plasti*, *Čas in konec*, *Zvok*. Okno premakneš z vlečenjem za naslovno vrstico (zapomni si mesto).
   Medtem lahko normalno delaš (Enter = CUT, preslednica = AUTO, ko nisi v polju za vnos). Urejaš lahko tudi vnos, ki ni v preview.
2. **Fade**: privzeto 0,5 s na začetku (pri CUT) in na koncu posnetka ali pred OUT, slika in zvok.
   Privzeto vrednost spremeniš v Nastavitvah, za posamezen vnos pod *Čas in konec* (prazno = privzeto, 0 = brez).
   Pri AUTO in samodejnem nadaljevanju s prelivom se fade ne dela (prehod že preliva). Premik drsnika na programu po fade-u vrne sliko.
3. **Plasti so vidne**: v glavi preview in programa piše *▤ 1 plast* ipd., pri vnosu v playlisti ▤ s številom.
4. **Obremenjenost** spodaj levo: CPU, RAM, grafična (če jo Windows ali NVIDIA sporoči) in **Motor x / 50 sl/s**:
   koliko sličic motor res izriše. Če je število manjše od zahtevanega (rdeče), slika trza. Pošlji mi, kaj piše, ko trza.

# v0.9.0: plasti in filtri

## Novo v 0.9.0

1. **Barve in prosojnost**: pod ▣ Slika so zdaj še *Prosojnost, Svetlost, Kontrast, Nasičenost* in *Ponastavi barve*.
   Velja za vnos v playlisti. Sprememba se vidi takoj v preview in tudi na programu, če je ta vnos tam.
2. **Plasti** (▤ Plasti pod preview): nad osnovnim posnetkom vnosa lahko dodaš več medijev, ki se predvajajo hkrati
   (logo, slika, drug video). Dodaš jih tako, da medij **povlečeš na sliko preview** ali ga izbereš in klikneš *+ Plast*.
3. Pri izbrani plasti: *Velikost, Levo/desno, Gor/dol, Prosojnost, Mešanje* (multiply, screen, darken, lighten, overlay …),
   *Svetlost, Kontrast, Nasičenost*, pri videu *ponavljaj* in *brez zvoka*. 👁 skrije plast, ▲▼ spremeni vrstni red, ✕ odstrani.
   Zgornja plast v seznamu je spredaj. Slike s prosojnim ozadjem (PNG) ostanejo prosojne.
4. Plasti gredo na program skupaj z vnosom: pri CUT takoj, pri AUTO in samodejnem nadaljevanju s prelivom.
   Ko gre na program vnos brez plasti, prejšnje plasti zbledijo.
5. Položaj, barve, mešanje in 👁 veljajo takoj tudi na programu, če je isti vnos v preview
   (klikni vnos v playlisti, da ga naložiš v preview). Dodana ali odstranjena plast velja na programu ob naslednjem predvajanju.
6. Pri vnosu v playlisti oznaka ▤ s številom plasti.

Preveri: logo PNG kot plast, video v manjšem okvirju (slika v sliki), multiply in screen, ali je računalnik bolj obremenjen.

# v0.8.0: projekti in projektna mapa

## Novo v 0.8.0

1. Zgoraj levo je gumb **📁 ime projekta**. Tam so vsi projekti, *+ Nov projekt*, ime, medijska mapa, izvoz in uvoz.
2. **Medijska mapa**: klikni *Izberi mapo …* (ali "Izberi mapo" nad Mediji). Mediji levo so potem vse datoteke iz te mape
   in podmap. Nova datoteka, ki jo dodaš v Raziskovalcu, se pojavi sama (v nekaj sekundah), izbrisana izgine.
   Če je izbrisana datoteka v playlisti, ostane na seznamu rdeče.
3. **Podmape**: klik na mapo jo zloži/razloži in izbere. **+ Mapa** naredi novo podmapo v izbrani mapi.
   Medij povleci na mapo in se premakne tja, tudi na disku. Premik ali preimenovanje v Raziskovalcu playlista prenese.
4. **Povleci datoteke od drugje** (npr. z namizja ali USB ključa) v Medije: kopirajo se v projektno mapo
   (v mapo, na katero jih spustiš). Med kopiranjem piše "Kopiram …". Tudi *+ Dodaj medije* kopira v izbrano mapo.
5. **Filter** Vse / Video / Slike / Zvok in **razvrščanje** po imenu, vrsti ali najnovejše najprej.
6. **✕ pri mediju** iz projektne mape premakne datoteko v koš (vpraša prej).
7. **Preklop projekta**: *Odpri* pri projektu. Program in preview se počistita (če je kaj na programu, vpraša).
8. **Izvoz**: *Izvozi projekt …* naredi majhno datoteko `.playout` (playlista, nastavitve vnosov, akcije, brez medijev).
   **Uvoz** na drugem računalniku: *Uvozi projekt …*, izberi datoteko, nato mapo z mediji. Posnetki se povežejo po poti
   ali po imenu, tudi če so drugače razporejeni. Naprave, ki jih tam še ni, se dodajo; IP naslove popraviš v Akcijah.
9. **⚠ zgoraj** pomeni, da naprava za akcije (ATEM, XR18) ni povezana. Klik odpre Akcije.
10. LOOP pri mediju je odstranjen. Ponavljanje nastaviš pri vnosu (⚙, *ponavljaj posnetek*). Vnosi medijev, ki so imeli LOOP, so prestavljeni nanj.

Preveri: projekt z mapo na drugem disku ali USB-ju, kopiranje večjega videa, premik datoteke, ki je v playlisti, in uvoz na prenosniku.

# v0.7.0: nastavitve pripadajo vnosu v playlisti

## Novo v 0.7.0

1. **Mediji** so samo seznam datotek. Posnetek, naložen iz Medijev, vidiš s privzetimi nastavitvami.
   IN, OUT, ▣ Slika, jakost in 🔊 so takrat zaklenjeni (namig: dodaj v playlisto).
2. **Vnos v playlisti** ima svoje nastavitve: IN/OUT, jakost, mute, prileganje, povečavo in premik.
   Isto datoteko lahko dodaš dvakrat (ali v dve skupini) in vsak vnos ima svoje nastavitve.
3. Pri vnosu so oznake: 🔇 utišan, jakost v dB, ▣ spremenjena postavitev.
4. Nastavitve, ki si jih prej shranil k mediju (jakost, mute, prileganje), so prenesene na vse vnose tega medija.
   IN/OUT, nastavljen samo pri mediju (brez playliste), se ne prenese.

Preveri: dodaj isti posnetek dvakrat, enemu nastavi drugačen IN/OUT, jakost in povečavo, in ali se drugi ne spremeni.

# v0.6.0: predvajanje, prileganje slike, mute

## Novo v 0.6.0

1. **Predvajaj / ustavi**: pod preview in programom je gumb ▶ / ❚❚. V preview lahko posnetek pogledaš, na programu ga ustaviš in nadaljuješ.
   Ustavljen program ne gre samodejno naprej, dokler ga ne nadaljuješ.
2. **Koraki**: gumbi −1s, −1f, +1f, +1s premaknejo playhead za sekundo ali sličico (sličica po hitrosti posnetka).
   Tipki **,** in **.** premikata preview po sličici, s Shift po sekundo.
3. **IN/OUT**: playhead po označitvi ostane, kjer je. Pri vnosu (⚙) lahko točko še popraviš za sličico ali sekundo.
4. **Slike s trajanjem** imajo na programu odštevanje kot video (oranžno zadnjih 10 s).
5. **Zvočnik**: klik na 🔊 pri preview/programu utiša vnos (shrani se k vnosu), klik na 🔊 pri Glavni jakosti utiša cel izhod.
6. **Prileganje**: video ali slika, ki ni 16:9, se ne raztegne več, ampak ohrani razmerje (črni robovi).
   Gumb **▣ Slika** pod preview: *Ohrani razmerje*, *Zapolni* (obreže robove) ali *Raztegni*, povečava in premik levo/desno, gor/dol.
   Nastavitev se shrani k vnosu v playlisti. Vidiš jo v preview, na programu velja ob naslednjem predvajanju.
   Preveri, ali je računalnik pri tem bolj obremenjen (pri videih, ki niso 16:9 ali so povečani, sliko preračuna ffmpeg).

## 0. Akcije (novo v 0.5.0)

1. Zgoraj klikni **Akcije**.
2. Pri **Naprave** klikni **+ ATEM** in vpiši IP naslov ATEM-a. Ko se poveže, zasveti zelena pika in piše model.
   Enako za **+ XR18 mešalna miza** (IP naslov mize).
3. Klikni **+ Akcija**, jo poimenuj (npr. "Nazaj na kamero 1") in dodaj korake:
   - ATEM: *AUTO na vhod* ali *CUT na vhod* (izbereš vhod po imenu), *AUX izhod na vhod*, makro, fade to black.
   - XR18: utišaj ali vklopi kanal, bus, glavni LR, DCA; mute skupine 1 do 4; fader na vrednost v dB.
   - HTTP ali OSC ukaz za druge naprave, *Počakaj* za premor med koraki.
4. **▶ Preizkusi** jo takoj izvede. Če kaj ne uspe, se izpiše zakaj.
5. Akcije z obkljukanim *gumb zgoraj* so gumbi pod zgornjo vrstico za ročni zagon.
6. Pripni jo na vnos v playlisti: gumb **⚙** pri vnosu, *Akcija ob začetku* (ko gre vnos na program)
   ali *Akcija ob koncu* (ko se video konča ali doseže OUT). Pri koncu lahko nastaviš, koliko sekund prej se sproži,
   da je npr. ATEM prehod končan točno ob koncu videa.
   Akcija ob koncu se ne sproži, če vnos prej zamenjaš sam.

Preveri na ATEM-u: ali preklop pride ob pravem trenutku in ali AUX preklopi pravilno.
Preveri na XR18: ali se kanali in skupine utišajo in ali fader pride na pravo vrednost.

## A. Playlist in skupine

1. Spodaj sta zdaj dva dela: levo **Mediji** (vse datoteke), desno **Playlist** (vrstni red za oddajo).
2. Medij dodaš v skupino tako, da ga povlečeš v skupino, ali klikneš **+** pri mediju
   (gre v skupino, ki je obrobljena modro; skupino izbereš s klikom nanjo).
3. **+ Skupina** doda novo skupino. Ime spremeniš s klikom na ime.
4. Vrstni red: povleci vnos na novo mesto (tudi v drugo skupino) ali uporabi ▲ ▼.
5. Klik na vnos ga naloži v PREVIEW. **▶ v preview** naloži prvi posnetek skupine.
6. Po CUT/AUTO gre v preview naslednji iz iste skupine. Na koncu skupine gre prvi iz naslednje skupine.
   Če je vklopljeno **ponavljaj**, gre spet prvi iz iste skupine.
7. Puščici gor/dol se premikata po playlisti, če je trenutni posnetek iz nje.

## B. Kaj se zgodi na koncu posnetka

1. Pri skupini izbereš **na koncu**: *ustavi*, *naprej s CUT* ali *naprej s prehodom* (prehod, izbran na sredini).
   To velja za vse vnose v skupini. Na koncu skupine se ustavi (razen če je vklopljeno *ponavljaj*).
2. Vsak vnos ima gumb **⚙**. Tam lahko izbereš svoj konec: *kot skupina*, *ustavi*, *naprej s CUT*,
   *naprej s prehodom* ali *ponavljaj posnetek*. Vnos s svojo nastavitvijo gre naprej tudi v naslednjo skupino.
3. Ko je naslednji pripravljen, da gre sam, piše v preview "sledi samodejno", pri vnosu pa SLEDI.
4. Med tem lahko kadar koli pritisneš CUT/AUTO ali naložiš kaj drugega v preview. Potem samodejno ne nadaljuje.
5. Skupino zložiš s puščico ▾ pred imenom.

## Trajanje slik

1. Pri skupini je privzeto trajanje slike ("slika … s").
2. Pri vnosu slike lahko pod ⚙ vpišeš svoje trajanje. Prazno pomeni privzeto trajanje skupine.

## IN in OUT točka

1. Posnetek naloži v preview, zapelji drsnik pod preview in klikni **IN** ali **OUT**.
2. Točki se shranita k vnosu v playlisti. Na drsniku je oranžna črta.
3. Desni klik na IN ali OUT točko pobriše (ali ✕ pod ⚙ pri vnosu).
4. Posnetek se potem začne na IN in konča na OUT. Preostali čas in samodejno naprej se računata do OUT.
   Pri *ponavljaj posnetek* se ponavlja samo del med IN in OUT.

## C. Premik po posnetku

1. Pod PROGRAM je drsnik: povleci ga in video na izhodu skoči tja.
2. Pod PREVIEW je drsnik za začetno točko: od tam se posnetek začne ob CUT/AUTO.

## D. Zvok

1. Pod vsakim monitorjem je 🔊 drsnik za jakost tega vnosa. Shrani se k vnosu v playlisti.
   Na programu se spremeni takoj, pri AUTO se jakost lepo prelije.
2. Na sredini je **Glavna jakost** za cel program. Skrajno levo pomeni utišano.

## E. Panika

1. Zgoraj **PANIKA**: program gre takoj na črno in brez zvoka. Gumb utripa. Ponoven klik vse vrne.
2. Video pod tem teče naprej.
3. V Nastavitvah pri **PANIKA prikaže** lahko namesto črne izbereš sliko (npr. logo) iz seznama medijev.

## Kaj mi pošlješ

- Ali je samodejno naprej točno na koncu videa ali na OUT točki (brez črne vmes, brez zamrznjene sličice).
- Ali sta drsnika (premik, jakost) dovolj natančna za delo v živo.
- Kar koli, kar ti pri delu ni logično ali bi želel drugače.
