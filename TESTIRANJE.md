# Test v0.17.0: osebe (tabele za napise), GO in DOL poleg CUT/AUTO

Namesti novo verzijo čez staro. Vsebuje tudi vse iz v0.16.0 (opis spodaj).

1. **NAPIS / GRAFIKA poleg CUT in AUTO**: pokaže, kaj je naslednje (oseba ali vnos iz seznama Čez program).
   **GO** da napis na program, **DOL** umakne vse, ◀ ▶ izbereta prejšnjega ali naslednjega. Pod gumboma je seznam, kaj je zdaj
   na programu (klik na vrstico = samo ta dol). V polje *št. osebe* vpišeš številko in Enter. Številko lahko kar vtipkaš,
   kadar ni izbrano nobeno polje. Bližnjice v Nastavitvah: *Napis: GO*, *vse dol*, *naslednji*, *prejšnji*.
2. **Zavihek Osebe** (levo spodaj): tabele oseb. **+** naredi novo tabelo, **✎ Uredi tabelo** jo odpre kot Excel:
   - piši kar v celice; Ctrl+C / Ctrl+V kopira in prilepi (tudi več vrstic in stolpcev iz Excela ali Google Sheets),
     Delete pobriše, Shift+klik ali vlečenje izbere več celic, Enter potrdi, Tab gre desno;
   - stolpci: ime in vrsta (besedilo, država (zastava), slika iz Medijev, kamera / akcija); dodaš jih z **+ stolpec**;
   - stolpec **#**: številka za klic. Prazno = zaporedna, lahko pa vpišeš svojo (npr. 10);
   - **Država**: ime ali koda (Slovenija, SLO, SI, Croatia ...). Napis pokaže zastavo (deluje brez interneta);
   - **Slika**: ime slike iz Medijev (npr. fotografija ali grb), napis jo pokaže kot logotip;
   - **Kamera**: ime akcije ali preseta (npr. PTZ preset za to osebo); sproži se ob pripravi, ob GO ali nikoli (nastavitev zgoraj);
   - zgoraj izbereš **napis-vzorec** (predloga, barve, velikost, položaj iz zavihka Napisi) in kaj gre v naslov in podnaslov,
     npr. naslov `{Ime}`, podnaslov `{Funkcija}, {Klub}` (prazni stolpci ne pustijo odvečnih vejic);
   - Uvozi / Izvozi CSV (Excel: *Shrani kot CSV*).
3. **V živo**: v zavihku Osebe klik na osebo = pripravi (vidiš jo v preview), dvoklik = takoj na program.
   Vpis številke + Enter = pripravi, GO = na program. Nova oseba zamenja prejšnjo. Če popraviš podatek, ko je napis na programu,
   se popravi takoj.
4. **Tablica**: v razdelku napisov je 🔢 številčnica: vpiši številko in *Pripravi*, nato GO.
5. Companion: `/api/person/10` pripravi osebo 10, `/api/overlay/go`, `/api/overlay/off`, `/api/overlay/next`.

# Test v0.16.0: potek prireditve (akcije v playlisti, seznam Čez program), novi napisi

Namesti novo verzijo čez staro. Vsebuje tudi vse iz v0.15.1 (opis spodaj).

1. **Akcije v playlisti**: v glavi skupine klikni **+ akcija** in izberi akcijo ali preset (ATEM, PTZ, XR18 ...).
   Vrstica AKCIJA traja 0 s in se sproži, ko playlista pride do nje:
   - akcija **za posnetkom** se sproži, ko se posnetek konča (ali ko ga zamenja naslednji), npr. *video → ATEM nazaj na kamero*;
   - akcija **pred posnetkom** se sproži, ko gre posnetek na program, npr. *ATEM AUX na playout → video*;
   - polje **+ s** = koliko sekund pozneje; ▶ = sproži takoj (za preizkus). Akcije s puščicami ▲▼ ali vlečenjem postaviš kamorkoli.
   - Preview in puščici gor/dol akcije preskočita (v preview gre vedno naslednji posnetek).
