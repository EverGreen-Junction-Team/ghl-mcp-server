// "Only assigned data" rules, shared by the built-in tools and the operation catalog.

// Which HighLevel scope prefixes belong to each module (for "assigned only" per module).
export const MODULE_SCOPES = {
  contacts: ["contacts"],
  opportunities: ["opportunities"],
  conversations: ["conversations"],
  calendars: ["calendars"],
};

/**
 * Whether a user's "assigned only" settings are acted on.
 *
 * Off, deliberately. Honouring the flag cost more than it bought: a user marked assigned-only
 * for *changing* contacts lost every contact, deal, calendar and object-record write in the
 * catalog, on their own records as much as anyone's, because the catalog can't tell whose
 * record an id belongs to. A user with the permission and the scope for an area now gets it,
 * and HighLevel still has the final say on every call.
 *
 * Nothing is deleted here: the settings are still read and still reported by whoami, and
 * ENFORCE_ASSIGNED_ONLY=true turns the gate back on without touching any caller.
 */
export const ENFORCING = process.env.ENFORCE_ASSIGNED_ONLY === "true";

/**
 * What HighLevel itself says about this user, whether or not we act on it. whoami reports
 * this so the setting stays visible; the gates use assignedOnlyReason instead.
 * - permissions.assignedDataOnly: everything, reading and changing.
 * - scopesAssignedToOnly: per scope, as HighLevel stores it. "contacts.write" there means only
 *   *changing* is limited to assigned contacts; "contacts.readonly" means *viewing* is limited.
 */
export function declaredAssignedOnly(user, module, write = false) {
  if (user?.permissions?.assignedDataOnly === true) return "assignedDataOnly";
  const only = Array.isArray(user?.scopesAssignedToOnly) ? user.scopesAssignedToOnly : [];
  const prefixes = MODULE_SCOPES[module] || [];
  const hit = only.find((s) => {
    if (!prefixes.some((p) => s === p || s.startsWith(p + ".") || s.startsWith(p + "/"))) return false;
    const isWrite = !/.read(only)?$/.test(s);
    return write ? isWrite : !isWrite;
  });
  return hit || null;
}

/**
 * Which HighLevel setting limits this user to their own records here, so a refusal can name it:
 * "assignedDataOnly", a scope such as "contacts.write", or null when nothing limits them --
 * which, while ENFORCING is off, is every user.
 */
export function assignedOnlyReason(user, module, write = false) {
  return ENFORCING ? declaredAssignedOnly(user, module, write) : null;
}

/** True if the user is limited to records assigned to them for this module and kind of action. */
export function assignedOnlyFor(user, module, write = false) {
  return assignedOnlyReason(user, module, write) !== null;
}
