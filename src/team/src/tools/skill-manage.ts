/**
 * skill_manage — create, evolve, and curate SKILL.md files in the workspace.
 *
 * Operations:
 *   create          — write a new SKILL.md (skips if already exists)
 *   append_lessons  — add bullet points to the ## Lessons Learned section
 *   patch           — exact find-and-replace within an existing SKILL.md
 *   bump_version    — update the frontmatter `version` field
 *   archive         — mark a skill as archived (stays on disk, hidden from catalog)
 *   pin             — prevent the curator from auto-archiving this skill
 *   unpin           — re-enable curator auto-archival
 *
 * Files are written atomically (write-to-tmp then rename) so the skills()
 * interceptor never reads a partial file during a directory scan.
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { validatePathIdentifier, workspace } from '@flopsy/shared';
import { writeSkillFile, appendLessonsToSkill, bumpSkillVersion, patchSkillFile } from '../harness/review';
import type { SkillUsageStore } from '../harness/review';

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
        .describe('(create) Full SKILL.md content including YAML frontmatter'),
    lessons: z
        .array(z.string().min(1))
        .max(10)
        .optional()
        .describe('(append_lessons) Bullet strings to append under ## Lessons Learned'),
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
    description: `Create and evolve SKILL.md files in the workspace skills directory.

Each skill lives at: .flopsy/skills/<skillName>/SKILL.md
The frontmatter \`name\` field MUST be identical to skillName or the skill is ignored.

Operations:
- \`create\`         — write a NEW skill (skipped, not an error, if it already exists).
- \`append_lessons\` — add bullet points to the ## Lessons Learned section of an existing skill.
- \`patch\`          — exact find-and-replace within an existing SKILL.md. Use to evolve a skill without rewriting the whole file (fix a stale path, correct an example, refine wording).
- \`bump_version\`   — update the frontmatter \`version\` field of an existing skill.
- \`archive\`        — mark skill as archived. It stays on disk but is hidden from the catalog and will no longer be auto-injected into the system prompt. Use when a skill is superseded or no longer relevant.
- \`pin\`            — protect a skill from the auto-archival curator. Pinned skills are never auto-archived regardless of use count or age.
- \`unpin\`          — remove the pin, allowing normal curator transitions.

Use \`create\` when you notice a reusable multi-step procedure the team should remember.
Use \`append_lessons\` after a task reveals a non-obvious gotcha for an existing skill.
Use \`patch\` to correct a specific section of a skill — \`find\` must be a unique substring (refused if it appears 0 or 2+ times unless \`expectedCount\` matches).
Use \`bump_version\` after significantly refining an existing skill's steps.
Use \`archive\` when a skill is superseded by a better one or is no longer applicable.
Use \`pin\` for critical skills that must always stay available (e.g. channel-specific conventions).`,
    schema,
    async execute(args, ctx) {
        const skillsPath = workspace.skills();
        const configurable = (ctx?.configurable ?? {}) as { workspace?: string; skillUsageStore?: SkillUsageStore };
        const effectivePath = configurable.workspace
            ? `${configurable.workspace}/skills`
            : skillsPath;
        const usageStore = configurable.skillUsageStore;

        // skillName becomes a directory under `effectivePath` via
        // writeSkillFile → join(skillsPath, skillName, 'SKILL.md').
        // The LLM can craft "../../etc/cron.d/runme" so we validate
        // shape here before any fs touch. Pattern matches a kebab-case
        // identifier: alphanumeric + underscore + hyphen, capped at 128
        // chars. Tightens the original `z.string()` Zod schema which
        // had no constraint at all.
        const nameCheck = validatePathIdentifier(args.skillName, 'skillName');
        if (!nameCheck.ok) return nameCheck.error;

        switch (args.operation) {
            case 'create': {
                if (!args.content) return 'Missing required field: content';
                const written = await writeSkillFile(effectivePath, args.skillName, args.content);
                if (written) usageStore?.markAgentCreated(args.skillName);
                return written
                    ? `Skill "${args.skillName}" created.`
                    : `Skill "${args.skillName}" already exists — skipped.`;
            }
            case 'append_lessons': {
                if (!args.lessons?.length) return 'Missing required field: lessons';
                const ok = await appendLessonsToSkill(effectivePath, args.skillName, args.lessons);
                if (ok) usageStore?.patch(args.skillName);
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
