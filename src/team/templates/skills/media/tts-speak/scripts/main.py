"""Pocket-TTS CLI wrapper — agent-friendly text-to-speech.

Same `speak` interface the SKILL.md teaches, now backed by Kyutai's
Pocket-TTS (100M params, CPU-only, ~6× realtime) instead of Orpheus
(3B params, OOM-killed by the 6 GB sandbox memory cap).

Subcommands:
    voices          List available built-in voices.
    langs           List supported languages.
    speak <text>    Synthesize text to a WAV file. Supports stdin + JSON output.

Examples (agent):
    # Pipe text to avoid shell-quote issues
    echo "Hello, world." | uv run python main.py speak - -o out.wav --json
    # → {"audio_path": "...", "duration_seconds": 1.4, "voice": "alba", "rtf": 0.18, ...}
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import wave
from pathlib import Path


# Pocket-TTS built-in voice catalog (subset of the most-used; full list at
# https://huggingface.co/kyutai/tts-voices). The defaults below are chosen
# per language by Pocket-TTS itself; we surface a manageable subset to the
# agent so it doesn't have to memorize 80+ voice names.
VOICES = [
    "alba", "anna", "azelma", "charles", "cosette", "eponine", "eve",
    "fantine", "george", "jane", "jean", "javert", "marius", "mary",
    "michael", "paul", "peter_yearsley",
    # Non-English defaults
    "giovanni",  # it
    "lola",      # es
    "juergen",   # de
    "rafael",    # pt
    "estelle",   # fr
]

LANGUAGES = [
    "english", "english_2026-01", "english_2026-04",
    "french", "french_24l",
    "spanish", "spanish_24l",
    "german", "german_24l",
    "italian", "italian_24l",
    "portuguese", "portuguese_24l",
]

# Default voice per language (matches Pocket-TTS upstream).
DEFAULT_VOICE_PER_LANG = {
    "english": "alba",
    "english_2026-01": "alba",
    "english_2026-04": "alba",
    "french": "estelle",
    "french_24l": "estelle",
    "spanish": "lola",
    "spanish_24l": "lola",
    "german": "juergen",
    "german_24l": "juergen",
    "italian": "giovanni",
    "italian_24l": "giovanni",
    "portuguese": "rafael",
    "portuguese_24l": "rafael",
}


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def cmd_voices(_args: argparse.Namespace) -> int:
    _log("Pocket-TTS voices (subset; full list at huggingface.co/kyutai/tts-voices):")
    for v in VOICES:
        print(v)
    return 0


def cmd_langs(_args: argparse.Namespace) -> int:
    _log("Pocket-TTS supported languages:")
    for code in LANGUAGES:
        print(code)
    return 0


def _resolve_text(args: argparse.Namespace) -> str:
    if args.text_file:
        return sys.stdin.read() if args.text_file == "-" else Path(args.text_file).read_text()
    if args.text == "-":
        return sys.stdin.read()
    if args.text is None:
        print(
            "error: provide TEXT positionally, or use --text-file (use '-' for stdin).",
            file=sys.stderr,
        )
        sys.exit(2)
    return args.text


def cmd_speak(args: argparse.Namespace) -> int:
    # Lazy imports — keeps `voices` / `langs` instant without loading torch.
    from pocket_tts.main import TTSModel, stream_audio_chunks

    if args.text_file and args.text and args.text != "-" and args.output is None:
        args.output, args.text = args.text, None

    text = _resolve_text(args).strip()
    if not text:
        print("error: empty text.", file=sys.stderr)
        return 2

    out_path = Path(args.out_flag or args.output or "output.wav").resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    _log(f"Loading Pocket-TTS (lang={args.lang}, device={args.device}, quantize={args.quantize})…")
    load_start = time.monotonic()
    tts_model = TTSModel.load_model(
        language=args.lang,
        temp=args.temperature,
        quantize=args.quantize,
    )
    tts_model.to(args.device)
    load_time = time.monotonic() - load_start

    voice = args.voice or DEFAULT_VOICE_PER_LANG.get(args.lang, "alba")

    model_state = tts_model.get_state_for_audio_prompt(voice)

    _log(f"Generating with voice={voice}…")
    gen_start = time.monotonic()
    audio_chunks = list(
        tts_model.generate_audio_stream(
            model_state=model_state,
            text_to_generate=text,
            max_tokens=args.max_tokens,
        ),
    )
    sample_rate = tts_model.config.mimi.sample_rate
    stream_audio_chunks(str(out_path), iter(audio_chunks), sample_rate)
    gen_time = time.monotonic() - gen_start

    # Probe the WAV we just wrote for accurate duration (in case
    # stream_audio_chunks wrote PCM frames the chunks list doesn't reflect).
    with wave.open(str(out_path), "rb") as wf:
        n_frames = wf.getnframes()
        duration = n_frames / wf.getframerate() if wf.getframerate() else 0.0

    rtf = gen_time / duration if duration else float("inf")

    _log("")
    _log(f"voice         : {voice}")
    _log(f"language      : {args.lang}")
    _log(f"audio length  : {duration:.2f}s @ {sample_rate} Hz")
    _log(f"load time     : {load_time:.2f}s")
    _log(f"generation    : {gen_time:.2f}s")
    _log(f"RTF           : {rtf:.2f}x  ({'realtime-capable' if rtf < 1 else 'slower than realtime'})")

    if args.json:
        print(json.dumps({
            "audio_path": str(out_path),
            "duration_seconds": round(duration, 3),
            "sample_rate": sample_rate,
            "voice": voice,
            "lang": args.lang,
            "load_seconds": round(load_time, 3),
            "generation_seconds": round(gen_time, 3),
            "total_seconds": round(load_time + gen_time, 3),
            "rtf": round(rtf, 3),
            "char_count": len(text),
            "engine": "pocket-tts",
        }))
    else:
        print(out_path)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pocket-tts-cli",
        description="Pocket-TTS CLI — Kyutai 100M-param speech synthesis on CPU.",
    )
    sub = p.add_subparsers(dest="cmd", required=True, metavar="{voices,langs,speak}")

    sub.add_parser("voices", help="List available voices.").set_defaults(func=cmd_voices)
    sub.add_parser("langs", help="List supported languages.").set_defaults(func=cmd_langs)

    sp = sub.add_parser("speak", help="Synthesize text to a WAV file.")
    sp.add_argument("text", nargs="?",
                    help="Text to speak. Use '-' to read from stdin.")
    sp.add_argument("output", nargs="?", default=None,
                    help="Output WAV path (default: output.wav). Prefer -o when also using --text-file.")
    sp.add_argument("-o", "--out", dest="out_flag", default=None,
                    help="Output WAV path (flag form, unambiguous when using --text-file).")
    sp.add_argument("--text-file", dest="text_file",
                    help="Read text from a file path (use '-' for stdin). Overrides positional text.")
    sp.add_argument("--json", action="store_true",
                    help="Emit a JSON object on stdout (path + metadata) instead of just the path.")
    sp.add_argument("--voice", "-v", default=None,
                    help=f"Voice id (default: language-specific). Available: {', '.join(VOICES)}")
    sp.add_argument("--lang", "-l", default="english",
                    choices=LANGUAGES,
                    help="Language model to load (default: english).")
    sp.add_argument("--device", default="cpu",
                    help="Torch device (default: cpu). Pocket-TTS is CPU-tuned.")
    sp.add_argument("--temperature", "-t", type=float, default=0.6,
                    help="Sampling temperature (default: 0.6).")
    sp.add_argument("--max-tokens", type=int, default=2500,
                    help="Maximum tokens per chunk (default: 2500). Pocket-TTS handles infinitely long text via chunking.")
    sp.add_argument("--quantize", action="store_true",
                    help="Apply int8 quantization to halve memory (~150 MB → ~75 MB) at small quality cost.")
    sp.add_argument("--quiet", "-q", action="store_true",
                    help="Suppress progress logs on stderr (kept for SKILL.md compatibility).")
    sp.set_defaults(func=cmd_speak)
    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