2. **Seznam Čez program** (spodaj v playlisti): napisi in grafike, ki gredo čez program in ga ne zamenjajo
   (npr. napis čez motion background, ki teče naprej).
   - Dodaš z **+ napis** ali **+ grafika** (video/slika iz Medijev) ali tako, da napis ali medij povlečeš v seznam.
   - **GO ▶** da naslednjega (oranžni okvir, NEXT) čez program, prejšnjega iz seznama umakne. Klik na vrstico = ta je naslednji,
     dvoklik ali ▶ = takoj čez program, ■ = dol, **Vse dol** = vse iz seznama dol.
   - ⚙ pri vrstici: *dol po X s*, *ostane ob naslednjem* (npr. logo ali ura ostane, ko greš na naslednji napis),
     za grafike še *konec* (izgine / ostane zadnja sličica / ponavlja), velikost, položaj, prosojnost, zvok.
   - Bližnjice v Nastavitvah: *Čez program: GO* in *Čez program: vse dol*. Companion: `/api/overlay/go`, `/api/overlay/off`.
   - Na tablici je seznam v zavihku Napisi.
   - **Prosim, preizkusi s svojimi motion grafikami** (MOV s prosojnostjo, npr. ProRes 4444, ali WebM z alfo):
     ali je ozadje prosojno in ali se predvajajo gladko.
3. **Napisi bolj nastavljivi** (urejanje napisa): velikost naslova in podnaslova posebej, VELIKE ČRKE, svoja pisava,
   svoja barva podnaslova. Deluje pri vseh predlogah (tudi lastnih, če imata polji id f0 in f1).
