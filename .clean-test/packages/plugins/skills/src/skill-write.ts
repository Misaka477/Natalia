/**
 * The validated skill write (Discovery D4's write surface; hermes'
 * discipline: "autonomous maintenance must go through skill_manage's
 * validation" — the ONLY path a background review may use to persist).
 *
 * The whitelist is enforced HERE, at the write boundary: the caller may
 * propose, never command — anything that is not a create/update of a
 * skill by name is rejected with the reason it deserves. Content is
 * rebuilt (frontmatter is serialized by us), never pasted through, so a
 * proposal cannot smuggle a different name past validation.
 */

export type SkillProposal = {
  kind: "create" | "update";
  name: string;
  description: string;
  content: string;
};

export const MAX_SKILL_CONTENT_BYTES = 64_000;

export type SkillValidation =
  | { ok: true; proposal: SkillProposal; skillmd: string }
  | { ok: false; reason: string };

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export function serializeSkillMd(proposal: SkillProposal): string {
  // JSON.stringify is valid YAML for a single-line string — quotes and
  // colons in prose cannot break the frontmatter the loader parses.
  return `---\nname: ${proposal.name}\ndescription: ${JSON.stringify(proposal.description.trim())}\n---\n\n${proposal.content.trim()}\n`;
}

export function validateSkillProposal(candidate: unknown): SkillValidation {
  if (typeof candidate !== "object" || candidate === null)
    return { ok: false, reason: "proposal is not an object" };
  const raw = candidate as Record<string, unknown>;
  // The action whitelist: a review may only create or update a skill.
  // Delete/execute/file paths are not even representable here.
  if (raw.kind !== "create" && raw.kind !== "update")
    return { ok: false, reason: `action not whitelisted: ${String(raw.kind)}` };
  if (typeof raw.name !== "string" || !NAME_PATTERN.test(raw.name))
    return { ok: false, reason: "invalid skill name" };
  if (typeof raw.description !== "string" || !raw.description.trim())
    return { ok: false, reason: "description required" };
  if (typeof raw.content !== "string" || !raw.content.trim())
    return { ok: false, reason: "content required" };
  if (Buffer.byteLength(raw.content, "utf8") > MAX_SKILL_CONTENT_BYTES)
    return {
      ok: false,
      reason: `content exceeds ${MAX_SKILL_CONTENT_BYTES} bytes`,
    };
  const proposal: SkillProposal = {
    kind: raw.kind,
    name: raw.name,
    description: raw.description.trim(),
    content: raw.content,
  };
  return { ok: true, proposal, skillmd: serializeSkillMd(proposal) };
}
