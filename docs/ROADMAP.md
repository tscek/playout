# Načrt

Faza 1 (zdaj): playout jedro. Kasnejše faze in kako je zasnova pripravljena nanje:

- **HTML lower-third predloge** – CasparCG HTML producer (CEF); predloge v mapi `templates` motorja, sloji nad videom.
- **Ure in odštevanja** – HTML predloge na lastnem sloju.
- **Opozorilo streaming + snemanje + playout** – preverjanje obremenitve ob zagonu.
- **ATEM** – ločen modul v glavnem procesu (protokol UDP 9910).
- **PTZ** – modul, ki govori z ESP32-S3 PTZ kontrolerjem prek USB COM porta, protokol v [PTZ_USB_PROTOCOL.md](PTZ_USB_PROTOCOL.md):
  port odpreti z RTS deasserted (DTR asserted), JSON vrstice, `move` pošiljati 20–50 Hz med premikom
  (watchdog 500 ms), ob spustu poslati ničelni `move` ali `stop`; upoštevati napake `pgm`, `lock`, `joystick_active`.
- **Kamere** (Sony/Panasonic) – ločen modul na kamero.
