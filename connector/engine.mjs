export const CHECK_SCHEMA_VERSION = 1;

function finding(id, label, status, plain, technical, evidence, duration) {
  return { id, label, status, plain, technical, evidence, duration };
}

export function correlateChecks(snapshot) {
  const {
    localAdapter,
    pfsensePing,
    pfsenseGui,
    internetTcp,
    systemDns,
    externalDns,
    target,
  } = snapshot;

  const findings = [
    finding(
      "local-adapter",
      "Computer network",
      localAdapter.ok ? "pass" : "fail",
      localAdapter.ok
        ? "This computer has an active local network connection."
        : "This computer does not have an active IPv4 network connection.",
      localAdapter.ok
        ? `${localAdapter.interfaceName} active · ${localAdapter.address}`
        : "No non-loopback IPv4 adapter detected",
      localAdapter.ok
        ? `interface ${localAdapter.interfaceName} · IPv4 ${localAdapter.address}`
        : "Windows did not report a usable local IPv4 address",
      localAdapter.duration,
    ),
    finding(
      "pfsense",
      "pfSense gateway",
      pfsensePing.ok || pfsenseGui.ok ? "pass" : "fail",
      pfsensePing.ok || pfsenseGui.ok
        ? "Your computer can reach the pfSense firewall."
        : "Your computer cannot reach the pfSense firewall.",
      `ICMP ${pfsensePing.ok ? "passed" : "failed"} · HTTPS ${pfsenseGui.ok ? `responded ${pfsenseGui.statusCode}` : "unreachable"}`,
      `target ${target.host} · ping ${pfsensePing.detail} · GUI ${pfsenseGui.detail}`,
      `${Math.max(pfsensePing.elapsedMs, pfsenseGui.elapsedMs)} ms`,
    ),
    finding(
      "internet",
      "Internet path",
      internetTcp.ok ? "pass" : "fail",
      internetTcp.ok
        ? "Traffic can reach the public internet without using DNS."
        : "Traffic cannot currently reach the public internet by IP.",
      internetTcp.ok
        ? `${internetTcp.target} TCP connection passed`
        : `${internetTcp.target} TCP connection failed`,
      internetTcp.detail,
      `${internetTcp.elapsedMs} ms`,
    ),
    finding(
      "system-dns",
      "Configured DNS",
      systemDns.ok ? "pass" : "fail",
      systemDns.ok
        ? "The DNS service configured on this computer is resolving names."
        : "The DNS service configured on this computer is not resolving names.",
      systemDns.ok
        ? `${systemDns.hostname} → ${systemDns.addresses.join(", ")}`
        : `${systemDns.hostname} lookup failed`,
      systemDns.detail,
      `${systemDns.elapsedMs} ms`,
    ),
    finding(
      "external-dns",
      "External DNS control",
      externalDns.ok ? "pass" : "warn",
      externalDns.ok
        ? "A public DNS resolver answers directly."
        : "The public DNS control test also failed.",
      externalDns.ok
        ? `${externalDns.server} resolved ${externalDns.hostname}`
        : `${externalDns.server} query failed`,
      externalDns.detail,
      `${externalDns.elapsedMs} ms`,
    ),
  ];

  if (!localAdapter.ok) {
    return {
      schemaVersion: CHECK_SCHEMA_VERSION,
      ruleId: "local-computer-network-unavailable",
      verdict: "Computer disconnected from the local network",
      summary: "This computer has no usable local IPv4 connection, so Network Warden cannot reach pfSense yet.",
      severity: "critical",
      confidence: 99,
      action: "Reconnect Wi-Fi or Ethernet on this computer, then run Warden Check again.",
      findings,
    };
  }

  if (!pfsensePing.ok && !pfsenseGui.ok) {
    return {
      schemaVersion: CHECK_SCHEMA_VERSION,
      ruleId: "pfsense-gateway-unreachable",
      verdict: "Local gateway unavailable",
      summary: `This computer is connected locally but cannot reach pfSense at ${target.host}.`,
      severity: "critical",
      confidence: 97,
      action: "Check the connection to the firewall and confirm the pfSense address in Network Warden settings.",
      findings,
    };
  }

  if (internetTcp.ok && !systemDns.ok && externalDns.ok) {
    return {
      schemaVersion: CHECK_SCHEMA_VERSION,
      ruleId: "configured-dns-resolver-failure",
      verdict: "Browsing failure — configured DNS resolver",
      summary: "The internet path works and public DNS answers, but this computer's configured DNS service is not resolving names.",
      severity: "critical",
      confidence: 98,
      action: "Inspect the pfSense DNS Resolver. A restart can be offered only after an authenticated, approval-gated connection is configured.",
      findings,
    };
  }

  if (!internetTcp.ok) {
    return {
      schemaVersion: CHECK_SCHEMA_VERSION,
      ruleId: "upstream-internet-path-unavailable",
      verdict: "Internet path unavailable beyond pfSense",
      summary: "The local firewall is reachable, but direct public-Internet connectivity failed.",
      severity: "critical",
      confidence: 93,
      action: "Inspect the pfSense WAN address, default route, and gateway monitor. Network Warden has not changed anything.",
      findings,
    };
  }

  if (!systemDns.ok) {
    return {
      schemaVersion: CHECK_SCHEMA_VERSION,
      ruleId: "dns-resolution-unavailable",
      verdict: "Internet online — DNS resolution unavailable",
      summary: "The public internet is reachable by IP, but name resolution failed through both configured and control resolvers.",
      severity: "degraded",
      confidence: 91,
      action: "Check DNS service health and firewall rules affecting UDP/TCP port 53.",
      findings,
    };
  }

  return {
    schemaVersion: CHECK_SCHEMA_VERSION,
    ruleId: "local-core-paths-healthy",
    verdict: "Network healthy",
    summary: "This computer can reach pfSense, the public internet, and DNS normally.",
    severity: "healthy",
    confidence: 99,
    action: "No action needed. Deeper authenticated pfSense collection is the next connector stage.",
    findings,
  };
}
