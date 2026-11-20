# PTZ Controller — USB control protocol (v1)

> Copy of `C:\Users\VIDEO\ESP32\PTZ_Controller_S3\USB_PROTOCOL.md` (the source of truth is on the PC), 2026-11-20.
> Shranjeno v Playout za kasnejšo fazo PTZ. Pri razlikah velja izvirnik v PTZ projektu.

The controller (ESP32-S3, `PTZ_Controller_S3`) can be driven from a PC over its native USB port
(USB-Serial/JTAG, shows up as a COM port / `/dev/ttyACM*`). Commands go through the same internal
functions as the physical joystick, the web UI and the *Seja* page, so tally protection, the STOP lock
and joystick priority apply in exactly the same way.

## 1. Transport and line format

- USB CDC serial. The baud rate is ignored (any value works); use 115200.
- **One JSON object per line**, UTF-8, terminated by `\n` (a `\r` before it is ignored). Both directions.
- PC → controller lines may be at most **512 bytes**. Longer lines are rejected with `bad_arg`.
- Controller → PC lines can be longer (a full state or preset list is about 1–3 kB).
- **Ignore every line that does not start with `{`.** The ESP32 boot ROM prints plain text before the
  firmware starts, and a partial line can be left over in the host buffer when the port is opened.
  Also ignore any line that fails to parse as JSON.
- Every message from the controller has a `"t"` (type) field: `hello`, `ack`, `state`, `presets`, `evt`, `log`.
- **Opening the port:** open it with **RTS deasserted** (and DTR asserted). With the default pyserial
  open (RTS asserted) the ESP32-S3 USB-Serial/JTAG resets the controller. See the Python example.
- The controller only sends while a host has the port open. If nobody is connected, output is dropped
  and never blocks the controller.

### Request IDs

Every command may carry an optional `"id"` (number or string). The reply to that command carries the
same `"id"`. Unsolicited messages (`state` pushes, `presets` pushes, `evt`, `log`) have no `id`.

## 2. Commands (PC → controller)

| Command | Fields | Reply |
|---|---|---|
| `hello` | — | `hello` |
| `get_state` | — | `state` (with `id`) |
| `get_presets` | `cam` (optional, default = selected) | `presets` (with `id`) |
| `select` | `cam` | `ack` |
| `move` | `pan`, `tilt`, `zoom` (each −1..1, default 0), `cam` (optional) | `ack` |
| `stop` | — | `ack` |
| `lock` | `on` (true/false) | `ack` |
| `preset_recall` | `cam` (optional), `n` (1..50) | `ack` |
| `preset_store` | `cam` (optional), `n` (1..50), `name` (optional), `thumb` (optional bool) | `ack` |

Camera indices (`cam`) are the controller's slot numbers 0..5, as listed in `hello` / `state`.

### hello
```json
{"cmd":"hello","id":1}
{"t":"hello","id":1,"ok":true,"proto":1,"fw":"PTZ_Controller_S3 2026-11-20",
 "cams":[{"i":0,"name":"Gimbal","type":"gimbal","enabled":false},
         {"i":1,"name":"JVC","type":"jvc","enabled":true}]}
```
`type` is one of `jvc`, `visca`, `gimbal`, `lumix`. Empty slots are not listed.

### select
```json
{"cmd":"select","cam":1,"id":5}
{"t":"ack","id":5,"ok":true}
```
Same as tapping a camera on the iPad or pressing a camera button: manual motion of the previously
selected camera stops; presets already running continue.

### move
```json
{"cmd":"move","pan":0.25,"tilt":0,"zoom":-0.5,"id":7}
{"t":"ack","id":7,"ok":true}
```
- Values are the same normalised stick deflection as the physical joystick (−1..1; pan + = right,
  tilt + = up, zoom + = tele). The camera's speed settings then apply exactly as for the joystick:
  max speed, zoom speed, and slow-down at long zoom. Deadzone, expo curve and the per-camera
  "invert" settings belong to the physical joystick and are **not** applied to PC values.