4. **8 novih predlog**:
   - animirani lower thirdi: *črta*, *poševni bloki* (z oznako V ŽIVO), *zaobljen z logom*, *črka za črko*;
   - glavna naslova: *z grafiko v ozadju* (izbereš sliko ali video iz Medijev, slika se počasi približuje) in *otvoritev* (barvni prelet čez cel zaslon);
   - *Na vrsti* (točka programa v kotu) in *Odjavna špica* (vrstice loči z |, naslov skupine začni z #, npr. `#Nastopajoči|Ana|Bor`).
   - Video v ozadju naslova naj bo WebM; MP4 v napisih morda ne deluje.

# Test v0.15.1: popravki po prvem testu

1. **Slideshow, nastavitve kasneje**: v glavi skupine je gumb ⚙ (poleg trajanja slike), ki odpre isto okno kot pri ustvarjanju.
2. **Zoom pri slideshowu**: vsaka slika se zdaj sama počasi približuje (vsakič proti drugemu delu slike) in se med prehodom
   približuje naprej, zato ob menjavi nič ne skoči. Vse slike gredo noter (nobena ven).
   - Prosim, preveri, ali zoom teče gladko in ali je obremenjenost procesorja (spodaj CPU) v redu. Zoom računa procesor.
3. **Širina Mediji / Playlist**: povleci navpično črto med njima (dvoklik = pol-pol). Zapomni si.
4. **Položaj napisa**: v urejanju napisa sta drsnika *Levo / desno* in *Gor / dol*. Napis se med vlečenjem premika v živo
   (tudi na programu). Dvoklik na drsnik = nazaj na privzeto mesto.

# Test v0.15.0: PTZ prek USB, lastne predloge napisov

Namesti novo verzijo čez staro. Vsebuje tudi vse iz v0.14.0 (opis spodaj): slideshow, ATEM ploščo, presete, napis na vnosu.

## Novo v 0.15.0

1. **PTZ prek USB kontrolerja (ESP32)**: priklopi kontroler z USB kablom (nativni USB port ESP32-S3) na računalnik.
   V oknu *Akcije* klikni **+ PTZ kontroler (USB)**. Polje *USB (COM)* pusti prazno: aplikacija sama najde ESP32
   (če ga ne, vpiši vrata, npr. `COM5`; seznam se pokaže v polju). Ob povezavi kontroler ne sme narediti ponovnega zagona.
   - Zavihek **PTZ** levo spodaj (in na tablici): kamere z imeni iz kontrolerja, rdeča = na programu, zelena = v preview
     (iz ATEM prek kontrolerja), modri okvir = izbrana. Tap na kamero jo izbere (kot na iPadu).
   - **Joystick**: drži in vleci krog (levo/desno, gor/dol); desno je **zoom** (gor TELE, dol WIDE). Ko spustiš, se kamera ustavi.
     Če se povezava z aplikacijo prekine, kamera v manj kot pol sekunde obstane sama.
   - **Preseti** izbrane kamere z imeni iz kontrolerja (tap = pojdi). *Shrani trenutni položaj kot preset*: številka in ime.
   - **STOP** ustavi vse kamere, **Zakleni** vklopi isti zaklep kot rdeči STOP na iPadu.
   - Rumena vrstica pove, zakaj se kamera ne premakne (na programu, zaklep, v uporabi je fizični joystick).
   - PTZ preseti so tudi v *Preseti iz naprav* (okno Akcije): kot gumb akcije, bližnjica, akcija na začetku vnosa (npr. kamera gre na Govornika, ko se začne video).
   - **Prosim, preveri na kontrolerju** (nisem ga mogel preizkusiti na pravi napravi): ali se ob povezavi ESP32 ne resetira,
     ali joystick tekoče premika vse tri vrste kamer, in ali iPad in fizični joystick delujeta kot prej.
2. **Lastne predloge napisov**: v zavihku Napisi gumb **📁 Moje predloge** odpre mapo (z navodili *PREBERI.txt* in primerom).
   Datoteke .html iz te mape se po kliku na **⟳** pokažejo med predlogami z oznako *(moja)*. Predlogo ti lahko naredim jaz: opiši ali pošlji sliko, kako naj izgleda.
3. **Novi predlogi**: *Tekoči trak (novice)* (več novic loči z znakom |) in *Naslov oddaje v kotu* (z utripajočo oznako, npr. V ŽIVO).

# Test v0.14.0: slideshow, plošča ATEM, preseti, napisi na vnosu

Namesti novo verzijo čez staro. Vsebuje tudi vse iz v0.13.0 in v0.12.0 (opisi spodaj).

## Novo v 0.14.0

1. **Slideshow**: v Medijih izberi mapo s slikami (ali poišči slike z iskanjem) in klikni **🖼 Slideshow**
   (ali 🖼 v vrstici mape). Izbereš ime, samodejno/ročno menjavo, trajanje slike, dinamični zoom, zamegljeno ozadje in ponavljanje.
   Nastane nova skupina v playlisti; *▶ v preview* in CUT/AUTO, pa gre naprej sam.
   - **Zamegljeno ozadje**: pokončne in ozke slike dobijo ob straneh isto sliko, močno zamegljeno in malo temnejšo (namesto črnine).
     Slike 16:9 ga ne potrebujejo. Velja tudi za posamezen vnos: ⚙ → *Slika in barve* → *Prileganje* → *Ohrani razmerje + zamegljeno ozadje*.
   - **Dinamični zoom**: slika se počasi približuje (vsakič proti drugemu delu slike), naslednja oddaljuje, in tako naprej.
     Pri prelivu nič ne poskoči.
   - V glavi skupine sta kljukici **zoom** in **zamegli** (vidni, če so v skupini slike).
   - Prosim, preveri na Windows: ali zoom teče gladko (brez trzanja) in kako hitro se pokažejo velike fotografije (npr. 24 MP iz fotoaparata).
2. **Plošča ATEM**: zavihek **ATEM** levo spodaj (poleg Napisov) in na tablici.
   Vrstici **PROGRAM** (rdeča) in **PREVIEW** (zelena) z imeni vhodov iz ATEM, **CUT**, **AUTO** (s črto napredka), **FTB** (utripa, ko je črno),
   vrsta prehoda MIX/DIP/WIPE, ključi **KEY 1–4** in **DSK** (vklop takoj ali *AUTO* s prehodom), **AUX**, makri.
   Barve se sproti osvežujejo tudi, ko preklapljaš na samem ATEM ali v ATEM Software Control.
   - ATEM dodaš v oknu *Akcije* (*+ ATEM*, IP naslov), če ga še nisi.
   - **Prosim, preveri na ATEM**: vse gumbe, in ali KEY/DSK ustrezajo tistim na mešalniku. Tega nisem mogel preizkusiti na pravem ATEM.
3. **Preseti** (okno *Akcije* → *Preseti*): ukazi, ki nastanejo sami iz imen v napravah, za vse projekte:
   ATEM (AUTO/CUT na vhod, preview, AUX, makri, FTB, DSK, KEY), XR18 (utišaj/vklopi kanal z imenom iz mize, buse, LR, DCA, mute group).
   - ▶ preset takoj izvede, ＋ iz njega naredi gumb akcije (ime sledi imenu v napravi).
   - Preseti so na voljo tudi kot *akcija ob začetku/koncu vnosa*, v bližnjicah, v koraku akcije in na tablici (zavihek *Akcije*).
   - Ko preimenuješ vhod v ATEM ali kanal na XR18, se ime preseta spremeni samo. Ko naprava ni povezana, se uporabi zadnje znano ime.
   - **Prosim, preveri na ATEM in XR18** (tega nisem mogel preizkusiti na pravi opremi).
4. **Napis na vnosu**: ⚙ pri vnosu → *Čas in konec* → **Napis**, *po* (sekunde od začetka) in *za* (koliko časa, 0 = ves vnos).
   Napis gre na zaslon z vnosom in dol, ko vnos zamenjaš. Če ima naslednji vnos isti napis, ostane (ne animira znova).
   Vnos z napisom ima v playlisti oznako *Aa*.
5. **Velikost napisa**: pri napisu (zavihek Napisi) izberi *Velikost* od 60 % do 150 %. Napis ostane ob istem robu zaslona.

# Test v0.13.0: key & fill za ATEM, tablica

Namesti novo verzijo čez staro. Vsebuje tudi napise iz v0.12.0 (opis spodaj).

## Novo v 0.13.0

1. **Key & fill** (Nastavitve → *Izhod KEY*): izberi drugi izhod računalnika (npr. drugi HDMI v ATEM).
   PROGRAM je *fill* (barvna slika), KEY je črno-bela slika prosojnosti (belo = vidno).
   - Na ATEM: Upstream Key → **Luma**, *Fill source* = vhod s PROGRAM, *Key source* = vhod s KEY, vklopi **Pre Multiplied Key**.
   - Na programu naj ne bo posnetka, samo napisi (posnetek čez cel zaslon da bel key, torej pokrije kamero).
   - V glavi monitorja PROGRAM piše *KEY + FILL*, ko je vklopljeno. Za preizkus brez ATEM izberi *Testno okno*.
   - **Prosim, preveri na ATEM**: ali se fill in key ujemata (robovi napisa brez črne obrobe, brez zamika ene sličice).
     Izhoda računalnika nista sinhronizirana med sabo; ATEM ju poravna, a to moram potrditi na tvoji opremi.
2. **Tablica / telefon** (Nastavitve → *Tablica*): obkljukaj *Dovoli upravljanje …*. Pokaže se naslov (npr. `http://192.168.1.20:8090/`)
   in 6-mestni **PIN**. Na tablici odpri naslov v brskalniku in vpiši PIN (zapomni si ga). Windows ob prvem vklopu vpraša za omrežje: *Zasebna omrežja*.
   - Mali monitor programa (5 sličic/s, gumb *Monitor* ga skrije), kaj je na PGM/PVW in koliko je še do konca.
   - **CUT**, **AUTO**, prejšnji/naslednji, pavza, zatemni.
   - Zavihki *Playlista* (tap = v preview), *Napisi* (tap = vklop/umik), *Akcije*.
   - **PANIKA** na tablici: za vklop jo drži pol sekunde (da je ne sprožiš po nesreči), izklop je en tap.
   - Tablica ne more brisati datotek ali spreminjati nastavitev. *Nov PIN* takoj odklopi stare tablice.
   - Na iPadu: v Safariju *Deli → Dodaj na začetni zaslon*, pa se odpre kot aplikacija čez cel zaslon.

# Test v0.12.0: napisi, celostna podoba, ura in odštevanje

Namesti novo verzijo čez staro.

## Novo v 0.12.0

1. **Zavihek Napisi** (levo spodaj, poleg Medijev). Napisi so neodvisni od playliste: gredo čez vse, kar je na programu,
   in ostanejo, dokler jih ne umakneš (ali po nastavljenih sekundah).
   - Izberi predlogo in klikni *+ Nov napis*. Spodaj vpišeš ime, funkcijo …
   - **VKLOPI** = napis z animacijo pride na program. **NA ZASLONU** (rdeče) = klik ga umakne z animacijo.
   - 👁 = napis v preview (ko klikneš napis v seznamu, se sam pokaže v preview). ⧉ podvoji, ✕ izbriše, vrstni red spreminjaš z vlečenjem.
   - Hkrati je lahko na zaslonu več napisov (npr. logotip v kotu + ime govorca). *Vsi dol* umakne vse.
   - Ko je napis na zaslonu in mu spremeniš besedilo, se spremeni ob Enter (da se tipkanje ne vidi v živo).
2. **Predloge**: *Klasični napis*, *Moderni napis (brez ozadja)*, *Pas čez cel zaslon* (z oznako, npr. V ŽIVO),
   *Naslov na sredini*, *Ura / odštevanje*, *Logotip v kotu*.
3. **🎨 Celostna podoba** (gumb v zavihku Napisi): **logotip** (slika iz Medijev, najbolje PNG s prosojnim ozadjem),
   **barve** (ozadje, poudarek, besedilo) in **pisava**. Velja za vse napise v projektu, vsak projekt ima svojo.
   Pri posameznem napisu lahko obkljukaš *svoje barve* ali izbereš drug logotip / brez logotipa.
4. **Ura / odštevanje**: trenutna ura, odštevanje do ure (npr. do 20:00), odštevanje trajanja (začne, ko ga vklopiš;
   na 00:00 utripa) ali štoparica. Položaj: kot zaslona ali velika na sredini.
5. **Bližnjice in Stream Deck**: v Nastavitvah lahko vsakemu napisu določiš tipko (vklop/umik) in tipko za *Vsi dol*.
   Companion: `/api/title/<ime>` (preklopi), `/api/title/<ime>/on`, `/api/title/<ime>/off`, `/api/titles/off`.
6. **Akcije**: nov korak *Napis* (vklopi / umakni / vsi dol). Tako lahko npr. ob začetku posnetka iz playliste pride napis
   ali pa en gumb hkrati preklopi ATEM in pokaže ime govorca.
7. Monitorja v glavi pokažeta, koliko napisov je na programu in kateri je v preview.

## Prosim, preveri

- Dodaj logotip stranke (PNG) v Medije, ga izberi v *Celostni podobi* in nastavi barve. Ali so napisi lepi na pravem zaslonu?
- Ali je velikost napisov prava (na 1080p)? Če želiš, dodam nastavitev velikosti.
- Če imaš kakšen napis, ki ga pogosto uporabljaš drugače (npr. dve osebi hkrati), mi pošlji sliko in naredim predlogo.

# Test v0.11.0: bližnjice, višina monitorjev, iskalnik

Namesti novo verzijo čez staro.

## Novo v 0.11.0

1. **Bližnjice po meri**: *Nastavitve → Bližnjice*. Klikni tipko ob ukazu (CUT, AUTO, PANIKA, naslednji/prejšnji, počisti, pavza …)
   in pritisni novo tipko ali kombinacijo (Ctrl/Alt/Shift + tipka). Esc prekliče. Ena tipka velja samo za en ukaz.
   Tipko lahko nastaviš tudi za vsako **akcijo** (ATEM, XR18 …) in za vsako **skupino** v playlisti (naloži prvi vnos skupine v preview).
   *Privzeto* vrne prvotne tipke. Na gumbih CUT/AUTO piše trenutna tipka.
2. **Globalne bližnjice** (kljukica v istem razdelku): F-tipke in kombinacije s Ctrl/Alt delujejo tudi, ko je v ospredju drug program
   (npr. OBS ali ATEM Software Control). Navadne tipke (Enter, preslednica) delujejo samo v Playout, da ne motijo drugih programov.
3. **Stream Deck / Bitfocus Companion**: v istem razdelku je naslov, npr. `http://IP:PORT/api/cut`.
   V Companion uporabi *Generic HTTP → GET* na `/api/cut`, `/api/auto`, `/api/next`, `/api/panic`, `/api/action/<ime akcije>`, `/api/group/<ime skupine>`.
   `/api/state` vrne, kaj je na programu in v preview.
4. **Višina monitorjev**: med monitorji in spodnjim delom je ločnica. Povleci jo gor ali dol. Zapomni si višino, dvoklik vrne privzeto.
5. **Iskalnik** nad Mediji: vpiši del imena, prikažejo se samo ujemajoče datoteke (z mapo, v kateri so). Esc počisti.
6. Popravek: po zaprtju okna (npr. Nastavitve) Enter ni več znova odprl okna, bližnjice delujejo takoj.

## Prosim, preveri

- Nastavi CUT na npr. F5, preklopi v drug program in pritisni F5 (z vklopljenimi globalnimi bližnjicami).
- Če imaš Stream Deck s Companion: en gumb na `/api/cut` in en na akcijo.

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
