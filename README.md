# Bambu to Flashforge Converter

Turns a Bambu Studio project (`.3mf`) into a Flash Studio project for the **Flashforge Adventurer 5M with the
0.4 mm nozzle**, checks the result against the printer, and hands it to Flash Studio. There you slice and print as
usual.

Unofficial. Not affiliated with Bambu Lab or Flashforge; the names belong to their owners.

```
b2f convert ~/3dprint/in/model.3mf    →    ~/3dprint/out/model-ad5m.3mf    →    Flash Studio
```

## What the conversion does

- **Swaps the printer, process and filament** for Flash Studio's own Adventurer 5M 0.4 presets. Flash Studio's
  command line does not follow a preset's `inherits` chain on its own, so every chain is flattened first, parent
  under child. Nothing is typed in: no temperature, speed or retraction comes from this tool.
- **Collapses the project onto the 5M's one extruder.** A Bambu project may put an object on AMS slot 10 and switch
  colours at a layer. The slicer would write that as tool changes the 5M cannot make. Every object and part moves to
  slot 1, every per-slot list is cut to one slot, and tool and colour changes are taken out and listed. Add a pause
  in Flash Studio if you want the colour change back. Pauses the designer set stay.
- **Uses a filament Flash Studio can select.** The default is `Generic PLA @System` (220 °C, 55 °C on the textured
  plate). `Flashforge Generic PLA` is a base preset the app does not offer, and a project naming it opens as an
  unknown preset, so it is refused. `--filament` takes any other name Flash Studio lists for the 5M 0.4.
- **Drops the values a newer Bambu Studio writes that Flash Studio refuses**, such as `wall_filament = 0` and
  `raft_first_layer_expansion = -1`, from a copy of the project, then runs again once. The preset fills them in.
- **Takes plate names out.** Flash Studio's command line crashes on a project whose plate has a name. The names are
  blanked in the copy the slicer reads and printed, by plate, so you still know which plate the designer meant.
- **Takes a second kind of nozzle out.** From Bambu Studio 2.04 a P1S project names two kinds of nozzle, Standard and
  High Flow, and keeps its filament lists per slot per kind. Flash Studio's command line crashes on those lists for
  the 5M's one nozzle, so when a project names more than one kind, the lists come out of the copy the slicer reads and
  are printed. The slicer fills in its own one-kind values.
- **Takes parts merged into one object apart.** A project exported with two parts welded into a single object —
  Bambu Studio calls it a combined body, 组合体 — is one piece to any slicer: it cannot be moved, oriented or set
  apart. Each piece becomes an object of its own in the copy the slicer reads, exactly where it sat, and the sizes
  are printed. A figure printed in place is never taken apart: its pieces are nested or laid across each other,
  their boxes meet, and the rule is the geometry rather than the count of shells. An object is also left alone, and
  said, when its faces carry paint, when it holds a modifier or a support blocker, or when it is built from several
  volumes of its own. `--keep-merged` turns it off.
- **Keeps the model:** objects, their separate parts, transforms, modifiers and per-object settings ride along. Parts are re-arranged
  onto the 5M's centred bed.
- **Prints the designer's notes.** A project often says "0.2 mm, no supports, figure at 0% infill" in its
  description, and no setting in the file encodes that. Read it before you slice.

## How it proves the result

`convert` slices the converted project once with Flash Studio's command line, in a temporary folder, and holds
the G-code to the Adventurer 5M:

- the printer model, the 0.4 nozzle, Klipper flavour, the −110..110 mm bed and the 220 mm height;
- every XY move inside the bed, with arcs checked at the extremes they sweep through and relative moves resolved;
- no Bambu-only commands, and no tool but `T0`;
- nozzle ≤ 280 °C, bed ≤ 110 °C, ≤ 600 mm/s, ≤ 20 000 mm/s², and the bed temperature equal to the preset's
  value for the plate in use;
- filament actually used, summed over every slot.

Only a project whose every plate passes is written, and it is written **without G-code**: Flash Studio slices it
again when you open it. The temporary folder is then deleted. If the check fails or the slicer crashes, nothing
is written, and the folder is kept with its path printed. Flash Studio's own warnings from that slice are printed
too.

## Requirements

- Linux and **Node.js 24** or newer.
- **Flash Studio for Linux** (the AppImage from flashforge.com), launched once from its menu so it unpacks its
  presets. Tested with Flash Studio 1.7.9, which is Orca-Flashforge 2.3.2 underneath.

The tool looks for the newest `Flash*Studio*.AppImage` under `~/Applications`. Environment variables change the
defaults:

