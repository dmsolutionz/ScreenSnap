# Media pipeline

Dev tooling that produces the store screenshots, the website demo and the launch film **from the real
extension** — nothing here ships in the extension zip (`scripts/package.mjs` only packs `manifest.json`, `icons/`,
`src/`, `LICENSE`). Zero npm dependencies: Node 22+, Google Chrome, `ffmpeg`, macOS `say` (the demo
recording's narration) and the FilmCraft CLI for the film's voiceover (below).

The audio is **original and synthesized in code** (no samples, no third-party music), so the film is free of
licensing and Content ID issues.

```
demo-source/render.mjs     a fake "Pulse" dashboard screen recording (the footage the editor edits) → demo-source.mp4 + events.json
capture-editor.mjs         films the REAL video editor editing that clip: scrub, trim, cut, zoom, crop, annotate, export → frames + stills
capture-popup.mjs          films the REAL popup tour
capture-shots.mjs          films the REAL screenshot editor annotating a page
synth-audio.mjs            music bed + sound effects, 120 BPM, sample-accurate → music.wav, stems, sfx/*.wav, cues.json
render-film.mjs            renders film/ (one deterministic HTML page) to 3840x2160 PNG frames; --captions writes captions.srt, sfx-cues.json, voice.json
narrate.mjs                the voiceover: each caption spoken by FilmCraft's natural Kokoro-82M voice, fitted to its slot → vo-cues.json
mix-audio.mjs              music + sound effects + voiceover at the film's cue times, music ducked under both, normalised to -14 LUFS
encode-film.mjs            4K H.264 master for YouTube + the website demo loop, GIF fallback and poster
store-shots.mjs            the five 1280x800 Chrome Web Store screenshots from the stills
lib/                       CDP driver for Chrome (GPU flags so WebCodecs H.264 works), the virtual-time "director", editor session
film/                      film.html + film.js: every scene as a pure function of time, `window.__render(t)`
```

## How it fits together

The capture scripts drive the unpacked extension in headless Chrome over the DevTools Protocol with real input
events. Time is **virtual**: the `director` advances a clock by whole frames and writes one PNG per frame, so how
long Chrome takes to screenshot never shows up in the footage. Headless captures carry no OS cursor, so a cursor and
click ripple are drawn into the page.

Each editor step announces itself with `director.say()`, and with `--speech` (narrate.mjs's output) the capture
waits for a line to be spoken before starting the next step, so the footage is paced by its narration.
`film/film.js` places everything on a beat grid and maps the footage in through each capture's `manifest.json`
(timed marks and clicks), so captions, key-caps and click sounds land on the exact frame where the thing happens.

## Re-making everything

Pick any working directory `W` and run from the repo root:

```sh
export W=/path/to/work
node scripts/media/demo-source/render.mjs --out $W/source          # ~75 s
node scripts/media/capture-editor.mjs --source $W/source/demo-source.mp4 --events $W/source/events.json --out $W/editor/main --dsf 2
node scripts/media/capture-popup.mjs  --out $W/popup
node scripts/media/capture-shots.mjs  --out $W/shots
node scripts/media/synth-audio.mjs    --structure scripts/media/film/music-structure.json --out $W/audio   # ~35 s
node scripts/media/render-film.mjs    --work $W --out $W/film/final --dsf 2 --workers 6 --captions   # ~4 min at 4K
node scripts/media/narrate.mjs        --voice-script $W/film/final/voice.json --filmcraft $FILMCRAFT_CLI --out $W/vo
node scripts/media/mix-audio.mjs      --audio $W/audio --cues $W/film/final/sfx-cues.json --voice $W/vo/vo-cues.json --out $W/film/mix.wav
node scripts/media/encode-film.mjs    --frames $W/film/final/frames --audio $W/film/mix.wav --captions $W/film/final/captions.srt --out $W/film/out
node scripts/media/store-shots.mjs    --editor $W/editor/main/stills --popup $W/popup/stills/record-full.png --shots $W/shots/stills/annotated.png --out screenshots/store
```

The editor capture uses the voiceover's timings: run narrate.mjs once, then capture-editor with
`--speech $W/vo/vo-cues.json`, then re-render the captions and narration so both match the new footage.
`render-film.mjs --at 12.5,30 --dsf 1 --out DIR` renders single stills for design review.

**FilmCraft CLI with natural voices.** The FilmCraft app may be built without them; build the CLI from
https://github.com/storytold/filmcraft with the engine's feature and fetch the voice package once
(336 MB, every file pinned to a revision and SHA-256):

```sh
cargo build --release -p filmcraft-cli --features filmcraft-engine/neural-voices
export FILMCRAFT_CLI=$PWD/target/release/filmcraft-cli
$FILMCRAFT_CLI exec tts.downloadVoices wait=true
```
