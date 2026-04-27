---
name: shodan
compatibility: Designed for FlopsyBot agent
description: Search and analyze internet-connected devices, open ports, vulnerabilities, and DNS records using Shodan. Use when investigating IP addresses, scanning infrastructure, or checking network exposure.
---

# Shodan

Network intelligence via the Shodan API. Look up hosts, search for devices, resolve DNS, and discover vulnerabilities on internet-facing infrastructure.

## When to Use This Skill

- User asks "what's running on this IP?" or "what ports are open?"
- User wants to know if a server has known vulnerabilities
- User asks about network exposure or attack surface
- DNS resolution needed: hostname to IP or reverse lookup
- User wants to search for specific devices or services on the internet
- Security investigation: checking C2 servers, exposed services, or suspicious infrastructure

## Tools

| Tool | Purpose | Input |
|------|---------|-------|
| `shodan_host` | Full host info: ports, services, vulns, geo | IPv4 address |
| `shodan_search` | Search for devices matching a query | Shodan query + page |
| `shodan_dns_resolve` | Resolve hostnames to IPs | Comma-separated hostnames |
| `shodan_dns_reverse` | Reverse DNS: IPs to hostnames | Comma-separated IPs |
| `shodan_host_count` | Count matching results (no credits used) | Shodan query |
| `shodan_info` | Check API plan and remaining credits | (none) |

## Workflow

### IP Investigation

1. Call `shodan_host` with the IP address
2. Review the response:
   - **ports**: What services are exposed?
   - **vulns**: Any known CVEs?
   - **services**: Product names and versions (look for outdated software)
   - **org/isp**: Who owns this IP?
   - **country/city**: Where is it located?
3. Cross-reference with VirusTotal (`vt_ip_report`) for threat intelligence

### Device Search

1. Use `shodan_host_count` first to gauge result volume (free, no credits)
2. If count is reasonable, use `shodan_search` to get actual results
3. Review matches for exposed services, versions, and vulnerabilities

### Common Search Queries

| Query | Finds |
|-------|-------|
| `apache country:JP` | Apache servers in Japan |
| `port:22 os:linux` | Linux hosts with SSH open |
| `nginx city:Berlin` | Nginx servers in Berlin |
| `vuln:CVE-2021-44228` | Hosts vulnerable to Log4Shell |
| `product:MySQL port:3306` | Exposed MySQL databases |
| `ssl.cert.subject.CN:example.com` | SSL certs for a domain |
| `http.title:"Dashboard"` | Web dashboards |
| `org:"Amazon"` | Devices owned by Amazon |
| `has_vuln:true country:US` | Vulnerable hosts in the US |

### DNS Operations

- **Forward resolve**: `shodan_dns_resolve` with `"example.com,test.com"` returns their IPs
- **Reverse lookup**: `shodan_dns_reverse` with `"8.8.8.8,1.1.1.1"` returns hostnames
- Use these to map infrastructure before deeper investigation

### Credit Management

- `shodan_search` consumes 1 query credit per call
- `shodan_host_count` is free — always use it first to preview
- `shodan_host` lookups are free on most plans
- Call `shodan_info` to check remaining credits before large searches

## Interpreting Results

### Host Report Key Fields

| Field | Meaning |
|-------|---------|
| `ports` | Open ports discovered by Shodan scanners |
| `vulns` | CVE IDs for known vulnerabilities |
| `services` | Running software: product name, version, transport |
| `os` | Detected operating system |
| `org` | Organization that owns the IP block |
| `isp` | Internet service provider |

### Vulnerability Assessment

- Vulns listed are based on version fingerprinting — they indicate *potential* vulnerability, not confirmed exploitation
- Cross-reference CVEs with severity databases for CVSS scores
- High port count + many vulns = poorly maintained infrastructure
- Unexpected open ports (e.g., 3389 RDP, 5900 VNC on a web server) are red flags

### Service Analysis

Look for:
- **Outdated versions**: Old Apache, nginx, OpenSSH versions with known CVEs
- **Default pages**: "Welcome to nginx" = unconfigured server
- **Exposed management**: Ports 8080, 8443, 9090 often expose admin panels
- **Database ports**: 3306 (MySQL), 5432 (PostgreSQL), 27017 (MongoDB) should not be public

## Guidelines

- Always check `shodan_host_count` before `shodan_search` to avoid wasting credits
- Combine with VirusTotal for comprehensive threat assessment (Shodan = network layer, VT = threat intel layer)
- When investigating a suspicious IP, gather both Shodan host data and VT IP report
- Report vulnerabilities with CVE IDs so the user can look up severity and patches
- Note the `lastUpdate` field — Shodan data can be days or weeks old
- For DNS investigation chains: resolve domain → get IP → host lookup → check VT
- Do not use Shodan to actively scan or probe systems — it only shows passively collected data
