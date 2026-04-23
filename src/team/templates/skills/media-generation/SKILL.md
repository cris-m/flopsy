---
name: media-generation
compatibility: Designed for FlopsyBot agent
description: Generate and deliver images, PDFs, charts, documents, and more using cloud APIs and Python. Load this skill when the user asks to create, generate, or produce images, charts, PDFs, or documents. For audio use the generate_audio tool directly — do not load this skill for audio.
---

# Media Generation

Generate files and deliver them to the user across any channel.

## Mindset

**Act. Don't ask.** When the user wants media, produce it. Don't ask which provider, which format — pick the best available option and go.

**Be creative.** The recipes below are starting points. Combine them, adapt them, chain them. If the user says "visualize my data" — pick the best chart type yourself.

**Find a way.** If the first approach fails, try another. If a library doesn't exist, find one that does. Exhaust every option before saying you can't.

**Never stop at text.** A text description of what you *would* generate is a failure, not a response.

## Scope

| Category | How |
|----------|-----|
| Audio / TTS | `generate_audio` tool — not this skill |
| AI Images | DALL-E via Python script |
| Charts | matplotlib (Python) |
| PDF | fpdf2 (Python) |
| DOCX | python-docx (Python) |
| CSV | Python csv stdlib |

## Python Execution Pipeline

For images, charts, PDFs, and documents:

```
CHECK → INSTALL → WRITE → RUN → VERIFY → DELIVER
```

1. **Check** API keys: `execute("[ -n \"$OPENAI_API_KEY\" ] && echo 'set' || echo 'no'")`
2. **Install** deps: `execute("source .venv/bin/activate && pip install <pkg>")`
   - Create venv first if missing: `execute("python3 -m venv .venv")`
3. **Write** script: `write_file("/scratch/<name>.py", ...)`
4. **Run**: `execute(".venv/bin/python /scratch/<name>.py")`
5. **Verify**: `execute("ls -la /scratch/<output>")` — 0 bytes = failure
6. **Deliver**: `send_message({ media: [{ type: "<type>", url: "/scratch/<output>" }] })`

**Never skip step 5.** Delivering a nonexistent file is a silent failure.

## Constraints

**Headless environment** — no display, no speakers, no GUI toolkit.

| Never Use | Why | Use Instead |
|-----------|-----|-------------|
| tkinter, pygame | No display server | matplotlib (`Agg` backend) |
| wkhtmltopdf | System binary | fpdf2 or reportlab |

---

## Recipes

### Image — DALL-E

```python
import os, requests, sys

api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    sys.exit("OPENAI_API_KEY not set")

from openai import OpenAI
client = OpenAI()
resp = client.images.generate(
    model="dall-e-3",
    prompt="a cute rabbit in a meadow",
    size="1024x1024",
    n=1,
)
img_url = resp.data[0].url
img_resp = requests.get(img_url)
img_resp.raise_for_status()

out = "/scratch/image.png"
with open(out, "wb") as f:
    f.write(img_resp.content)
print(f"Saved {len(img_resp.content)} bytes → {out}")
```

**Sizes:** `1024x1024` (square), `1792x1024` (landscape), `1024x1792` (portrait)

### Chart — matplotlib

```python
import matplotlib
matplotlib.use("Agg")  # REQUIRED — headless backend
import matplotlib.pyplot as plt
import os

labels = ["Apples", "Bananas", "Oranges"]
values = [30, 45, 20]
plt.bar(labels, values, color=["red", "yellow", "orange"])
plt.title("Fruit Count")

out = "/scratch/chart.png"
plt.savefig(out, dpi=150, bbox_inches="tight")
plt.close()
print(f"Saved {os.path.getsize(out)} bytes → {out}")
```

**`matplotlib.use("Agg")` must come before `import matplotlib.pyplot`.**

### PDF — fpdf2

```python
from fpdf import FPDF
import os

pdf = FPDF()
pdf.add_page()
pdf.set_font("Helvetica", size=16)
pdf.cell(text="Report Title", new_x="LMARGIN", new_y="NEXT")
pdf.ln(5)
pdf.set_font("Helvetica", size=12)
pdf.multi_cell(w=0, text="Report body with automatic line wrapping.")

out = "/scratch/report.pdf"
pdf.output(out)
print(f"Saved {os.path.getsize(out)} bytes → {out}")
```

### DOCX — python-docx

```python
from docx import Document
from docx.shared import Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
import os

doc = Document()
title = doc.add_heading("Report Title", level=0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_paragraph("Introduction paragraph.")

p = doc.add_paragraph()
p.add_run("Bold text").bold = True
p.add_run(" followed by normal text.")

table = doc.add_table(rows=1, cols=3)
table.style = "Table Grid"
hdr = table.rows[0].cells
hdr[0].text, hdr[1].text, hdr[2].text = "Name", "Role", "Status"
row = table.add_row().cells
row[0].text, row[1].text, row[2].text = "Alice", "Engineer", "Active"

out = "/scratch/report.docx"
doc.save(out)
print(f"Saved {os.path.getsize(out)} bytes → {out}")
```

### CSV — stdlib

```python
import csv, os

data = [
    {"name": "Alice", "score": 95},
    {"name": "Bob", "score": 87},
]

out = "/scratch/results.csv"
with open(out, "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=data[0].keys())
    writer.writeheader()
    writer.writerows(data)
print(f"Saved {len(data)} rows → {out}")
```

---

## Delivery

```
send_message({
  channel, peer_id, peer_type,
  message: "Here's your file",
  media: [
    { type: "image", url: "/scratch/chart.png" },
    { type: "document", url: "/scratch/report.pdf" }
  ]
})
```

| Type | Extensions |
|------|-----------|
| Image | png, jpg, jpeg, gif, webp, svg |
| Audio | mp3, wav, ogg, m4a |
| Video | mp4, webm |
| Document | pdf, csv, xlsx, docx, json, txt |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Output file is 0 bytes | API error body written instead of media | Add `raise_for_status()`, check `Content-Type` |
| `ModuleNotFoundError` | System Python used | Use `.venv/bin/python`, install into venv first |
| `_tkinter` crash | Missing `matplotlib.use("Agg")` | Must be called before `import matplotlib.pyplot` |
| `FileNotFoundError` | Directory doesn't exist | `execute("mkdir -p /scratch")` |
| Same error 3x | Stuck on same approach | **Stop.** Switch library or method entirely |
