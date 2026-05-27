# tts-speak — full flag reference

Loaded ONLY when the user requests a flag not covered by the SKILL.md core path
(a specific voice / language / temperature / quantization). Don't load preemptively.

`scripts/speak.sh` accepts a subset of `main.py speak`. For anything not below,
fall back to invoking `main.py` directly (see "Direct main.py" at the bottom).

## Voice (`--voice`)

Default is language-specific (`alba` for English). Common voices:

- English: `alba` (default), `anna`, `azelma`, `charles`, `cosette`, `eponine`, `eve`, `fantine`, `george`, `jane`, `jean`, `javert`, `marius`, `mary`, `michael`, `paul`, `peter_yearsley`
- Italian: `giovanni` · Spanish: `lola` · German: `juergen` · Portuguese: `rafael` · French: `estelle`

Use only when the user names a voice; otherwise let the language default apply.
Full list: https://huggingface.co/kyutai/tts-voices

## Language (`--lang`)

`english` (default) | `french` | `spanish` | `german` | `italian` | `portuguese`

Each language is a separate weights pack. First use of a non-English language
downloads ~150-300 MB to `/workspace/work/.cache/huggingface/`; subsequent runs reuse it.
`*_24l` variants are larger / higher-quality but slower — only for "highest quality".

## Temperature (`--temperature`)

Range `0.0`–`1.5`, default `0.6`.

| Temperature | Feel |
|---|---|
| 0.3–0.5 | calm, deterministic, narrator |
| 0.6 | default |
| 0.8–1.0 | lively, energetic |
| >1.0 | erratic, rarely useful |

## Quantization (`--quantize`)

int8 to halve memory (~150 MB → ~75 MB) at small quality cost. Pass only when the
sandbox is memory-pressured (rare — Pocket-TTS already fits 6 GB).

## Output path (`--out` / `-o`)

Wrapper default: `/workspace/work/audio/speak-<timestamp>.wav`. Override only for a
specific filename/dir. Must be under `/workspace/` (the only writable mount).

## Direct main.py (advanced)

For flags the wrapper doesn't pass through (`--max-tokens`, `--device cuda|mps`),
invoke main.py inside an `execute_code` block:

```python
import subprocess, os
env = {**os.environ,
       "UV_PROJECT_ENVIRONMENT": "/workspace/work/.venv-tts",
       "UV_CACHE_DIR": "/workspace/work/.uv-cache"}
r = subprocess.run([
    "uv", "run", "--project", "/skills/tts-speak/scripts",
    "python", "/skills/tts-speak/scripts/main.py",
    "speak", "--text-file", "/workspace/work/scratch/in.txt",
    "-o", "/workspace/work/audio/out.wav",
    "--max-tokens", "5000", "--json", "--quiet",
], capture_output=True, text=True, env=env, timeout=180)
print(r.stdout)
```

## Discovery commands

```bash
uv run --project /skills/tts-speak/scripts python /skills/tts-speak/scripts/main.py voices
uv run --project /skills/tts-speak/scripts python /skills/tts-speak/scripts/main.py langs
uv run --project /skills/tts-speak/scripts python /skills/tts-speak/scripts/main.py speak --help
```
