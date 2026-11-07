export const PFSENSE_PROBE_ADAPTER_ID = "pfsense-external-probe";

const availableCapabilities = [
  { id: "local-adapter", label: "Computer network", source: "windows" },
  { id: "pfsense-reachability", label: "pfSense reachability", source: "windows" },
  { id: "internet-by-ip", label: "Internet path", source: "windows" },
  { id: "configured-dns", label: "Configured DNS", source: "windows" },
  { id: "external-dns-control", label: "External DNS control", source: "windows" },
];

const authenticatedCapabilities = [
  {
    id: "pfsense-wan-interface",
    label: "WAN interface status",
    source: "pfsense",
  },
  {
    id: "pfsense-gateways",
    label: "WAN gateway status",
    source: "pfsense",
  },
  {
    id: "pfsense-system-load",
    label: "CPU load",
    source: "pfsense",
  },
];

const restrictedCapabilities = [
  {
    id: "pfsense-core-services",
    label: "Core services",
    source: "pfsense",
    reason: "Intentionally unavailable because the restricted account has no service-control page access.",
  },
];

const disconnectedCapabilities = authenticatedCapabilities.map((capability) => ({
  ...capability,
  reason: "Connect the restricted pfSense account for this session.",
}));

function withStatus(capability, status) {
  return { ...capability, status };
}

function authenticatedFinding(capability, telemetry) {
  if (capability.id === "pfsense-wan-interface") {
    const wan = telemetry?.interfaces?.wan;
    if (!wan) {
      return {
        id: capability.id,
        label: capability.label,
        status: "unavailable",
        plain: "The interface page was readable, but its WAN fields could not be interpreted yet.",
        technical: "authenticated page read · WAN parser returned no interface",
        evidence: "No firewall setting or action was attempted.",
        duration: "read only",
      };
    }
    const statusText = [wan.status, wan.dhcpStatus].filter(Boolean).join(" · ");
    const isDown = /down|offline|no carrier|stopped/i.test(statusText);
    const hasAddress = Boolean(wan.ipv4Address && !/0\.0\.0\.0|none|n\/a/i.test(wan.ipv4Address));
    return {
      id: capability.id,
      label: capability.label,
      status: isDown || !hasAddress ? "fail" : "pass",
      plain: isDown || !hasAddress
        ? "pfSense does not report a healthy WAN link and IPv4 address."
        : "pfSense reports an active WAN link with an IPv4 address.",
      technical: `status ${statusText || "not labeled"} · IPv4 ${wan.ipv4Address ?? "unavailable"}`,
      evidence: `gateway ${wan.ipv4Gateway ?? "unavailable"} · media ${wan.media ?? "unavailable"}`,
      duration: "read only",
    };
  }

  if (capability.id === "pfsense-gateways") {
    const gateways = telemetry?.gateways ?? [];
    if (!gateways.length) {
      return {
        id: capability.id,
        label: capability.label,
        status: "unavailable",
        plain: "The gateway page was readable, but no gateway row could be interpreted yet.",
        technical: "authenticated page read · gateway parser returned no rows",
        evidence: "No gateway control was requested.",
        duration: "read only",
      };
    }
    const failing = gateways.filter((gateway) => /down|offline|loss|delay|unreachable|pending/i.test(gateway.status));
    return {
      id: capability.id,
      label: capability.label,
      status: failing.length ? "fail" : "pass",
      plain: failing.length
        ? `${failing.length} pfSense gateway monitor${failing.length === 1 ? " is" : "s are"} reporting a problem.`
        : "pfSense gateway monitors are not reporting a failure.",
      technical: gateways.map((gateway) => `${gateway.name} ${gateway.status}`).join(" · "),
      evidence: gateways
        .map((gateway) => [gateway.monitor, gateway.delay, gateway.loss].filter(Boolean).join(" · "))
        .filter(Boolean)
        .join(" | ") || "status table read successfully",
      duration: "read only",
    };
  }

  const cpuLoad = telemetry?.cpuLoadPercent;
  if (!Number.isFinite(cpuLoad)) {
    return {
      id: capability.id,
      label: capability.label,
      status: "unavailable",
      plain: "The CPU-load endpoint did not return a usable percentage.",
      technical: "authenticated page read · CPU percentage unavailable",
      evidence: "No system command or configuration request was sent.",
      duration: "read only",
    };
  }
  return {
    id: capability.id,
    label: capability.label,
    status: cpuLoad >= 95 ? "fail" : cpuLoad >= 80 ? "warn" : "pass",
    plain: cpuLoad >= 95
      ? "pfSense processor load is critically high."
      : cpuLoad >= 80
        ? "pfSense processor load is elevated."
        : "pfSense processor load is within a normal range.",
    technical: `CPU load ${cpuLoad}%`,
    evidence: "status_cpuload.php · authenticated GET",
    duration: "read only",
  };
}

export function describePfSenseProbeAdapter(target, authenticated = false) {
  const firewallCapabilities = authenticated
    ? authenticatedCapabilities.map((capability) => withStatus(capability, "available"))
    : disconnectedCapabilities.map((capability) => withStatus(capability, "unavailable"));
  const capabilityCoverage = [
    ...availableCapabilities.map((capability) => withStatus(capability, "available")),
    ...firewallCapabilities,
    ...restrictedCapabilities.map((capability) => withStatus(capability, "unavailable")),
  ];

  return {
    id: PFSENSE_PROBE_ADAPTER_ID,
    platform: "pfsense",
    displayName: authenticated ? "pfSense authenticated telemetry" : "pfSense external probe",
    mode: "read-only",
    authentication: authenticated ? "session-only" : "not-connected",
    target: {
      host: target.host,
      protocol: target.protocol,
      port: target.port,
    },
    capabilities: capabilityCoverage
      .filter((capability) => capability.status === "available")
      .map(({ id }) => id),
    capabilityCoverage,
  };
}

export function pfsenseTelemetryFindings(adapter, telemetry = null) {
  return adapter.capabilityCoverage
    .filter((capability) => capability.source === "pfsense")
    .map((capability) => {
      if (capability.status === "available") return authenticatedFinding(capability, telemetry);
      return {
        id: capability.id,
        label: capability.label,
        status: "unavailable",
        plain: capability.id === "pfsense-core-services"
          ? "Service controls are intentionally outside this account's access."
          : "Connect the restricted pfSense account to check this.",
        technical: `${capability.id} · ${capability.status}`,
        evidence: capability.reason,
        duration: "not run",
      };
    });
}
