#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["reportlab>=4.2.5"]
# ///
"""create_pdf — build a PDF from a JSON spec or a Markdown file.

Pure-Python (reportlab) — no LaTeX, pandoc, or system libraries needed, so it
runs reliably in the sandbox.

Spec schema (JSON) — same shape as create_docx:
{
  "title":    "Report",                  # optional title block
  "subtitle": "2026",                    # optional
  "author":   "Flopsy",                  # optional
  "accent":   "1F4E35",                  # optional hex for headings
  "sections": [
    {
      "heading":   "Summary", "level": 1,
      "paragraphs": ["..."],
      "bullets":    ["..."],
      "numbered":   ["..."],
      "table": { "headers": ["A","B"], "rows": [["1","2"]] }
    }
  ]
}

Markdown mode (--from-markdown) understands: # / ## / ### headings, - or *
bullets, 1. numbered items, ``` fenced code, and blank-line-separated paragraphs.

Examples:
  uv run create_pdf.py --spec /workspace/work/scratch/report.json --output /workspace/work/exports/report.pdf
  uv run create_pdf.py --from-markdown /workspace/work/scratch/notes.md -o /workspace/work/exports/notes.pdf
  echo '{"title":"Hi","sections":[{"paragraphs":["Body."]}]}' | uv run create_pdf.py --stdin -o /workspace/work/exports/hi.pdf

Output: single-line JSON -> {"output_path": "...", "format": "pdf", "bytes": N, "sections": 2}
Exit codes: 0 ok | 2 usage/spec error | 3 render error
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path


def _die(msg: str, code: int = 2):
    print(f"create_pdf: {msg}", file=sys.stderr)
    raise SystemExit(code)


def _load_spec(args: argparse.Namespace) -> dict:
    if args.stdin:
        raw = sys.stdin.read()
    elif args.spec_json is not None:
        raw = args.spec_json
    elif args.spec is not None:
        try:
            raw = Path(args.spec).read_text(encoding="utf-8")
        except OSError as e:
            _die(f"cannot read --spec file: {e}")
    else:
        _die("provide one of --spec FILE, --spec-json STR, --stdin, or --from-markdown")
    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as e:
        _die(f"spec is not valid JSON: {e}")
    if not isinstance(spec, dict):
        _die("spec must be a JSON object")
    return spec


def _inline_md(text: str) -> str:
    # Escape HTML, then re-apply reportlab's mini-markup for bold/italic/code.
    text = html.escape(str(text))
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)\*(?!\*)", r"<i>\1</i>", text)
    text = re.sub(r"`([^`]+)`", r'<font face="Courier">\1</font>', text)
    return text


def _markdown_to_spec(md: str) -> dict:
    sections: list[dict] = []
    cur: dict | None = None

    def ensure() -> dict:
        nonlocal cur
        if cur is None:
            cur = {"paragraphs": [], "bullets": [], "numbered": []}
            sections.append(cur)
        return cur

    lines = md.splitlines()
    i = 0
    para: list[str] = []

    def flush_para():
        nonlocal para
        if para:
            ensure().setdefault("paragraphs", []).append(" ".join(para).strip())
            para = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith("```"):
            flush_para()
            block = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i])
                i += 1
            ensure().setdefault("code", []).append("\n".join(block))
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            flush_para()
            cur = {"heading": m.group(2).strip(), "level": min(3, len(m.group(1))),
                   "paragraphs": [], "bullets": [], "numbered": []}
            sections.append(cur)
            i += 1
            continue
        m = re.match(r"^[-*+]\s+(.*)$", stripped)
        if m:
            flush_para()
            ensure().setdefault("bullets", []).append(m.group(1).strip())
            i += 1
            continue
        m = re.match(r"^\d+[.)]\s+(.*)$", stripped)
        if m:
            flush_para()
            ensure().setdefault("numbered", []).append(m.group(1).strip())
            i += 1
            continue
        if stripped == "":
            flush_para()
        else:
            para.append(stripped)
        i += 1
    flush_para()
    return {"sections": sections}


def _render(spec: dict, output: Path) -> dict:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import inch
    from reportlab.platypus import (
        ListFlowable,
        ListItem,
        Paragraph,
        Preformatted,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    accent_hex = "#" + str(spec.get("accent", "1F4E35")).strip().lstrip("#")
    accent = colors.HexColor(accent_hex)

    styles = getSampleStyleSheet()
    h_styles = {
        1: ParagraphStyle("h1a", parent=styles["Heading1"], textColor=accent),
        2: ParagraphStyle("h2a", parent=styles["Heading2"], textColor=accent),
        3: ParagraphStyle("h3a", parent=styles["Heading3"], textColor=accent),
    }
    body = ParagraphStyle("bodya", parent=styles["BodyText"], alignment=TA_LEFT, spaceAfter=6)
    code_style = ParagraphStyle("codea", parent=styles["Code"], backColor=colors.whitesmoke, leftIndent=8)

    flow: list = []

    if spec.get("title"):
        flow.append(Paragraph(_inline_md(spec["title"]),
                              ParagraphStyle("titlea", parent=styles["Title"], textColor=accent)))
    if spec.get("subtitle"):
        flow.append(Paragraph(_inline_md(spec["subtitle"]),
                              ParagraphStyle("suba", parent=styles["Heading2"], textColor=colors.HexColor("#555555"))))
    if spec.get("author"):
        flow.append(Paragraph("<i>%s</i>" % _inline_md(spec["author"]), body))
    if spec.get("title") or spec.get("subtitle") or spec.get("author"):
        flow.append(Spacer(1, 0.25 * inch))

    sections = spec.get("sections", [])
    if not isinstance(sections, list):
        _die("`sections` must be an array")

    for idx, sec in enumerate(sections):
        if not isinstance(sec, dict):
            _die(f"section[{idx}] must be an object")
        if sec.get("heading"):
            level = sec.get("level", 1)
            try:
                level = max(1, min(3, int(level)))
            except (TypeError, ValueError):
                level = 1
            flow.append(Paragraph(_inline_md(sec["heading"]), h_styles[level]))
        for para in sec.get("paragraphs", []) or []:
            flow.append(Paragraph(_inline_md(para), body))
        bullets = sec.get("bullets", []) or []
        if bullets:
            flow.append(ListFlowable(
                [ListItem(Paragraph(_inline_md(b), body)) for b in bullets],
                bulletType="bullet", leftIndent=18,
            ))
        numbered = sec.get("numbered", []) or []
        if numbered:
            flow.append(ListFlowable(
                [ListItem(Paragraph(_inline_md(n), body)) for n in numbered],
                bulletType="1", leftIndent=18,
            ))
        for block in sec.get("code", []) or []:
            flow.append(Preformatted(str(block), code_style))
        table = sec.get("table")
        if table:
            headers = table.get("headers") or []
            rows = table.get("rows") or []
            data = ([list(map(str, headers))] if headers else []) + [list(map(str, r)) for r in rows]
            if data:
                t = Table(data, hAlign="LEFT")
                ts = [
                    ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#CCCCCC")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ]
                if headers:
                    ts += [
                        ("BACKGROUND", (0, 0), (-1, 0), accent),
                        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ]
                t.setStyle(TableStyle(ts))
                flow.append(t)
        flow.append(Spacer(1, 0.12 * inch))

    output.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(str(output), pagesize=letter,
                            leftMargin=0.9 * inch, rightMargin=0.9 * inch,
                            topMargin=0.9 * inch, bottomMargin=0.9 * inch)
    doc.build(flow or [Spacer(1, 1)])
    return {"sections": len(sections)}


def main(argv: "list[str] | None" = None) -> int:
    ap = argparse.ArgumentParser(
        prog="create_pdf",
        description="Build a PDF from a JSON spec or a Markdown file (pure-Python, reportlab).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--spec", metavar="FILE", help="Path to a JSON spec file.")
    src.add_argument("--spec-json", metavar="STR", help="Inline JSON spec string.")
    src.add_argument("--stdin", action="store_true", help="Read the JSON spec from stdin.")
    src.add_argument("--from-markdown", metavar="FILE", help="Render a Markdown file to PDF.")
    ap.add_argument("-o", "--output", required=True, metavar="PATH", help="Output .pdf path (parent dirs auto-created).")
    args = ap.parse_args(argv)

    output = Path(args.output)
    if output.suffix.lower() != ".pdf":
        output = output.with_suffix(".pdf")

    if args.from_markdown:
        md_path = Path(args.from_markdown)
        if not md_path.exists():
            _die(f"markdown file not found: {md_path}")
        spec = _markdown_to_spec(md_path.read_text(encoding="utf-8"))
    else:
        spec = _load_spec(args)

    extra = _render(spec, output)
    print(json.dumps({
        "output_path": str(output.resolve()),
        "format": "pdf",
        "bytes": output.stat().st_size if output.exists() else 0,
        **extra,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
