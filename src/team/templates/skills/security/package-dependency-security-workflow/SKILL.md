---
name: package-dependency-security-workflow
category: security
description: A structured method for vetting, restricting, and securing external package dependencies to mitigate supply chain risks.
when-to-use: Use this when discussing package managers (npm, pip, etc.), verifying a third-party library, or being asked how to prevent dependency attacks. It systematically covers vetting, locking, and isolation.
---

### 🔒 Package Dependency Security Workflow

This workflow ensures that the code or components you rely on from external sources are vetted, controlled, and fit for purpose, minimizing the risk of supply chain attacks (e.g., typosquatting, malicious updates).

**Phase 1: Vetting and Source Control (The 'Find' Stage)**
1. **Specify Requirements Clearly:** Never use vague version ranges (`^1.0.0` or `*`). Always pin specific versions in `package.json` or `requirements.txt`.
2. **Check Reputation:** Before adoption, check dependency reputation scores (if available) and verify the package's maintenance history (recent commits, clear changelog).
3. **Review Dependencies (Graph Analysis):** Use tools like `npm audit` or Pip-Tools to generate and analyze the full dependency tree. Be aware of transitive dependencies (dependencies of your dependencies).

**Phase 2: Locking and Mitigation (The 'Fix' Stage)**
1. **Always Use Lockfiles:** Commit and enforce the use of `package-lock.json`, `Pipfile.lock`, or vendor lock files. These files guarantee that the *exact* version of every installed dependency is used, preventing accidental breakage or malicious version upgrades.
2. **Implement Dependency Review:** Require a formal code/security review whenever a new major dependency is added or an existing one's version is upgraded.
3. **Isolation/Sandboxing:** For critical systems, run installations and/or execution within isolated environments (e.g., Docker containers, virtual machines) to limit the potential blast radius of a malicious package.

**Phase 3: Remediation and Monitoring (The 'Maintain' Stage)**
1. **Automated Dependency Scanning:** Integrate SAST/SCA tools (e.g., Snyk, GitHub Dependabot) into the CI/CD pipeline. **DO NOT** rely solely on manual checks.
2. **Pinning Strategy:** Upgrade dependencies in controlled sprints, treating version changes as risky changes that require full regression testing.
3. **Watch for Malicious Signals:** Monitor advisories and package registries for sudden, unexplained changes in a common library's behavior or ownership.

### Concrete tooling by ecosystem

The phases above are ecosystem-agnostic. Map each stage to the real command:

| Stage | npm / Node | Python (prefer `uv`) |
|---|---|---|
| Audit the tree for known CVEs | `npm audit` | `pip-audit` (PyPA; uses PyPI Advisory DB + OSV) — `uvx pip-audit` to run without installing |
| Cross-ecosystem scan (one tool) | `osv-scanner -r .` | `osv-scanner -r .` (covers `requirements.txt`, `uv.lock`, `poetry.lock`, npm, more) |
| Produce a pinned lockfile | `package-lock.json` (committed) | `uv lock` → `uv.lock`, or `uv pip compile reqs.in -o requirements.txt --generate-hashes` |
| Reproducible / verified install | `npm ci` | `uv sync --locked`, or `pip install --require-hashes -r requirements.txt` |
| Automated CI monitoring | Dependabot / Renovate | Dependabot (`pip` ecosystem) or Renovate + `pip-audit` as a CI gate |

**Python-specific guardrails:**
- **Hash-pin, don't just version-pin.** `--generate-hashes` + `--require-hashes` makes pip/uv reject any artifact whose hash doesn't match the lockfile — the strongest defense against a tampered or swapped PyPI release.
- **`uv` over `pip install`** in this workspace (see AGENTS.md): `uvx <tool>` runs a scanner in a throwaway env, and PEP 723 inline deps keep one-off scripts self-contained — no global installs to vet.
- **Typosquatting on PyPI is rampant.** Verify the exact project name on pypi.org (publisher, release history) before adding — `reqeusts`, `python-sqlite`, etc. are classic traps.

### Using Flopsy's own tools (in conversation, not just external CI)

The CI tools above (Dependabot, Snyk) live in the user's repo. Mid-conversation, reach for live tools:

- **Run the actual audit** — `pip-audit` / `osv-scanner` / `npm audit` via `code_agent` (on the user's real machine, sees their lockfiles) or `execute_code` for a throwaway check.
- **Vet a specific *suspicious* package or artifact → delegate to your security worker** (it owns VirusTotal): `vt_url_report` on the download/registry URL, `vt_domain_report` on the maintainer's linked domain, `vt_file_report` on the SHA-256 of the downloaded `.whl`/`.tgz`. **VirusTotal checks malware/reputation of that one file/URL/domain — it does NOT enumerate CVEs** (that's `pip-audit`/`osv`). Route anything you suspect is hostile through the security worker FIRST, before reading or executing it.
- **"Is there an active supply-chain attack right now?" → `web_search`** (or delegate to research): `web_search("PyPI OR npm malicious package <name>", when="7d")`, `web_search("<ecosystem> supply chain attack this week", when="48h")`. Surface the advisory/CVE ID + affected versions + source URL.

**Order:** known-CVE audit (`pip-audit`/`osv`) → if a dep looks unknown/suspicious, reputation check via the security worker (VirusTotal) → recent-news scan for an active campaign.
