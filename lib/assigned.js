// "Only assigned data" rules, shared by the built-in tools and the operation catalog.

// Which HighLevel scope prefixes belong to each module (for "assigned only" per module).
export const MODULE_SCOPES = {
  contacts: ["contacts"],
  opportunities: ["opportunities"],
  conversations: ["conversations"],
  calendars: ["calendars"],
};

/**
 * True if the user is limited to records assigned to them for this module and kind of action.
 * - permissions.assignedDataOnly: everything, reading and changing.
 * - scopesAssignedToOnly: per scope, as HighLevel stores it. "contacts.write" there means only
 *   *changing* is limited to assigned contacts; "contacts.readonly" means *viewing* is limited.
 */
export function assignedOnlyFor(user, module, write = false) {
  if (user?.permissions?.assignedDataOnly === true) return true;
  const only = Array.isArray(user?.scopesAssignedToOnly) ? user.scopesAssignedToOnly : [];
  const prefixes = MODULE_SCOPES[module] || [];
  return only.some((s) => {
    if (!prefixes.some((p) => s === p || s.startsWith(p + ".") || s.startsWith(p + "/"))) return false;
    const isWrite = !/.read(only)?$/.test(s);
    return write ? isWrite : !isWrite;
  });
}
