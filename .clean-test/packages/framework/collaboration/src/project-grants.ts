import type { RuntimeEvent } from "@anthelia/contracts";

/**
 * The project-grant restore fold (pure): the journal's durable record of a
 * standing approval. Each `approval.response {decision:"project"}` answers
 * its request, and the request carries the permission family the human
 * granted for the whole project — so the fold pairs them and answers the
 * granted family ids, in journal order (a later reject of the same family
 * does NOT un-grant: the grant is a positive standing decision, and
 * revoking one is a different, explicit act — like the terminal grant's
 * revoke path).
 *
 * A response whose request never appears (a journal torn mid-stream)
 * grants nothing: an unpaired record is not a decision.
 */
export function projectGrantFamilies(
  events: readonly RuntimeEvent[],
): string[] {
  const familyByRequest = new Map<string, string>();
  const granted = new Set<string>();
  for (const event of events) {
    if (event.type === "approval.request") {
      const family = event.permissionFamily;
      if (family?.id) familyByRequest.set(event.id, family.id);
      continue;
    }
    if (event.type === "approval.response" && event.decision === "project") {
      const family = familyByRequest.get(event.id);
      if (family) granted.add(family);
    }
  }
  return [...granted];
}
