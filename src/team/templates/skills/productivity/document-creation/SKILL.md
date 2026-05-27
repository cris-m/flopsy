---
name: document-creation
category: productivity
description: Create polished Office/PDF documents — Word (.docx), Excel (.xlsx), PowerPoint (.pptx), and PDF — from a structured JSON spec or Markdown. Use when the user asks to "make/generate/build/export a document, report, CV, resume, spreadsheet, slide deck, presentation, or PDF", or to turn content into a downloadable file.
when-to-use: 'Trigger phrases: "make a Word doc / CV / resume / report", "build a spreadsheet / Excel file", "create a slide deck / presentation / PowerPoint", "export this as a PDF / docx / xlsx / pptx", "turn this into a document I can download".'
argument-hint: "What document to create + its content. e.g. 'a one-page CV for X', 'a Q2 sales spreadsheet', 'a 5-slide pitch deck'."
allowed-tools: execute_code
metadata:
  flopsy:
    agent-affinity: [gandalf]
---

Generate real Office and PDF files from structured content. Each format has its own CLI under `scripts/`, run with `uv` inside `execute_code` — `uv` installs the Python dependency (python-docx / openpyxl / python-pptx / reportlab) into a `/workspace` cache on first use, so nothing needs pre-installing.

## Scripts

| Command | Output | Engine |
|---|---|---|
| `create_docx.py` | `.docx` (Word) | python-docx (rich) · or pandoc from Markdown |
| `create_xlsx.py` | `.xlsx` (Excel) | openpyxl · or from a CSV |
| `create_pptx.py` | `.pptx` (PowerPoint) | python-pptx |
| `create_pdf.py`  | `.pdf` | reportlab (pure-Python) · or from Markdown |

All four take a JSON **spec** (`--spec FILE`, `--spec-json STR`, or `--stdin`), write to `--output`, and print one line of JSON: `{"output_path": "...", "format": "docx", "bytes": 12345, ...}`. Parse that and report `output_path` to the user.

## How to run (sandbox)

`/skills/` is **read-only**; all writes (the spec, the output, the uv cache) MUST land under `/workspace/`. Set `UV_CACHE_DIR` once so uv can cache its envs there:

```bash
export UV_CACHE_DIR=/workspace/work/.uv-cache
SCRIPTS=/skills/productivity/document-creation/scripts

# 1. Write the spec from inside the sandbox (heredoc — do NOT use the Write tool,
#    its /workspace can resolve to a different host dir than execute_code's).
mkdir -p /workspace/work/scratch /workspace/work/exports
cat > /workspace/work/scratch/cv.json <<'JSON'
{ "title": "Jane Doe", "subtitle": "Agronomist", "sections": [
  { "heading": "Experience", "bullets": ["Lead agronomist, 2020–now", "Field trials across 3 regions"] }
] }
JSON

# 2. Render.
uv run "$SCRIPTS/create_docx.py" --spec /workspace/work/scratch/cv.json --output /workspace/work/exports/cv.docx
```

For short specs you can skip the file: `echo '{...}' | uv run "$SCRIPTS/create_xlsx.py" --stdin -o /workspace/work/exports/x.xlsx`.

Always read a script's full options with `uv run "$SCRIPTS/create_docx.py" --help` — the help text carries the complete spec schema for that format.

## Spec schemas (quick reference)

**docx / pdf** share one shape:
```json
{
  "title": "Report", "subtitle": "Q2 2026", "author": "Flopsy", "accent": "1F4E35",
  "sections": [
    { "heading": "Summary", "level": 1,
      "paragraphs": ["Body. **bold** and *italic* work."],
      "bullets": ["point a", "point b"],
      "numbered": ["step 1", "step 2"],
      "table": { "headers": ["Name", "Value"], "rows": [["x", "1"], ["y", "2"]] } }
  ]
}
```

**xlsx**:
```json
{ "accent": "1F4E35", "sheets": [
  { "name": "Sales", "headers": ["Region", "Q1", "Q2"], "rows": [["West", 10, 12]],
    "freeze_header": true, "column_widths": [18, 10, 10] }
] }
```

**pptx** — two slide styles, mixable in one deck:
```json
{ "layout": "WIDE", "title": "Launch Plan", "subtitle": "2026", "slides": [

  { "title": "Goals", "bullets": ["Ship v1", {"text": "sub-point", "level": 1}], "notes": "speaker notes" },

  { "background": "1F4E35", "elements": [
    { "type": "rect",   "x": 0, "y": 0, "w": 13.33, "h": 1.6, "fill": "2E7D52" },
    { "type": "text",   "text": "NICOLE", "x": 0.6, "y": 0.4, "w": 9, "h": 1, "size": 30, "bold": true, "color": "FFFFFF", "align": "left", "valign": "middle" },
    { "type": "bullets","items": ["Coffee agronomy", "Climate-resilient farming"], "x": 0.6, "y": 2.2, "w": 9, "h": 3, "size": 16, "color": "FFFFFF" },
    { "type": "image",  "path": "/workspace/work/scratch/photo.png", "x": 10.5, "y": 0.5, "w": 2.2 }
  ] }
] }
```
- A slide with `title`/`bullets`/`body` is **structured** (PowerPoint lays it out).
- A slide with `elements` is **custom** — absolute positioning in INCHES (`x`/`y`/`w`/`h`), element `type` ∈ `text`|`bullets`|`rect`|`image`, with `size`/`bold`/`italic`/`color`/`align`/`valign`/`fill`/`font`. This is the python-pptx equivalent of a pptxgenjs design-heavy deck (e.g. a visual CV).
- `layout`: `WIDE` (16:9, default) or `STANDARD` (4:3).

## Convenience inputs

| Want | Use |
|---|---|
| You already have Markdown → Word | `create_docx.py --from-markdown /workspace/work/scratch/notes.md -o out.docx` (uses pandoc) |
| You already have Markdown → PDF | `create_pdf.py --from-markdown /workspace/work/scratch/notes.md -o out.pdf` |
| You have CSV → Excel | `create_xlsx.py --from-csv /workspace/work/scratch/data.csv -o out.xlsx` (`--no-header` if row 1 is data) |

Prefer the JSON spec when you want headings, tables, styling, or a title block; prefer `--from-markdown` when the user already handed you Markdown prose.

## Reporting to the user

Parse the JSON stdout, then deliver the file:
```
send_message({ media: [{ type: "document", url: <output_path> }] })
```
State what you made and where (the absolute `output_path`). Don't paste the file's bytes back.

## Gotchas

- **Writes go under `/workspace/`** — outputs in `/workspace/work/exports/`, specs in `/workspace/work/scratch/`, uv cache via `UV_CACHE_DIR=/workspace/work/.uv-cache`. Never write under `/skills/` (read-only).
- **Write the spec with a heredoc inside `execute_code`**, not the Write tool (sandbox path mismatch — same caveat as the tts-speak skill).
- **First run per format downloads its library** (~seconds) into the uv cache; reused after. A gateway/sandbox restart clears the cache → first call is slower again.
- **PDF is pure-Python (reportlab)** — no LaTeX needed. `create_docx --from-markdown` needs `pandoc` (present on the host); if pandoc is ever missing it exits non-zero with a clear message — fall back to building a JSON spec instead.
- **Accent color** is a 6-digit hex without `#` (e.g. `1F4E35`). It tints headings and table-header fills.
- **Excel cells auto-coerce** numeric strings to numbers; pass real numbers in `rows` when you want math/formatting to work.
