export function identityLabel(identity) { return identity.name || `#${identity.id.replace(/^agent-/, "").slice(0, 12)}`; }
export function formatDelivery(delivery) {
    const sender = identityLabel(delivery.sender);
    if (delivery.presence)
        return `<sideband event="${escapeXml(delivery.presence, true)}" participant="${escapeXml(sender, true)}" />`;
    return `<sideband sender="${escapeXml(sender, true)}">\n${escapeXml(delivery.text)}\n</sideband>`;
}
// Keep message text from closing the envelope or introducing a forged sender tag.
// The short fallback is a display label only; signatures still use the complete ID.
// '#' cannot occur in a user-chosen agent name, so names cannot impersonate this label.
function escapeXml(value, attribute = false) {
    return value.replace(attribute ? /[&<>"']/g : /[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
}
//# sourceMappingURL=protocol.js.map