# Workflow Patterns

Use these patterns to guide the agent through complex multi-step processes.

## Sequential Workflows

For tasks with clear, linear steps. Provide an overview at the beginning of SKILL.md.

### Basic Sequential

```text
Processing a document involves these steps:

1. Load the document (run load_doc.py)
2. Extract content (run extract.py)
3. Transform data (run transform.py)
4. Validate output (run validate.py)
5. Save results (run save.py)
```

### With Checkpoints

```text
## Deployment Workflow

1. **Build** — Compile and bundle assets
   - Run: `npm run build`
   - Checkpoint: Verify `dist/` directory exists

2. **Test** — Run test suite
   - Run: `npm test`
   - Checkpoint: All tests pass (exit code 0)

3. **Deploy** — Push to production
   - Run: `./deploy.sh production`
   - Checkpoint: Health check returns 200

4. **Verify** — Smoke test production
   - Run: `./smoke-test.sh`
   - Checkpoint: All critical paths work
```

## Conditional Workflows

For tasks with branching logic. Guide the agent through decision points.

### Basic Conditional

```text
1. Determine the task type:
   **Creating new content?** → Follow "Creation Workflow" below
   **Editing existing content?** → Follow "Editing Workflow" below
   **Deleting content?** → Follow "Deletion Workflow" below

2. Creation Workflow:
   a. Validate input parameters
   b. Generate content
   c. Save to destination

3. Editing Workflow:
   a. Load existing content
   b. Apply modifications
   c. Save changes

4. Deletion Workflow:
   a. Confirm target exists
   b. Create backup
   c. Remove content
```

### Decision Tree

```text
## Document Processing Decision Tree

Start here:
│
├─ Is the file a PDF?
│  ├─ Yes → Is it fillable?
│  │        ├─ Yes → Use fill_form.py
│  │        └─ No → Use extract_text.py
│  └─ No → Continue below
│
├─ Is the file a DOCX?
│  ├─ Yes → Does it have tracked changes?
│  │        ├─ Yes → Use process_redlines.py
│  │        └─ No → Use simple_edit.py
│  └─ No → Continue below
│
└─ Unsupported format → Return error
```

## Iterative Workflows

For tasks that may require multiple passes or refinement.

### Refinement Loop

```text
## Content Generation Workflow

1. Generate initial draft
2. Review against requirements
3. If requirements not met:
   - Identify gaps
   - Revise content
   - Return to step 2
4. If requirements met:
   - Format output
   - Deliver result

Maximum iterations: 3
```

### Batch Processing

```text
## Batch File Processing

For each file in the input directory:
1. Validate file format
2. If valid:
   - Process file
   - Move to output/
3. If invalid:
   - Log error
   - Move to errors/
4. Continue to next file

After all files processed:
- Generate summary report
- Report success/failure counts
```

## Error Handling Workflows

### With Recovery

```text
## API Integration Workflow

1. Attempt API call
2. If successful → Process response
3. If failed:
   - Check error type
   - **Rate limited?** → Wait and retry (max 3 times)
   - **Auth error?** → Refresh token and retry
   - **Server error?** → Log and notify user
   - **Client error?** → Return validation message
```

### With Fallbacks

```text
## Data Retrieval Workflow

1. Try primary source (live API)
   - If available → Use response
   - If unavailable → Continue to step 2

2. Try secondary source (cache)
   - If fresh (< 1 hour) → Use cached data
   - If stale → Continue to step 3

3. Try fallback source (static defaults)
   - Use default values
   - Warn user data may be outdated
```

## Key Takeaways

- **Sequential workflows**: Best for linear, multi-step processes
- **Conditional workflows**: Handle branching logic with explicit decision points
- **Iterative workflows**: Allow refinement with clear exit conditions
- **Error handling**: Always define recovery strategies

Document workflows early in SKILL.md to set clear expectations.