| Variable | Default |
|---|---|
| `FLASH_STUDIO` | the newest `Flash*Studio*.AppImage` under `~/Applications` |
| `FLASH_STUDIO_CONFIG` | `~/.config/Orca-Flashforge` (where Flash Studio keeps its presets) |
| `SSL_CERT_FILE` | `/etc/ssl/certs/ca-certificates.crt` (answers the AppImage's first-launch certificate prompt) |
| `B2F_HOME` | `~/3dprint` (models in `in/`, finished projects in `out/`) |

## Install

```bash
git clone https://github.com/THEBMOREJOKER/bambu-to-flashforge-converter.git
cd bambu-to-flashforge-converter
npm install
npm run build
npm test
node dist/src/cli.js state      # says whether Flash Studio and its presets were found
```

`npm link` puts `b2f` on your PATH. The examples below use `b2f`; `node dist/src/cli.js` works the same.

## Use

```bash
b2f inspect ~/3dprint/in/model.3mf        # what the file is, its size on the bed, the designer's notes,
                                          # and what the conversion will change
b2f convert ~/3dprint/in/model.3mf        # → ~/3dprint/out/model-ad5m.3mf
b2f open ~/3dprint/out/model-ad5m.3mf     # opens it in Flash Studio; slice and print from there
```

Options for `convert`:

| Option | Does |
|---|---|
| `--process 0.12\|0.20\|0.24` | layer height preset (default 0.20 Standard) |
| `--filament NAME` | a filament preset Flash Studio offers for the 5M 0.4 |
| `--set KEY=VALUE` | a decision about the part, such as `brim_type=auto_brim`, `sparse_infill_density=0%` or `wall_loops=3`. Temperatures, speeds, accelerations, flow and fan are refused: those belong to the presets |
| `--scale F` | uniform scale, only when you ask for it. `inspect` reports a part larger than the 220 mm bed, and the check fails a plate that leaves it |
| `--plate N` | one plate (default: all) |
| `--name STEM`, `--out DIR` | output name and folder |
| `--from-mesh` | slice the project's mesh taken out whole, for a project file Flash Studio's command line crashes on. One STL per piece: parts that sit clear of each other stay separate objects, nested parts stay in one STL. Per-object settings, modifiers, painted supports and layer changes do not travel, and the tool names what was lost |
| `--keep-merged` | leave an object that is really several parts welded into one. Off by default: the pieces are put back on their own feet |
| `--keep` | keep the temporary folder |

Other commands:

```bash
b2f check FILE.gcode                      # hold any G-code to the 5M (exit 2 = do not print it)
b2f split PROJECT.3mf                     # disconnected shells per object
b2f split PROJECT.3mf --split 3           # one STL per shell of object 3; --split none writes every object whole
b2f state                                 # Flash Studio, presets, work folder
```

Flash Studio 1.7.9 keeps its latest slice under `/tmp/orca-flashforge/model/<day>/<session>/Metadata/` (seen on
Ubuntu, not documented by Flashforge). `b2f check` reads any G-code, that one included.

### The app

```bash
node dist/src/cli.js gui                  # http://127.0.0.1:8770
bin/b2f-app                               # starts it if needed and opens the browser
```

In the app: pick or drop a model and read its notes. Choose layer height, filament, brim and infill, then convert.
A progress bar follows Flash Studio's own report, step by step (the slicer writes each step to a named pipe when
started with `--pipe`); the command line prints the same steps as lines.
Read the check and the drawing of the first layer, and press **open in Flash Studio**. If Flash Studio's command
line crashes on the project, the page offers **retry from the mesh alone**.

The app listens on loopback only, refuses any request whose Host header is not localhost, and reads and writes
only inside the work folder. It never talks to a printer.

A desktop entry, if you want an icon (adjust the path):

```ini
[Desktop Entry]
Type=Application
Name=Bambu to Flashforge
Exec=/path/to/bambu-to-flashforge-converter/bin/b2f-app
Icon=/path/to/bambu-to-flashforge-converter/icon/bambu-to-flashforge.svg
Terminal=false
Categories=Graphics;3DGraphics;
```

## Limits

- One printer: the Adventurer 5M with the 0.4 mm nozzle.
- Colour painted onto the mesh (MMU painting) is not rewritten. The check fails a file that still changes tools.
- It never sends a file to a printer or starts a print.
- Flash Studio's command line cannot draw thumbnails without a display, so the project carries the ones it came
  with.

## Tests

`npm test` builds and runs `node --test`. No printer is involved. Every test names a defect it would catch: an
arc that bulges off the bed while both its ends sit inside, a relative move read as an absolute one, a tool change
the 5M cannot make, a plate printed from a later slot read as empty, eleven slots left in a one-extruder project, a
retry reading the run before it, a project handed over with G-code inside. The tests that read Flash Studio's
installed presets skip on a machine without them.

## License

MIT
