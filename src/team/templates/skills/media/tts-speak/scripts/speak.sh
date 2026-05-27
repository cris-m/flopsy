#!/usr/bin/env bash
# Pocket-TTS wrapper — single-line entry the agent calls from the sandbox.
#
# Absorbs the env setup so the agent doesn't have to assemble
# UV_PROJECT_ENVIRONMENT, UV_CACHE_DIR, --project, the absolute script
# path, and the JSON / --quiet flags. SKILL.md references this script,
# not main.py directly.
#
# Usage:
#   bash /skills/tts-speak/scripts/speak.sh "Hello world"
#   bash /skills/tts-speak/scripts/speak.sh --text-file /workspace/work/scratch/in.txt
#   bash /skills/tts-speak/scripts/speak.sh --voice anna --lang french "Bonjour"
#   bash /skills/tts-speak/scripts/speak.sh --out /workspace/work/audio/custom.wav "..."
#
# Output: single-line JSON on stdout —
#   {"audio_path": "...", "duration_seconds": 1.4, "voice": "alba", ...}
# Diagnostics: stderr.
#
# Exit codes: 0 ok · 2 usage error · 3 main.py failed · 4 env setup failed

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WORKDIR="${WORKDIR:-/workspace/work}"
readonly AUDIO_DIR="${WORKDIR}/audio"
readonly SCRATCH_DIR="${WORKDIR}/scratch"
readonly STAMP="$(date +%Y%m%d-%H%M%S)"
DEFAULT_OUT="${AUDIO_DIR}/speak-${STAMP}.wav"

TEXT=""
TEXT_FILE=""
OUT="${DEFAULT_OUT}"
VOICE=""
LANG=""
TEMPERATURE=""
QUANTIZE=""

usage() {
    cat >&2 <<'USAGE'
speak.sh — Pocket-TTS wrapper for the FlopsyBot agent.

Usage:
  speak.sh "text to speak"                      # positional text
  speak.sh --text-file /path/to/text.txt        # text from a file
  echo "..." | speak.sh --stdin                 # text from stdin

Optional:
  --voice <name>          alba|anna|charles|jane|... (default: language-default)
  --lang <language>       english|french|spanish|german|italian|portuguese
  --temperature <0..1.5>  0.4 calm, 0.6 default, 0.9 lively
  --quantize              halve memory at small quality cost
  --out <path>            override output (default: /workspace/work/audio/speak-<stamp>.wav)
  -h, --help              this message

Output: single-line JSON on stdout. Audio file at .audio_path.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --text-file) TEXT_FILE="$2"; shift 2 ;;
        --stdin) TEXT_FILE="-"; shift ;;
        --voice) VOICE="$2"; shift 2 ;;
        --lang) LANG="$2"; shift 2 ;;
        --temperature|-t) TEMPERATURE="$2"; shift 2 ;;
        --quantize) QUANTIZE="--quantize"; shift ;;
        --out|-o) OUT="$2"; shift 2 ;;
        --) shift; TEXT="${TEXT:-$*}"; break ;;
        -*)
            echo "speak.sh: unknown flag: $1" >&2; usage; exit 2 ;;
        *)
            if [[ -z "${TEXT}" ]]; then TEXT="$1"; else TEXT="${TEXT} $1"; fi
            shift ;;
    esac
done

if [[ -z "${TEXT}" && -z "${TEXT_FILE}" ]]; then
    echo "speak.sh: no text — pass a positional arg, --text-file, or --stdin" >&2
    usage; exit 2
fi

mkdir -p "${AUDIO_DIR}" "${SCRATCH_DIR}"
if [[ -z "${TEXT_FILE}" ]]; then
    TEXT_FILE="${SCRATCH_DIR}/speak-input-${STAMP}.txt"
    printf '%s' "${TEXT}" > "${TEXT_FILE}"
fi

ARGS=(
    "run" "--project" "${SCRIPT_DIR}"
    "python" "${SCRIPT_DIR}/main.py"
    "speak" "--text-file" "${TEXT_FILE}" "-o" "${OUT}"
    "--json" "--quiet"
)
[[ -n "${VOICE}" ]] && ARGS+=("--voice" "${VOICE}")
[[ -n "${LANG}" ]] && ARGS+=("--lang" "${LANG}")
[[ -n "${TEMPERATURE}" ]] && ARGS+=("--temperature" "${TEMPERATURE}")
[[ -n "${QUANTIZE}" ]] && ARGS+=("${QUANTIZE}")

# Keep venv + cache inside the writable workspace — /skills is read-only.
export UV_PROJECT_ENVIRONMENT="${WORKDIR}/.venv-tts"
export UV_CACHE_DIR="${WORKDIR}/.uv-cache"

if ! command -v uv >/dev/null 2>&1; then
    echo "speak.sh: uv not on PATH — sandbox missing the Python toolchain" >&2
    exit 4
fi

if ! uv "${ARGS[@]}"; then
    echo "speak.sh: main.py exited non-zero" >&2
    exit 3
fi
