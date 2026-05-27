---
name: tts-speak
category: media
description: Synthesize spoken audio from text using Kyutai's Pocket-TTS (100M-param, CPU-only, ~6× realtime). Use when the user asks to "say", "speak", "narrate", "read aloud", or generate a voice/audio/wav from text — even when they don't explicitly mention "TTS" or name the format.
when-to-use: 'Trigger phrases: "say X", "speak this", "read aloud", "generate audio", "TTS this", "make a voice for", "narrate", "give it a voice".'
argument-hint: "The text you want spoken. Optional: voice (alba/anna/charles/jane/...) or language (english/french/spanish/german/italian/portuguese)."
allowed-tools: execute_code write_file
metadata:
  flopsy:
    agent-affinity: [sam]
---

Generate speech audio via Kyutai's Pocket-TTS — a 100M-param CPU-tuned model that loads in ~3s and generates ~6× realtime on Apple Silicon. Output is a WAV under `/workspace/work/audio/`.

## Available scripts

- **`/skills/tts-speak/scripts/speak.sh`** — the entry point. Wraps the uv + env setup so you call it as one bash command. Accepts text positionally, via `--text-file`, or `--stdin`. Returns single-line JSON on stdout.
- **`/skills/tts-speak/scripts/main.py`** — the underlying CLI (use only for flags the wrapper doesn't pass through; see `reference/flags.md`).

## Default workflow — one bash call

Run this inside `execute_code` (bash):

```bash
bash /skills/tts-speak/scripts/speak.sh "Hello, world."
```

That's it. The wrapper materializes the text to a scratch file, sets `UV_PROJECT_ENVIRONMENT` + `UV_CACHE_DIR` under `/workspace/work/` (the `/workspace/` root + `/skills/` are read-only), picks `/workspace/work/audio/speak-<timestamp>.wav`, invokes `main.py speak --json --quiet`, and prints one line of JSON:

```json
{"audio_path":"/workspace/work/audio/speak-20260525-201634.wav","duration_seconds":1.4,"voice":"alba","lang":"english","rtf":0.21,"char_count":13,"engine":"pocket-tts"}
```

## Common variations

| User request | Add to the command |
|---|---|
| Different voice | `--voice anna` (see `reference/flags.md`) |
| Non-English | `--lang french` (picks the language-default voice unless `--voice` set) |
| Calmer / livelier | `--temperature 0.4` / `--temperature 0.9` |
| Specific output filename | `--out /workspace/work/audio/my-name.wav` |
| Text from a file | `--text-file /workspace/work/scratch/long-script.txt` |
| Pipe from another step | `echo "..." \| bash /skills/tts-speak/scripts/speak.sh --stdin` |

For flags not in the table (`--max-tokens`, `--device`, `--quantize`), read `reference/flags.md`.

## Deliver to the user (REQUIRED — generating the file is only half the job)

The WAV lands in the workspace audio folder (`/workspace/work/audio/` in the sandbox = the workspace `work/audio/` dir on disk). Parse the JSON stdout for the absolute `audio_path`, then **send the file**:

```
send_message({ media: [{ type: 'audio', url: <audio_path from the JSON> }] })
```

- **Send the actual file — never just report the path.** The user is on their phone; a text path like `/workspace/work/audio/speak-….wav` is useless to them. "I created the audio at X" is NOT delivery.
- Use the exact `audio_path` the JSON returned (don't construct your own path). Optionally add `duration_seconds` in the message text ("here's the 1.4s clip").
- **If you are a worker without `send_message`** (e.g. agent-affinity ran this on sam): return the absolute `audio_path` to the main agent so IT sends the file.

**NEVER substitute another engine.** Do NOT use macOS `say`, `espeak`, `afplay`, an online TTS, or an ad-hoc `execute_code` script. This skill (Pocket-TTS via `speak.sh`) is the ONLY sanctioned path. If `speak.sh` fails, report the real error and stop — do not improvise a fallback voice.

## Gotchas

- **`/skills/` and the `/workspace/` root are read-only** inside the sandbox; ALL writes (audio, scratch, venv, cache) MUST land under the writable workdir **`/workspace/work/`**. The wrapper handles this — if you call main.py directly, replicate `UV_PROJECT_ENVIRONMENT=/workspace/work/.venv-tts` + `UV_CACHE_DIR=/workspace/work/.uv-cache`.
- **First English call downloads ~150 MB** to `/workspace/work/.cache/huggingface/`; reused after. Non-English downloads its pack separately.
- **Container teardown loses the cache** — gateway restart/OOM means the next call re-downloads (first call 10-15s slower).
- **Long text auto-chunks internally** — don't pre-split.
- **Avoid the Write tool for the input file** — inside the sandbox the Write tool's `/workspace` may resolve to a different host dir than `execute_code`'s. The wrapper writes from inside the sandbox; if you call main.py directly, write the input via `execute_code`.

## Notes

- **CPU ~6× realtime on Apple Silicon M4** — 30s of audio in ~5s. x86_64 server: ~2× realtime.
- **Memory**: ~300-400 MB at runtime; fits the 6 GB sandbox cap.
- **Streaming**: for low-latency use, call `pocket_tts.main.TTSModel.generate_audio_stream()` directly — the CLI writes the full WAV before returning.
