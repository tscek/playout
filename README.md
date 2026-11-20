# Playout

Aplikacija za predvajanje medijev v živih produkcijah (Windows).

## Zasnova

- **Motor:** [CasparCG Server](https://github.com/CasparCG/server) (odprtokodni playout strežnik, ki ga uporabljajo televizije).
  Teče kot ločen proces, aplikacija ga zažene, nadzoruje in ob sesutju samodejno znova zažene ter vrne na program, kar je bilo tam.
  Sinhronizacijo slike in zvoka ureja motor (zvok in slika gresta skozi isto uro kanala).
- **Aplikacija:** Electron. Glavni proces (`main/`) upravlja motor prek protokola AMCP, vmesnik (`ui/`) je spletna stran,
  ki jo prikaže okno aplikacije in jo bo kasneje lahko odprla tudi tablica v istem omrežju.
- **Izhodi:** vsak izhod je okno brez robov čez cel izbran zaslon (key & fill = dva taka izhoda, eden v načinu "key-only").

## Mape

| Mapa | Vsebina |
|---|---|
| `main/engine/` | zagon in nadzor CasparCG, AMCP odjemalec, seznam zaslonov, konfiguracija |
| `main/controller.js` | stanje aplikacije, knjižnica, ukazi |
| `main/server.js` | HTTP + WebSocket za vmesnik |
| `ui/` | vmesnik |
| `assets/test-media/` | testni posnetki (A/V sinhronizacija) |
| `dev/mock-caspar/` | navidezni motor za teste brez Windows |

## Razvoj

```
npm install
npm test                 # testi z navideznim motorjem
PLAYOUT_CASPAR_DIR=dev/mock-caspar npm start
```

Windows namestitveni program zgradi GitHub Actions (zavihek Actions → zadnji zagon → Artifacts → Playout-Setup).