- If `cam` is given and is not the selected camera, it is selected first (same as the *Seja* page).
- **Send moves continuously, about 20–50 Hz, while moving** (see the watchdog below). To stop, send a move
  with all zeros, or `stop`.
- A zero move is always accepted, even on a program camera or when locked.
- For a **gimbal**, `zoom` drives the lens motor (the motor set for that gimbal, focus or zoom),
  the same as the joystick's twist axis.
- A **Lumix** camera (type `lumix`) has no pan/tilt; moves are accepted but do nothing.

### stop
```json
{"cmd":"stop","id":8}
```
Stops manual motion on all cameras and cancels running gimbal presets. It does **not** set the lock
(unlike the red STOP button in the web UI, which stops and locks).

### lock
```json
{"cmd":"lock","on":true,"id":9}
```
The same lock as the web UI and the physical STOP button. `on:true` also stops everything. While
locked, non-zero moves, `preset_recall` and `preset_store` are refused with `lock`.

### preset_recall / preset_store
```json
{"cmd":"preset_recall","cam":1,"n":3,"id":10}
{"cmd":"preset_store","cam":1,"n":3,"name":"Govornik 3","thumb":true,"id":11}
```
- They use the same function as the web UI's *Kontrola* page (non-strict mode).
- `preset_recall` on a camera in ATEM program is refused with `pgm` when tally protection is on.
- `name` sets the preset name for that camera (max 19 bytes).
- `thumb:true` additionally grabs a new thumbnail (JVC/VISCA, when thumbnails are enabled for the
  camera). Note that JVC already grabs one automatically when storing.
- Gimbal presets need the gimbal connected with angle telemetry. A Lumix camera has no presets.

### get_state / get_presets
```json
{"cmd":"get_state","id":2}
{"cmd":"get_presets","cam":1,"id":3}
```
Replies are the `state` / `presets` messages below, with the request `id`.

## 3. Messages (controller → PC)

### ack
```json
{"t":"ack","id":7,"ok":true}
{"t":"ack","id":7,"ok":false,"err":"pgm"}
{"t":"ack","id":10,"ok":false,"err":"failed","msg":"gimbal ni povezan"}
```

### state
Sent on every change (at most 4 per second) and at least every 2 s, and in reply to `get_state`.
```json
{"t":"state","sel":1,"lock":false,"joystick_override":false,"atem":true,
 "cams":[{"i":1,"name":"JVC","type":"jvc","enabled":true,"connected":true,
          "pgm":false,"pvw":true,"moving":false,"status":"povezana (JVC API)"}]}
```
| Field | Meaning |
|---|---|
| `sel` | Selected camera index (−1 = none). |
| `lock` | STOP lock active. |
| `joystick_override` | The physical joystick is active, so PC moves are being refused. |
| `atem` | Connected to the ATEM switcher. |
| `cams[].connected` | Camera (or gimbal or Lumix behind its bridge) is reachable. |
| `cams[].pgm` / `pvw` | Camera is on program / preview on the ATEM. |
| `cams[].moving` | A preset move is in progress. |
| `cams[].status` | Short human-readable status, the same text as in the web UI (Slovenian). |

Disabled cameras are listed with `"enabled":false`.

### presets
Sent in reply to `get_presets`, and pushed (without `id`) for a camera when its preset names or stored
flags change (checked once per second).
```json
{"t":"presets","cam":1,"list":[{"n":1,"name":"Govornik 1","stored":true},{"n":2,"name":"","stored":false}]}
```
The list always has all 50 entries.

### evt
```json
{"t":"evt","ev":"watchdog_stop","cam":1}
{"t":"evt","ev":"joystick_override","on":true}
```

### log
All diagnostic output from the firmware, one line each:
```json
{"t":"log","msg":"WiFi: povezujem na Tomaz24 ..."}
```

