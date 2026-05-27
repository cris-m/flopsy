import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { validatePathIdentifier, workspace } from '@flopsy/shared';
import { writeSkillFile, appendLessonsToSkill, bumpSkillVersion, patchSkillFile, lessonFingerprint, classifySkillRisk } from '../harness/review';
import type { SkillUsageStore } from '../harness/review';
import { getSharedLearningStore } from '../harness';

const VALIDATION_BASELINE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const VALIDATED_GATE_SKILL = 'proactive';

const schema = z.object({
    operation: z
        .enum(['create', 'append_lessons', 'patch', 'bump_version', 'archive', 'pin', 'unpin'])
        .describe('Which operation to perform'),
    skillName: z
        .string()
        .describe('Kebab-case skill name without .md (e.g. "send-email-workflow")'),
    content: z
        .string()
        .optional()
        .describe('(create) Full SKILL.md content including YAML frontmatter. MUST set `category:` in frontmatter — one of: channels, delegation, macos, media, memory, meta, output, productivity, research, security. The skill is stored at skills/<category>/<skillName>/SKILL.md.'),
    lessons: z
        .array(z.string().min(1))
        .max(10)
        .optional()
        .describe('(append_lessons) Bullet strings to append under ## Lessons Learned. Pass `[]` to record "reviewed, no new lessons" — required every self-improve fire so the audit trail captures every review.'),
    version: z
        .string()
        .optional()
        .describe('(bump_version) New semver string e.g. "1.2" or "1.2.3"'),
    find: z
        .string()
        .optional()
        .describe('(patch) Exact substring to find in SKILL.md (no regex). Copy verbatim from the file including whitespace.'),
    replace: z
        .string()
        .optional()
        .describe('(patch) Replacement string. May be empty to delete the matched text.'),
    expectedCount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('(patch) How many occurrences of `find` you expect. Defaults to 1 — patch is refused if the actual count differs.'),
});

