/**
 * skill_manage — create and evolve SKILL.md files in the workspace.
 *
 * Three operations:
 *   create          — write a new SKILL.md (skips if the file already exists)
 *   append_lessons  — add bullet points to the ## Lessons Learned section
 *   bump_version    — update the frontmatter `version` field
 *
 * Files are written atomically (write-to-tmp then rename) so the skills()
 * interceptor never reads a partial file during a directory scan.
 */

import { z } from 'zod';
import { defineTool } from 'flopsygraph';
import { resolveWorkspacePath } from '@flopsy/shared';
import { writeSkillFile, appendLessonsToSkill, bumpSkillVersion } from '../harness/review';

// Flat object schema — OpenAI requires type:"object" at the top level and
// rejects discriminatedUnion's oneOf output.
const schema = z.object({
    operation: z
        .enum(['create', 'append_lessons', 'bump_version'])
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
});

export const skillManageTool = defineTool({
    name: 'skill_manage',
    description: `Create and evolve SKILL.md files in the workspace skills directory.

Each skill lives at: .flopsy/skills/<skillName>/SKILL.md
The frontmatter \`name\` field MUST be identical to skillName or the skill is ignored.

Operations:
- \`create\`         — write a NEW skill (skipped, not an error, if it already exists).
- \`append_lessons\` — add bullet points to the ## Lessons Learned section of an existing skill.
- \`bump_version\`   — update the frontmatter \`version\` field of an existing skill.

Use \`create\` when you notice a reusable multi-step procedure the team should remember.
Use \`append_lessons\` after a task reveals a non-obvious gotcha for an existing skill.
Use \`bump_version\` after significantly refining an existing skill's steps.`,
    schema,
    async execute(args, ctx) {
        const skillsPath = resolveWorkspacePath('skills');
        const configurable = (ctx?.configurable ?? {}) as { workspace?: string };
        const effectivePath = configurable.workspace
            ? `${configurable.workspace}/skills`
            : skillsPath;

        switch (args.operation) {
            case 'create': {
                if (!args.content) return 'Missing required field: content';
                const written = await writeSkillFile(effectivePath, args.skillName, args.content);
                return written
                    ? `Skill "${args.skillName}" created.`
                    : `Skill "${args.skillName}" already exists — skipped.`;
            }
            case 'append_lessons': {
                if (!args.lessons?.length) return 'Missing required field: lessons';
                const ok = await appendLessonsToSkill(effectivePath, args.skillName, args.lessons);
                return ok
                    ? `Appended ${args.lessons.length} lesson(s) to "${args.skillName}".`
                    : `Skill "${args.skillName}" not found — cannot append lessons.`;
            }
            case 'bump_version': {
                if (!args.version) return 'Missing required field: version';
                const ok = await bumpSkillVersion(effectivePath, args.skillName, args.version);
                return ok
                    ? `Version of "${args.skillName}" updated to ${args.version}.`
                    : `Skill "${args.skillName}" not found — cannot bump version.`;
            }
        }
    },
});
