# System Design Interview Questions

For mid-to-senior level. Scale expectations to the candidate's level.

## Classic Systems

1. **Design a URL shortener** (like bit.ly)
   - Key topics: hashing, base62 encoding, read-heavy caching, database choice, analytics
   - Common pitfall: ignoring collision handling and custom URLs

2. **Design a chat application** (like WhatsApp/Slack)
   - Key topics: WebSockets vs long polling, message ordering, read receipts, presence, offline sync
   - Common pitfall: ignoring delivery guarantees and message ordering

3. **Design a news feed** (like Twitter/Facebook)
   - Key topics: fan-out on write vs read, ranking, caching, pagination, real-time updates
   - Common pitfall: not discussing the trade-off between push and pull models

4. **Design a rate limiter**
   - Key topics: token bucket, sliding window, distributed rate limiting, Redis, response headers
   - Common pitfall: only designing for single-server case

5. **Design a file storage service** (like Dropbox/Google Drive)
   - Key topics: chunked upload, deduplication, sync conflicts, metadata store, CDN
   - Common pitfall: ignoring sync conflict resolution

## Data-Heavy Systems

6. **Design a search engine** (like Google)
   - Key topics: crawling, indexing (inverted index), ranking (PageRank), query processing, caching
   - Common pitfall: only discussing crawling, ignoring ranking and relevance

7. **Design a recommendation system** (like Netflix/YouTube)
   - Key topics: collaborative filtering, content-based, hybrid, cold start, A/B testing, feature store
   - Common pitfall: not discussing cold start problem

8. **Design a distributed cache** (like Redis/Memcached)
   - Key topics: consistent hashing, eviction policies, replication, cache invalidation
   - Common pitfall: "cache invalidation is hard" without explaining HOW to handle it

9. **Design a logging/monitoring system** (like Datadog)
   - Key topics: log ingestion, time-series DB, alerting, dashboards, sampling, retention
   - Common pitfall: not addressing log volume and cost

10. **Design a payment system** (like Stripe)
    - Key topics: idempotency, double-spend prevention, ledger, reconciliation, PCI compliance
    - Common pitfall: ignoring failure cases and reconciliation

## Infrastructure Systems

11. **Design a task queue** (like Celery/SQS)
    - Key topics: at-least-once delivery, dead letter queues, priority, backpressure, worker scaling
    - Common pitfall: ignoring poison messages and retry storms

12. **Design a CDN**
    - Key topics: edge caching, cache invalidation, origin shield, geographic routing, TLS termination
    - Common pitfall: not discussing cache consistency

13. **Design a notification system** (push, email, SMS)
    - Key topics: priority, deduplication, rate limiting per user, channel routing, template engine
    - Common pitfall: not discussing user preferences and opt-out

---

## How to Approach System Design

### Structure (spend 35-40 minutes)

| Phase | Time | Focus |
|-------|------|-------|
| **Clarify requirements** | 5 min | Functional + non-functional, scale, constraints |
| **High-level design** | 10 min | Core components, data flow, API surface |
| **Deep dive** | 15 min | Database schema, scaling bottlenecks, trade-offs |
| **Edge cases & operations** | 5-10 min | Failure modes, monitoring, deployment |

### What Interviewers Look For

| Signal | How to Show It |
|--------|---------------|
| **Scoping** | Ask clarifying questions before designing. Do not assume. |
| **Trade-off reasoning** | "We could use X which gives us A but costs B, or Y which..." |
| **Numbers awareness** | Back-of-envelope: QPS, storage, bandwidth, latency targets |
| **Practical experience** | "In my experience at [company], we chose X because..." |
| **Depth on demand** | When interviewer probes, go deeper without being prompted to surface |

### Common Mistakes

- Jumping to components without understanding requirements
- Not asking about scale (10 users vs 10 million users = different system)
- Ignoring non-functional requirements (latency, availability, consistency)
- Over-engineering for day 1 instead of planning for evolution
- Not discussing monitoring, alerting, or operational concerns