export const skillManageTool = defineTool({
    name: 'skill_manage',
    description: `Create and evolve SKILL.md files in .flopsy/content/skills/<category>/<skillName>/SKILL.md. Frontmatter \`name\` MUST match skillName or the skill is ignored.

Categories (set \`category:\` in frontmatter on create):
  channels, delegation, macos, media, memory, meta, output, productivity, research, security.
If none fits, pick a new kebab-case group; prefer an existing one when in doubt.

Operations:
  create         — write a new skill. Skipped (not an error) if it already exists. Args: content (full SKILL.md including frontmatter). Low-risk skills auto-promote to live; controversial ones (destructive ops, sending to external recipients, credentials, payments, package installs, scheduling, security category) are PROPOSED for review and need /skills approve. Force the gate either way with frontmatter \`review: required\` or \`review: none\`.
  append_lessons — append bullets under ## Lessons Learned. Args: lessons (≤10 strings).
  patch          — exact substring find-and-replace. Args: find, replace, expectedCount (default 1). Refused if occurrence count differs.
  bump_version   — set frontmatter \`version\`. Args: version (semver).
  archive        — hide from catalog and stop auto-injecting. Skill stays on disk.
  pin            — exempt from curator auto-archival.
  unpin          — re-enable normal curator transitions.

Style:
  - create when you spot a reusable multi-step procedure worth remembering.
  - append_lessons after a task reveals a non-obvious gotcha.
  - patch to fix a specific section without rewriting the file.
  - bump_version after meaningful refinement.
  - pin only skills that must always stay available (e.g. channel conventions).`,
    schema,
    async execute(args, ctx) {
        const skillsPath = workspace.skills();
        const configurable = (ctx?.configurable ?? {}) as { workspace?: string; skillUsageStore?: SkillUsageStore };
        const effectivePath = configurable.workspace
            ? `${configurable.workspace}/skills`
            : skillsPath;
        const usageStore = configurable.skillUsageStore;

        // skillName becomes a directory path — block traversal before any fs touch.
        const nameCheck = validatePathIdentifier(args.skillName, 'skillName');
        if (!nameCheck.ok) return nameCheck.error;

        switch (args.operation) {
            case 'create': {
                if (!args.content) return 'Missing required field: content';
                const risk = classifySkillRisk(args.content);
                if (risk.requiresReview) {
                    const proposedRoot = configurable.workspace
                        ? `${configurable.workspace}/skills-proposed`
                        : workspace.skillsProposed();
                    const proposed = await writeSkillFile(proposedRoot, args.skillName, args.content);
                    return proposed
                        ? `Skill "${args.skillName}" PROPOSED for review (${risk.reasons.join('; ')}) — NOT live yet. Tell the user to run /skills approve ${args.skillName} to activate it.`
                        : `Skill "${args.skillName}" already proposed — skipped.`;
                }
                const written = await writeSkillFile(effectivePath, args.skillName, args.content);
                if (written) usageStore?.markAgentCreated(args.skillName);
                return written
                    ? `Skill "${args.skillName}" created and auto-promoted (low risk).`
                    : `Skill "${args.skillName}" already exists — skipped.`;
            }
            case 'append_lessons': {
                // Empty array is a valid "reviewed, nothing new" signal — keeps the self-improve audit trail complete.
                if (args.lessons === undefined) return 'Missing required field: lessons (use [] for "no new lessons this fire")';
                if (args.lessons.length === 0) {
                    return `Reviewed "${args.skillName}"; 0 new lessons to append.`;
                }
                const ok = await appendLessonsToSkill(effectivePath, args.skillName, args.lessons);
                if (ok) {
                    usageStore?.patch(args.skillName);
                    // Validation gate: put proactive-skill lessons on probation (curator's sweep later accepts/reverts).
                    if (
                        usageStore &&
                        args.skillName === VALIDATED_GATE_SKILL &&
                        !usageStore.getPendingEdit(VALIDATED_GATE_SKILL)
                    ) {
                        const rejected = new Set(usageStore.getRejectedEdits(VALIDATED_GATE_SKILL));
                        const bullets = args.lessons.filter((l) => !rejected.has(lessonFingerprint(l)));
                        if (bullets.length > 0) {
                            try {
                                const eng = getSharedLearningStore().getProactiveEngagement(
                                    Date.now() - VALIDATION_BASELINE_WINDOW_MS,
                                );
                                usageStore.recordPendingEdit(VALIDATED_GATE_SKILL, {
                                    fingerprints: bullets.map(lessonFingerprint),
                                    bullets,
                                    appliedAt: Date.now(),
                                    baselineRate: eng.delivered > 0 ? eng.replied / eng.delivered : 0,
                                    baselineN: eng.delivered,
                                });
                            } catch {
                                /* best-effort — trial recording must never break the tool */
                            }
                        }
                    }
                }
                return ok
                    ? `Appended ${args.lessons.length} lesson(s) to "${args.skillName}".`
                    : `Skill "${args.skillName}" not found — cannot append lessons.`;
            }
            case 'patch': {
                if (args.find === undefined) return 'Missing required field: find';
                if (args.replace === undefined) return 'Missing required field: replace (use empty string to delete the match)';
                const result = await patchSkillFile(
                    effectivePath,
                    args.skillName,
                    args.find,
                    args.replace,
                    args.expectedCount ?? 1,
                );
                if (result.ok) usageStore?.patch(args.skillName);
                return result.message;
            }
            case 'bump_version': {
                if (!args.version) return 'Missing required field: version';
                const ok = await bumpSkillVersion(effectivePath, args.skillName, args.version);
                if (ok) usageStore?.patch(args.skillName);
                return ok
                    ? `Version of "${args.skillName}" updated to ${args.version}.`
                    : `Skill "${args.skillName}" not found — cannot bump version.`;
            }
            case 'archive': {
                if (!usageStore) return 'skill_manage archive: no usage store available.';
                usageStore.setState(args.skillName, 'archived');
                return `Skill "${args.skillName}" archived — hidden from catalog. Use /skills to review.`;
            }
            case 'pin': {
                if (!usageStore) return 'skill_manage pin: no usage store available.';
                usageStore.setPinned(args.skillName, true);
                return `Skill "${args.skillName}" pinned — curator will not auto-archive it.`;
            }
            case 'unpin': {
                if (!usageStore) return 'skill_manage unpin: no usage store available.';
                usageStore.setPinned(args.skillName, false);
                return `Skill "${args.skillName}" unpinned — normal curator transitions apply.`;
            }
        }
    },
});
