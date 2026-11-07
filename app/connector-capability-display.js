export const CONNECTOR_COVERAGE_UNAVAILABLE_MESSAGE = "Connector check coverage is unavailable.";
export const CONNECTOR_UNAVAILABLE_REASON_MISSING = "Connector did not report why this check is unavailable.";

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function getConnectorCoverageDisplay(capabilityCoverage) {
  const items = Array.isArray(capabilityCoverage)
    ? capabilityCoverage
      .map((capability) => {
        if (!capability || typeof capability !== "object") return null;
        const label = cleanText(capability.label);
        if (!label) return null;
        const status = capability.status === "available" ? "available" : "unavailable";
        const reason = status === "unavailable"
          ? cleanText(capability.reason) || CONNECTOR_UNAVAILABLE_REASON_MISSING
          : "";

        return {
          id: cleanText(capability.id) || label,
          label,
          source: cleanText(capability.source) || "source not reported",
          status,
          reason,
        };
      })
      .filter(Boolean)
    : [];

  if (!items.length) {
    return {
      status: "unavailable",
      message: CONNECTOR_COVERAGE_UNAVAILABLE_MESSAGE,
      items: [],
    };
  }

  return {
    status: "ready",
    message: "",
    items,
  };
}