## 4. Error codes

| `err` | Meaning |
|---|---|
| `pgm` | The camera is on ATEM program and tally protection is on, so the move or recall was refused. |
| `lock` | The STOP lock is active. |
| `bad_cam` | No such camera, an empty slot, or a disabled camera. |
| `bad_arg` | Invalid JSON, a missing or out-of-range field, or a line over 512 bytes. |
| `unknown_cmd` | Unknown `cmd`. |
| `joystick_active` | The physical joystick is in use; the move was ignored. |
| `failed` | A preset command was refused for another reason. `msg` has the reason in Slovenian (for example "gimbal ni povezan", "preset ni shranjen"). |

## 5. Safety rules

- **Watchdog:** after a non-zero `move`, if no further `move` arrives within **500 ms**, the controller
  stops that camera and sends `{"t":"evt","ev":"watchdog_stop","cam":N}`. Keep sending at least every
  100–200 ms; 20–50 Hz is recommended.
- **Joystick priority:** while any physical joystick axis is outside its deadzone, and for **300 ms**
  after, non-zero PC moves are ignored and acked with `joystick_active`. Changes are announced with
  `{"t":"evt","ev":"joystick_override","on":true|false}`, and `state.joystick_override` mirrors it.
  The physical joystick is only read for the selected camera.
- **Disconnect:** if the USB host goes away (port closed or cable pulled), any PC-driven motion is stopped.
- **Tally protection** (web UI setting "Ne premikaj kamere v programu"): when it is on, a non-zero move
  or a preset recall on a camera that is on ATEM program is refused with `pgm`. This is the same rule
  that blocks the physical joystick and the iPad.
- **Lock:** while locked, everything except zero moves, `stop`, `lock`, `select` and the `get_*`
  commands is refused with `lock`.

## 6. Versioning

- `hello.proto` is the protocol version (currently **1**). New fields and message types may be added
  without changing it, so clients must ignore unknown fields and unknown `t` / `ev` values.
- An incompatible change (renamed or removed fields, changed meaning) increments `proto`.
- `hello.fw` identifies the firmware build.

## 7. Minimal Python client

```python
# pip install pyserial
import json, time, serial

PORT = "COM5"          # Linux/macOS: /dev/ttyACM0, /dev/cu.usbmodem...

s = serial.Serial()
s.port, s.baudrate, s.timeout = PORT, 115200, 0.02
s.rts = False          # IMPORTANT: RTS asserted at open would reset the ESP32-S3
s.dtr = True
s.open()

buf = b""
def read_msgs():
    """Return all complete JSON messages received so far."""
    global buf
    buf += s.read(4096)
    out = []
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        line = line.strip()
        if not line.startswith(b"{"):
            continue                       # boot text / partial line
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out

_next_id = 0
def send(obj):
    global _next_id
    _next_id += 1
    obj["id"] = _next_id
    s.write((json.dumps(obj) + "\n").encode())
    return _next_id

def request(obj, timeout=1.0):
    rid = send(obj)
    end = time.time() + timeout
    while time.time() < end:
        for m in read_msgs():
            if m.get("id") == rid:
                return m
            if m.get("t") == "log":
                print("log:", m["msg"])
    raise TimeoutError(obj)

print(request({"cmd": "hello"}))
state = request({"cmd": "get_state"})
cam = state["sel"]
print("selected camera:", cam, [(c["i"], c["name"], c["pgm"]) for c in state["cams"]])

# pan slowly right for 1 s at 50 Hz
t_end = time.time() + 1.0
while time.time() < t_end:
    send({"cmd": "move", "cam": cam, "pan": 0.2})
    for m in read_msgs():
        if m.get("t") == "ack" and not m["ok"]:
            print("refused:", m["err"])      # pgm / lock / joystick_active ...
        elif m.get("t") == "evt":
            print("event:", m)
    time.sleep(0.02)

print(request({"cmd": "stop"}))
s.close()
```
