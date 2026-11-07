"use client";

import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/oxanium/500.css";
import "@fontsource/oxanium/600.css";

import { FormEvent, useEffect, useRef, useState } from "react";

import { getConnectorCoverageDisplay } from "./connector-capability-display.js";

type Mode = "warden" | "nerd";
type TextSize = "standard" | "large" | "extra-large";
type Platform = "pfsense";
type ManagementProtocol = "http" | "https";
type Scenario = "healthy" | "dns" | "gateway" | "wan-recovery";
type FindingStatus = "pass" | "warn" | "fail" | "unavailable";
type ConnectorState = "checking" | "live" | "demo";

type Finding = {
  id: string;
  label: string;
  status: FindingStatus;
  plain: string;
  technical: string;
  evidence: string;
  duration: string;
};

type ScenarioResult = {
  ruleId: string;
  verdict: string;
  summary: string;
  severity: "healthy" | "degraded" | "critical";
  confidence: number;
  action: string;
  findings: Finding[];
  timeline?: {
    time: string;
    event: string;
    detail: string;
    tone: "fail" | "warn" | "pass";
  }[];
};

type ConnectorStatus = {
  status: "ready";
  mode: "read-only";
  version: string;
  target: {
    host: string;
    protocol: ManagementProtocol;
    port: number;
  };
  adapter: {
    id: string;
    platform: string;
    displayName: string;
    authentication: string;
  };
  capabilities: string[];
  capabilityCoverage: {
    id: string;
    label: string;
    source: string;
    status: "available" | "unavailable";
    reason?: string;
  }[];
  pfsenseConnection: {
    status: "connected" | "disconnected";
    connectedAt: string | null;
    credentialStorage: "memory-only" | "none";
  };
};

type PfSenseCertificate = {
  fingerprint256: string;
  subject: string;
  issuer: string;
  validFrom: string | null;
  validTo: string | null;
};

type BandwidthDirectionResult = {
  status: "complete" | "failed";
  mbps?: number;
  bytesTransferred: number;
  durationMs: number;
  reason?: string;
};

type BandwidthMeasurement = {
  measuredBy: "local-connector";
  source: string;
  measuredAt: string;
  timeoutMs: number;
  download: BandwidthDirectionResult;
  upload: BandwidthDirectionResult;
};

const CONNECTOR_URL = "http://127.0.0.1:7332";
const navigation = ["Overview", "Traffic", "Topology", "Security", "System", "Settings", "Alerts"];

function formatBandwidthSample(result: BandwidthDirectionResult | null) {
  if (!result || result.status !== "complete") return "";
  const megabytes = (result.bytesTransferred / 1_000_000).toFixed(1);
  const seconds = (result.durationMs / 1000).toFixed(1);
  return `${megabytes} MB over ${seconds} s`;
}

const scenarioResults: Record<Scenario, ScenarioResult> = {
  healthy: {
    ruleId: "all-core-paths-healthy",
    verdict: "Network healthy",
    summary: "Your internet path, local services, and firewall are operating normally.",
    severity: "healthy",
    confidence: 99,
    action: "No action needed. Run a Direct WAN Test if you want a fresh performance baseline.",
    findings: [
      { id: "wan", label: "WAN link", status: "pass", plain: "Internet cable and WAN lease are active.", technical: "re0 carrier active · DHCP lease valid · 1 Gbps full duplex", evidence: "public lease · MTU 1500 · 0 input errors", duration: "42 ms" },
      { id: "gateway", label: "Gateway", status: "pass", plain: "Your connection reaches the ISP normally.", technical: "203.0.113.1 reachable · 12 ms RTT · 0.1% loss", evidence: "20 ICMP probes · jitter 1.8 ms", duration: "1.2 s" },
      { id: "dns", label: "DNS resolver", status: "pass", plain: "Website names are resolving quickly.", technical: "Unbound active · local and recursive queries passed", evidence: "A/AAAA queries · 18 ms p50 · 31 ms p95", duration: "188 ms" },
      { id: "services", label: "Core services", status: "pass", plain: "Essential firewall services are running.", technical: "unbound, dhcpd, filterlog and dpinger active", evidence: "4/4 required services healthy", duration: "71 ms" },
      { id: "resources", label: "System load", status: "pass", plain: "pfSense has plenty of available capacity.", technical: "CPU 18% · memory 36% · state table 8%", evidence: "temperature 47°C · disk 21%", duration: "35 ms" },
    ],
  },
  dns: {
    ruleId: "local-dns-resolver-failure",
    verdict: "Browsing failure — local DNS resolver",
    summary: "Your internet connection works, but pfSense is not translating website names into IP addresses.",
    severity: "critical",
    confidence: 98,
    action: "Restart the DNS Resolver. Network Warden will require your approval before performing this repair.",
    findings: [
      { id: "wan", label: "WAN link", status: "pass", plain: "The WAN connection is active.", technical: "re0 carrier active · DHCP lease valid · 1 Gbps full duplex", evidence: "public lease · 0 input errors", duration: "39 ms" },
      { id: "gateway", label: "Gateway", status: "pass", plain: "Your ISP path is reachable.", technical: "203.0.113.1 reachable · 13 ms RTT · 0% loss", evidence: "20/20 ICMP probes returned", duration: "1.2 s" },
      { id: "ip", label: "Internet by IP", status: "pass", plain: "Traffic can reach the internet without using DNS.", technical: "1.1.1.1 and 9.9.9.9 probes passed", evidence: "TLS endpoint reachable by IP", duration: "244 ms" },
      { id: "dns", label: "DNS resolver", status: "fail", plain: "The local DNS service is not answering.", technical: "Unbound query timeout · external resolver query passed", evidence: "3 local timeouts at 2,000 ms · service state stopped", duration: "6.1 s" },
      { id: "resources", label: "System load", status: "pass", plain: "The firewall is not overloaded.", technical: "CPU 16% · memory 35% · state table 7%", evidence: "no resource pressure detected", duration: "33 ms" },
    ],
  },
  gateway: {
    ruleId: "upstream-packet-loss",
    verdict: "Internet degraded — upstream packet loss",
    summary: "Your local network and DNS service are healthy, but traffic is being lost between pfSense and the ISP gateway.",
    severity: "degraded",
    confidence: 94,
    action: "Check the modem and WAN cable, then retest. If loss continues, contact the ISP with this evidence.",
    findings: [
      { id: "wan", label: "WAN link", status: "pass", plain: "The WAN cable is connected and negotiated correctly.", technical: "re0 carrier active · 1 Gbps full duplex", evidence: "0 link flaps · 0 interface errors", duration: "41 ms" },
      { id: "gateway", label: "Gateway", status: "fail", plain: "The ISP gateway is dropping a significant amount of traffic.", technical: "203.0.113.1 · 146 ms RTT · 18% packet loss", evidence: "82/100 probes returned · jitter 48 ms", duration: "5.4 s" },
      { id: "dns", label: "DNS resolver", status: "warn", plain: "DNS works, but replies are delayed by the unstable connection.", technical: "Unbound active · 684 ms p95 response", evidence: "local cache 9 ms · uncached lookup 684 ms", duration: "2.1 s" },
      { id: "lan", label: "Local network", status: "pass", plain: "Devices inside your home network are communicating normally.", technical: "LAN RTT 0.8 ms · 0% loss · no switch errors", evidence: "gateway LAN and peer probes passed", duration: "532 ms" },
      { id: "resources", label: "System load", status: "pass", plain: "The firewall is not causing the slowdown.", technical: "CPU 19% · memory 37% · state table 9%", evidence: "no resource pressure detected", duration: "34 ms" },
    ],
  },
  "wan-recovery": {
    ruleId: "wan-dhcp-interface-recovery-failure",
    verdict: "Internet offline — pfSense WAN recovery failure likely",
    summary: "pfSense lost its WAN address and route, then failed to recover after the upstream connection returned.",
    severity: "critical",
    confidence: 96,
    action: "Attempt a safe WAN lease and interface restart. If the WAN address does not return, restart pfSense as the last recovery step.",
    findings: [
      {
        id: "wan-address",
        label: "WAN address",
        status: "fail",
        plain: "pfSense no longer has a usable internet address.",
        technical: "re0 carrier state present · IPv4 address absent · ext interface unavailable",
        evidence: '11:11:23–12:13:xx · "Cannot get IP address for ext interface re0. Network is down"',
        duration: "61 min",
      },
      {
        id: "route",
        label: "Default route",
        status: "fail",
        plain: "pfSense cannot find a working path to the ISP.",
        technical: "IPv4/IPv6 dpinger probes failed · sendto errno 65 · 100% loss",
        evidence: '"No route to host" repeated after monitor restarts',
        duration: "61 min",
      },
      {
        id: "dhcp",
        label: "WAN lease recovery",
        status: "fail",
        plain: "The firewall asked for a new WAN address but did not recover it.",
        technical: "DHCPREQUEST + DHCPDISCOVER transmitted · no pre-reboot reply observed",
        evidence: "12:14:28 request/discover · DHCPACK received 12:15:23 only after pfSense reboot",
        duration: "55 s",
      },
      {
        id: "lan",
        label: "Local network",
        status: "pass",
        plain: "The home network stayed reachable, isolating the failure to the WAN side.",
        technical: "LAN management path reachable · pfSense UI accessible · local switching intact",
        evidence: "local control plane remained available during investigation",
        duration: "37 ms",
      },
      {
        id: "resources",
        label: "System pressure",
        status: "pass",
        plain: "Sustained processor overload did not cause the outage.",
        technical: "CPU user max 12.65% · system max 2.77% · interrupt peak 28.22%",
        evidence: "no sustained CPU saturation across the incident window",
        duration: "24 h",
      },
    ],
    timeline: [
      { time: "11:11:23", event: "WAN identity lost", detail: "re0 reported no usable IPv4 address.", tone: "fail" },
      { time: "11:11:24", event: "Routing failed", detail: "Gateway probes reached 100% loss with error 65.", tone: "fail" },
      { time: "11:12–12:13", event: "Recovery loop", detail: "Gateway monitoring restarted repeatedly without restoring the route.", tone: "warn" },
      { time: "12:14:28", event: "DHCP retry failed", detail: "Request and discovery were sent; no reply was recorded.", tone: "fail" },
      { time: "12:15:23", event: "Lease restored", detail: "A DHCP acknowledgment arrived immediately after pfSense rebooted.", tone: "pass" },
    ],
  },
};

export default function Home() {
  const [activeNav, setActiveNav] = useState("Overview");
  const [mode, setMode] = useState<Mode>("warden");
  const [textSize, setTextSize] = useState<TextSize>("large");
  const [scenario, setScenario] = useState<Scenario>("healthy");
  const [result, setResult] = useState<ScenarioResult>(scenarioResults.healthy);
  const [checkStage, setCheckStage] = useState("Last full check 4 minutes ago");
  const [checkProgress, setCheckProgress] = useState(100);
  const [checking, setChecking] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [downloadPlan, setDownloadPlan] = useState(1000);
  const [uploadPlan, setUploadPlan] = useState(40);
  const [downloadPlanInput, setDownloadPlanInput] = useState("1000");
  const [uploadPlanInput, setUploadPlanInput] = useState("40");
  const [showSettings, setShowSettings] = useState(false);
  const [settingsPlatform] = useState<Platform>("pfsense");
  const [settingsHost, setSettingsHost] = useState("192.168.1.1");
  const [settingsProtocol, setSettingsProtocol] = useState<ManagementProtocol>("https");
  const [settingsPort, setSettingsPort] = useState("443");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [testing, setTesting] = useState(false);
  const [bandwidthError, setBandwidthError] = useState("");
  const [bandwidthResult, setBandwidthResult] = useState<BandwidthMeasurement | null>(null);
  const [showRemedy, setShowRemedy] = useState(false);
  const [remedyStage, setRemedyStage] = useState<"review" | "running" | "complete">("review");
  const [connectorState, setConnectorState] = useState<ConnectorState>("checking");
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus | null>(null);
  const [connectorUrl, setConnectorUrl] = useState(CONNECTOR_URL);
  const [showPfSenseSetup, setShowPfSenseSetup] = useState(false);
  const [pfsenseCertificate, setPfSenseCertificate] = useState<PfSenseCertificate | null>(null);
  const [pfsenseUsername, setPfSenseUsername] = useState("networkwarden");
  const [pfsensePassword, setPfSensePassword] = useState("");
  const [pfsenseTrust, setPfSenseTrust] = useState(false);
  const [pfsenseHttpAcknowledged, setPfSenseHttpAcknowledged] = useState(false);
  const [pfsenseSetupStage, setPfSenseSetupStage] = useState<"idle" | "certificate" | "connecting">("idle");
  const [pfsenseSetupError, setPfSenseSetupError] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const setupTimer = window.setTimeout(() => {
      const storedTextSize = window.localStorage.getItem("network-warden-text-size");
      if (storedTextSize === "standard" || storedTextSize === "large" || storedTextSize === "extra-large") {
        setTextSize(storedTextSize);
      }
      const stored = window.localStorage.getItem("network-warden-plan");
      const storedSettings = window.localStorage.getItem("network-warden-settings");
      if (storedSettings) {
        try {
          const settings = JSON.parse(storedSettings) as {
            host?: string;
            protocol?: ManagementProtocol;
            port?: number;
            httpsPort?: number;
          };
          if (settings.host) setSettingsHost(settings.host);
          const storedPort = settings.port ?? settings.httpsPort;
          const storedProtocol = settings.protocol ??
            (storedPort === 80 ? "http" : "https");
          setSettingsProtocol(storedProtocol);
          if (storedPort) setSettingsPort(String(storedPort));
        } catch {
          window.localStorage.removeItem("network-warden-settings");
        }
      }
      if (stored) {
        try {
          const plan = JSON.parse(stored) as { download: number; upload: number };
          setDownloadPlan(plan.download);
          setUploadPlan(plan.upload);
          setDownloadPlanInput(String(plan.download));
          setUploadPlanInput(String(plan.upload));
        } catch {
          setShowSettings(true);
        }
      } else {
        setShowSettings(true);
      }
    }, 0);
    return () => {
      window.clearTimeout(setupTimer);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let probeTimer: number | null = null;
    const setupTimer = window.setTimeout(() => {
      const localHosts = new Set(["localhost", "127.0.0.1"]);
      if (!localHosts.has(window.location.hostname)) {
        setConnectorState("demo");
        return;
      }

      const requestedPort = Number(new URLSearchParams(window.location.search).get("connectorPort"));
      const localConnectorUrl = Number.isInteger(requestedPort) && requestedPort >= 1024 && requestedPort <= 65535
        ? `http://127.0.0.1:${requestedPort}`
        : CONNECTOR_URL;
      setConnectorUrl(localConnectorUrl);

      const probe = async () => {
        try {
          const response = await fetch(`${localConnectorUrl}/v1/status`, {
            cache: "no-store",
            signal: AbortSignal.timeout(1800),
          });
          if (!response.ok) throw new Error("Connector unavailable");
          const status = await response.json() as ConnectorStatus;
          if (!cancelled) {
            setConnectorStatus(status);
            setConnectorState("live");
            setSettingsHost(status.target.host);
            setSettingsProtocol(status.target.protocol);
            setSettingsPort(String(status.target.port));
          }
        } catch {
          if (!cancelled) {
            setConnectorStatus(null);
            setConnectorState("demo");
          }
        }
      };

      void probe();
      probeTimer = window.setInterval(probe, 30000);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(setupTimer);
      if (probeTimer !== null) window.clearInterval(probeTimer);
    };
  }, []);

  async function runWardenCheck() {
    if (checking) return;
    if (timerRef.current) clearInterval(timerRef.current);
    setChecking(true);
    setShowRemedy(false);
    setRemedyStage("review");
    setExpanded(null);
    setCheckProgress(3);
    setCheckStage(
      connectorState === "live"
        ? "Checking this computer and pfSense reachability"
        : "Inspecting WAN link and lease",
    );
    let progress = 3;
    timerRef.current = setInterval(() => {
      progress += 4;
      setCheckProgress(Math.min(progress, 92));
      if (progress >= 18 && progress < 38) setCheckStage("Probing the public Internet path");
      if (progress >= 38 && progress < 58) setCheckStage("Testing configured and external DNS");
      if (progress >= 58 && progress < 76) {
        setCheckStage(
          connectorState === "live"
            ? connectorStatus?.pfsenseConnection.status === "connected"
              ? "Reading pfSense WAN, gateway and CPU telemetry"
              : "Reviewing available connector capabilities"
            : "Verifying pfSense services",
        );
      }
      if (progress >= 76 && progress < 92) {
        setCheckStage(
          connectorState === "live"
            ? connectorStatus?.pfsenseConnection.status === "connected"
              ? "Correlating authenticated firewall telemetry"
              : "Marking firewall-only telemetry unavailable"
            : "Checking load, interfaces and state table",
        );
      }
      if (progress >= 92) setCheckStage("Correlating evidence");
    }, 90);

    try {
      let nextResult: ScenarioResult;
      if (connectorState === "live") {
        const [response] = await Promise.all([
          fetch(`${connectorUrl}/v1/check`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            cache: "no-store",
            signal: AbortSignal.timeout(12000),
          }),
          new Promise((resolve) => window.setTimeout(resolve, 900)),
        ]);
        if (!response.ok) throw new Error("Local connector check failed");
        nextResult = await response.json() as ScenarioResult;
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 2250));
        nextResult = scenarioResults[scenario];
      }

      setResult(nextResult);
      setCheckStage(`Completed just now · ${nextResult.findings.length} diagnostic groups`);
    } catch {
      setConnectorState("demo");
      setCheckStage("Local connector unavailable · showing demo telemetry");
      setResult(scenarioResults[scenario]);
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      setCheckProgress(100);
      setChecking(false);
    }
  }

  async function runWanTest() {
    if (testing) return;
    if (connectorState !== "live") {
      setBandwidthResult(null);
      setBandwidthError("Bandwidth measurement requires the local connector.");
      return;
    }

    setTesting(true);
    setBandwidthError("");
    setBandwidthResult(null);

    try {
      const response = await fetch(`${connectorUrl}/v1/bandwidth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(40000),
      });
      const payload = await response.json() as BandwidthMeasurement | { error?: string };
      if (!response.ok) {
        throw new Error("error" in payload && payload.error
          ? payload.error
          : "The connector bandwidth measurement could not complete.");
      }
      setBandwidthResult(payload as BandwidthMeasurement);
    } catch (error) {
      setBandwidthError(error instanceof Error ? error.message : "The connector bandwidth measurement could not complete.");
    } finally {
      setTesting(false);
    }
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSettingsSaving(true);
    setSettingsError("");
    const plan = {
      download: Number(downloadPlanInput),
      upload: Number(uploadPlanInput),
    };
    const localSettings = {
      platform: settingsPlatform,
      host: settingsHost.trim(),
      protocol: settingsProtocol,
      port: Number(settingsPort),
    };
    try {
      if (!localSettings.host) throw new Error("Enter the pfSense address used on this network.");
      if (!Number.isInteger(localSettings.port) || localSettings.port < 1 || localSettings.port > 65535) {
        throw new Error("Enter a valid management port from 1 through 65535.");
      }
      if (!plan.download || !plan.upload) {
        throw new Error("Enter both expected bandwidth values.");
      }

      if (connectorState === "live") {
        const response = await fetch(`${connectorUrl}/v1/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(localSettings),
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        const payload = await response.json() as {
          error?: string;
          target?: { host: string; protocol: ManagementProtocol; port: number };
        };
        if (!response.ok || !payload.target) {
          throw new Error(payload.error || "The local connector could not save these settings.");
        }
        await refreshConnectorStatus();
        setCheckStage("Home lab settings saved · pfSense session disconnected for safety");
      }

      setDownloadPlan(plan.download);
      setUploadPlan(plan.upload);
      window.localStorage.setItem("network-warden-plan", JSON.stringify(plan));
      window.localStorage.setItem("network-warden-settings", JSON.stringify(localSettings));
      setShowSettings(false);
      setActiveNav("Overview");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Could not save these settings.");
    } finally {
      setSettingsSaving(false);
    }
  }

  function openSettings() {
    setDownloadPlanInput(String(downloadPlan));
    setUploadPlanInput(String(uploadPlan));
    setSettingsHost(connectorStatus?.target.host ?? settingsHost);
    setSettingsProtocol(connectorStatus?.target.protocol ?? settingsProtocol);
    setSettingsPort(String(connectorStatus?.target.port ?? settingsPort));
    setSettingsError("");
    setActiveNav("Settings");
    setShowSettings(true);
  }

  function changeSettingsProtocol(protocol: ManagementProtocol) {
    setSettingsProtocol(protocol);
    setSettingsPort((currentPort) => {
      if (protocol === "http" && currentPort === "443") return "80";
      if (protocol === "https" && currentPort === "80") return "443";
      return currentPort;
    });
  }

  function askWarden(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = query.trim().toLowerCase();
    if (!prompt) return;
    if (prompt.includes("down") || prompt.includes("offline") || prompt.includes("dhcp") || prompt.includes("route") || prompt.includes("reboot")) {
      setScenario("wan-recovery");
      setResult(scenarioResults["wan-recovery"]);
    } else if (prompt.includes("dns")) {
      setScenario("dns");
      setResult(scenarioResults.dns);
    } else if (prompt.includes("loss") || prompt.includes("slow") || prompt.includes("gateway")) {
      setScenario("gateway");
      setResult(scenarioResults.gateway);
    } else {
      setScenario("healthy");
      setResult(scenarioResults.healthy);
    }
    setQuery("");
  }

  function simulateRemedy() {
    if (remedyStage !== "review") return;
    setRemedyStage("running");
    window.setTimeout(() => setRemedyStage("complete"), 1400);
  }

  function changeTextSize(nextSize: TextSize) {
    setTextSize(nextSize);
    window.localStorage.setItem("network-warden-text-size", nextSize);
  }

  async function refreshConnectorStatus() {
    const response = await fetch(`${connectorUrl}/v1/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("The local connector is unavailable.");
    const status = await response.json() as ConnectorStatus;
    setConnectorStatus(status);
    setConnectorState("live");
    return status;
  }

  async function openPfSenseConnection() {
    const protocol = connectorStatus?.target.protocol ?? settingsProtocol;
    setShowPfSenseSetup(true);
    setPfSensePassword("");
    setPfSenseTrust(false);
    setPfSenseHttpAcknowledged(false);
    setPfSenseSetupError("");
    setPfSenseCertificate(null);
    if (protocol === "http") {
      setPfSenseSetupStage("idle");
      return;
    }
    setPfSenseSetupStage("certificate");
    try {
      const response = await fetch(`${connectorUrl}/v1/pfsense/certificate`, {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      const payload = await response.json() as {
        certificate?: PfSenseCertificate;
        error?: string;
      };
      if (!response.ok || !payload.certificate) {
        throw new Error(payload.error || "Could not inspect the pfSense certificate.");
      }
      setPfSenseCertificate(payload.certificate);
      setPfSenseSetupStage("idle");
    } catch (error) {
      setPfSenseSetupStage("idle");
      setPfSenseSetupError(error instanceof Error ? error.message : "Could not inspect the pfSense certificate.");
    }
  }

  function closePfSenseConnection() {
    setShowPfSenseSetup(false);
    setPfSensePassword("");
    setPfSenseTrust(false);
    setPfSenseHttpAcknowledged(false);
    setPfSenseSetupError("");
  }

  async function connectPfSense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const protocol = connectorStatus?.target.protocol ?? settingsProtocol;
    const transportConfirmed = protocol === "https"
      ? Boolean(pfsenseCertificate && pfsenseTrust)
      : pfsenseHttpAcknowledged;
    if (!transportConfirmed || pfsenseSetupStage === "connecting") return;
    setPfSenseSetupStage("connecting");
    setPfSenseSetupError("");
    try {
      const response = await fetch(`${connectorUrl}/v1/pfsense/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: pfsenseUsername,
          password: pfsensePassword,
          fingerprint256: pfsenseCertificate?.fingerprint256,
          insecureTransportAcknowledged: protocol === "http" && pfsenseHttpAcknowledged,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "pfSense sign-in failed.");
      setPfSensePassword("");
      await refreshConnectorStatus();
      setShowPfSenseSetup(false);
      setCheckStage("pfSense connected · run Warden Check for live firewall telemetry");
    } catch (error) {
      setPfSenseSetupError(error instanceof Error ? error.message : "pfSense sign-in failed.");
    } finally {
      setPfSenseSetupStage("idle");
    }
  }

  async function disconnectPfSense() {
    try {
      await fetch(`${connectorUrl}/v1/pfsense/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      });
      await refreshConnectorStatus();
      setCheckStage("pfSense session disconnected · external checks remain available");
    } catch {
      setCheckStage("Could not disconnect cleanly · stop Network Warden to clear the session");
    }
  }

  const failedCount = result.findings.filter((finding) => finding.status === "fail").length;
  const warningCount = result.findings.filter((finding) => finding.status === "warn").length;
  const unavailableCount = result.findings.filter((finding) => finding.status === "unavailable").length;
  const measuredCount = result.findings.length - unavailableCount;
  const pfsenseProtocol = connectorStatus?.target.protocol ?? settingsProtocol;
  const connectorCoverageDisplay = getConnectorCoverageDisplay(connectorStatus?.capabilityCoverage);
  const visibleBandwidthResult = connectorState === "live" ? bandwidthResult : null;
  const downloadResult = visibleBandwidthResult?.download ?? null;
  const uploadResult = visibleBandwidthResult?.upload ?? null;
  const downloadComplete = downloadResult?.status === "complete" && typeof downloadResult.mbps === "number";
  const uploadComplete = uploadResult?.status === "complete" && typeof uploadResult.mbps === "number";
  const downloadFailed = downloadResult?.status === "failed";
  const uploadFailed = uploadResult?.status === "failed";
  const downloadSpeed = downloadComplete ? Math.round(downloadResult?.mbps ?? 0) : null;
  const uploadSpeed = uploadComplete ? Math.round(uploadResult?.mbps ?? 0) : null;
  const downloadPercent = downloadComplete && downloadPlan ? Math.round(((downloadResult?.mbps ?? 0) / downloadPlan) * 100) : null;
  const uploadPercent = uploadComplete && uploadPlan ? Math.round(((uploadResult?.mbps ?? 0) / uploadPlan) * 100) : null;
  const bandwidthQuality = downloadComplete && uploadComplete
    ? Math.min(downloadPercent ?? 0, uploadPercent ?? 0) >= 80
      ? "Within baseline"
      : Math.min(downloadPercent ?? 0, uploadPercent ?? 0) >= 50
        ? "Below baseline"
        : "Far below plan"
    : null;
  const bandwidthUnavailableMessage = connectorState === "live" ? "Not measured" : "Requires local connector";

  return (
    <main className="warden-shell" data-text-size={textSize}>
      <div className="ambient-grid" aria-hidden="true" />
      <div className="neural-field neural-field-one" aria-hidden="true" />
      <div className="neural-field neural-field-two" aria-hidden="true" />

      <aside className="side-rail" aria-label="Primary navigation">
        <div className="warden-mark" aria-label="Network Warden">
          <span className="mark-shield">
            <span className="mark-node mark-node-a" />
            <span className="mark-node mark-node-b" />
            <span className="mark-node mark-node-c" />
            <span className="mark-line mark-line-a" />
            <span className="mark-line mark-line-b" />
          </span>
        </div>
        <nav className="rail-nav">
          {navigation.map((item, index) => (
            <button
              className={`nav-item ${activeNav === item ? "active" : ""}`}
              key={item}
              onClick={() => item === "Settings" ? openSettings() : setActiveNav(item)}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">{["⌂", "⌁", "⎔", "◇", "▣", "⚙", "△"][index]}</span>
              <span>{item}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="command-deck">
        <header className="topbar">
          <div>
            <div className="eyebrow">Local command interface</div>
            <h1>Network Warden</h1>
            <div className="system-status">
              <span className={`status-orb ${connectorState === "checking" ? "status-checking" : ""}`} />
              {connectorState === "live" ? "Local connector online" : connectorState === "checking" ? "Locating connector" : "Interactive demo"}
            </div>
          </div>
          <div className="topbar-controls">
            <div className="display-controls">
              <div className="mode-switch" role="group" aria-label="Display mode">
                <button className={mode === "warden" ? "active" : ""} onClick={() => setMode("warden")} type="button">Warden Mode</button>
                <button className={mode === "nerd" ? "active nerd" : ""} onClick={() => setMode("nerd")} type="button">NERD Mode</button>
              </div>
              <label className="text-size-picker">
                <span>Text size</span>
                <select
                  aria-label="Dashboard text size"
                  value={textSize}
                  onChange={(event) => changeTextSize(event.target.value as TextSize)}
                >
                  <option value="standard">Standard</option>
                  <option value="large">Large</option>
                  <option value="extra-large">Extra large</option>
                </select>
              </label>
            </div>
            <div className="device-strip">
              <span className={connectorState === "live" ? "live-chip" : "demo-chip"}>
                {connectorState === "live" ? "Live read-only data" : "Demo telemetry"}
              </span>
              <span>{connectorState === "live" ? `Connector ${connectorStatus?.version ?? "0.1"}` : "pfSense CE 2.8.1"}</span>
              <i />
              <span>{connectorStatus?.target.host ?? "Local pfSense"}</span>
            </div>
          </div>
        </header>

        <section className={`connector-ribbon connector-${connectorState}`} aria-live="polite">
          <span className="connector-pulse" aria-hidden="true" />
          <div>
            <strong>
              {connectorState === "live"
                ? "Windows connector active"
                : connectorState === "checking"
                  ? "Checking for the Windows connector"
                  : "Safe hosted demonstration"}
            </strong>
            <div className="connector-ribbon-copy">
              {connectorState === "live"
                ? (
                  <>
                    {connectorCoverageDisplay.items.length > 0 ? (
                      <>
                        <span className="connector-coverage-intro">Live connector checks:</span>
                        <ul className="connector-check-list" aria-label="Live connector checks">
                          {connectorCoverageDisplay.items.map((item) => (
                            <li
                              className={`connector-check connector-check-${item.status}`}
                              key={item.id}
                              title={item.status === "unavailable" ? `${item.label}: ${item.reason}` : item.label}
                            >
                              <span className="connector-check-name">{item.label}</span>
                              <span className="connector-check-source">Source: {item.source}</span>
                              {item.status === "unavailable" && (
                                <span className="connector-check-reason">Unavailable: {item.reason}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <span className="connector-coverage-fallback">{connectorCoverageDisplay.message}</span>
                    )}
                    {connectorStatus?.pfsenseConnection.status !== "connected" && (
                      <span className="connector-pfsense-cta">Connect the restricted pfSense account to add firewall telemetry.</span>
                    )}
                  </>
                )
                : connectorState === "checking"
                  ? "The dashboard is looking for the local read-only helper."
                  : "This hosted dashboard cannot access pfSense or anything inside your home network."}
            </div>
          </div>
          <div className="connector-ribbon-actions">
            <code>
              {connectorState === "live"
                ? connectorStatus?.pfsenseConnection.status === "connected"
                  ? "PFSENSE SESSION · READ ONLY"
                  : "127.0.0.1:7332 · READ ONLY"
                : "SIMULATED · NO HOME ACCESS"}
            </code>
            {connectorState === "live" && connectorStatus?.pfsenseConnection.status !== "connected" && (
              <button type="button" onClick={openPfSenseConnection}>Connect pfSense</button>
            )}
            {connectorState === "live" && connectorStatus?.pfsenseConnection.status === "connected" && (
              <button className="disconnect" type="button" onClick={disconnectPfSense}>Disconnect</button>
            )}
          </div>
        </section>

        <section className={`check-command sci-panel severity-${result.severity}`}>
          <div className="check-summary">
            <span className="section-index">01 / Warden Check</span>
            <h2>{checking ? "Diagnostic sweep in progress" : result.verdict}</h2>
            <p>{checking ? checkStage : result.summary}</p>
            <div className="verdict-meta">
              <span>{checking ? `${checkProgress}% complete` : `Confidence ${result.confidence}%`}</span>
              <span>{failedCount} critical</span>
              <span>{warningCount} warning</span>
              {unavailableCount > 0 && <span>{unavailableCount} unavailable</span>}
              <span>Read-only</span>
            </div>
          </div>
          <div className={`check-orbit ${checking ? "scanning" : ""}`} aria-hidden="true">
            <div><strong>{checking ? checkProgress : result.confidence}</strong><span>{checking ? "%" : "CONF"}</span></div>
          </div>
          <button className="warden-check-button" type="button" onClick={runWardenCheck} disabled={checking}>
            <span>◉</span>
            {checking ? checkStage : "Run Warden Check"}
          </button>
        </section>

        <div className="dashboard-grid">
          <section className="findings-panel sci-panel">
            <div className="panel-heading">
              <div><span className="section-index">02 / Diagnostic evidence</span><h2>What Network Warden checked</h2></div>
              {mode === "nerd" && connectorState !== "live" && (
                <label className="scenario-control">
                  Simulate
                  <select value={scenario} onChange={(event) => setScenario(event.target.value as Scenario)}>
                    <option value="healthy">Healthy network</option>
                    <option value="dns">DNS resolver failure</option>
                    <option value="gateway">Gateway packet loss</option>
                    <option value="wan-recovery">Real case: WAN recovery failure</option>
                  </select>
                </label>
              )}
            </div>
            <div className="findings-list">
              {result.findings.map((finding) => (
                <button
                  className={`finding-row finding-${finding.status} ${expanded === finding.id ? "expanded" : ""}`}
                  key={finding.id}
                  onClick={() => setExpanded(expanded === finding.id ? null : finding.id)}
                  type="button"
                >
                  <span className="finding-status">
                    {finding.status === "pass" ? "✓" : finding.status === "warn" ? "!" : finding.status === "fail" ? "×" : "—"}
                  </span>
                  <span className="finding-copy">
                    <strong>{finding.label}</strong>
                    <span>{mode === "warden" ? finding.plain : finding.technical}</span>
                    {expanded === finding.id && <small>{mode === "warden" ? "Evidence: " : "RAW // "}{finding.evidence}</small>}
                  </span>
                  {mode === "nerd" && <code>{finding.duration}</code>}
                  <span className="expand-caret">{expanded === finding.id ? "−" : "+"}</span>
                </button>
              ))}
            </div>
            <div className="recommended-action">
              <span className="action-symbol">◇</span>
              <div><span>Recommended next action</span><strong>{result.action}</strong></div>
              {result.severity !== "healthy" && connectorState !== "live" && <button type="button" onClick={() => setShowRemedy(true)}>Review remedy</button>}
              {result.severity !== "healthy" && connectorState === "live" && <span className="read-only-tag">Analysis only</span>}
            </div>
          </section>

          <aside className="performance-panel sci-panel">
            <div className="panel-heading">
              <div>
                <span className="section-index">03 / Performance</span>
                <h2>Internet bandwidth</h2>
              </div>
            </div>
            <div className="bandwidth-gauges">
              <div className={`bandwidth-gauge-wrap ${testing ? "active" : ""}`}>
                <small>Download connector</small>
                <div className={`compact-gauge ${testing ? "testing" : ""} ${downloadComplete ? "" : "unavailable"} ${downloadFailed ? "failed" : ""}`}>
                  <div>
                    <strong>{testing ? "..." : downloadFailed ? "Failed" : downloadSpeed ?? "-"}</strong>
                    {downloadComplete ? <span>Mbps</span> : <span>{downloadFailed ? "Failed" : "Waiting"}</span>}
                  </div>
                </div>
              </div>
              <div className={`bandwidth-gauge-wrap ${testing ? "active" : ""}`}>
                <small>Upload connector</small>
                <div className={`compact-gauge upload-gauge ${testing ? "testing" : ""} ${uploadComplete ? "" : "unavailable"} ${uploadFailed ? "failed" : ""}`}>
                  <div>
                    <strong>{testing ? "..." : uploadFailed ? "Failed" : uploadSpeed ?? "-"}</strong>
                    {uploadComplete ? <span>Mbps</span> : <span>{uploadFailed ? "Failed" : "Waiting"}</span>}
                  </div>
                </div>
              </div>
            </div>
            <div className="performance-readout">
              <span><small>Plan</small><strong>{downloadPlan.toLocaleString()} / {uploadPlan} Mbps</strong></span>
              <span><small>Source</small><strong>{connectorState === "live" ? "Local connector on this PC" : "Local connector unavailable"}</strong></span>
              <span>
                <small>Download connector</small>
                <strong className={downloadFailed ? "warning-text" : ""}>
                  {downloadComplete
                    ? `${downloadPercent}% of plan (${formatBandwidthSample(downloadResult)})`
                    : downloadFailed
                      ? `Failed: ${downloadResult?.reason ?? "Measurement did not complete."}`
                      : bandwidthUnavailableMessage}
                </strong>
              </span>
              <span>
                <small>Upload connector</small>
                <strong className={uploadFailed ? "warning-text" : ""}>
                  {uploadComplete
                    ? `${uploadPercent}% of plan (${formatBandwidthSample(uploadResult)})`
                    : uploadFailed
                      ? `Failed: ${uploadResult?.reason ?? "Measurement did not complete."}`
                      : bandwidthUnavailableMessage}
                </strong>
              </span>
              {bandwidthQuality && (
                <span>
                  <small>Quality connector</small>
                  <strong className={bandwidthQuality === "Within baseline" ? "good" : "warning-text"}>
                    {bandwidthQuality}
                  </strong>
                </span>
              )}
            </div>
            {bandwidthError && <p className="bandwidth-error" role="alert">{bandwidthError}</p>}
            <p className="bandwidth-note">
              {connectorState === "live"
                ? "Measured by the local connector from this PC. The test transfers data and may affect other users briefly."
                : "Bandwidth measurement requires the local connector from this PC."}
            </p>
            <button className="action-button primary" type="button" onClick={runWanTest} disabled={testing || connectorState !== "live"}>
              {testing ? "Measuring connector bandwidth..." : "Run Download + Upload Test"}
            </button>
            <button className="text-button" type="button" onClick={openSettings}>Open Network Warden settings</button>
          </aside>
        </div>

        {mode === "nerd" && (
          <>
            <section className="nerd-console sci-panel">
              <div><span>Rule match</span><code>{result.ruleId}</code></div>
              <div><span>Collector</span><code>{connectorState === "live" ? "pfsense-external-probe / live-readonly" : "pfsense-readonly / simulated"}</code></div>
              <div><span>Execution</span><code>{measuredCount} measured · {unavailableCount} unavailable · deterministic</code></div>
              <div><span>AI status</span><code>optional · not used for this diagnosis</code></div>
            </section>
            {result.timeline && (
              <section className="incident-timeline sci-panel" aria-label="Correlated incident timeline">
                <div className="timeline-heading">
                  <div>
                    <span className="section-index">04 / Correlated evidence</span>
                    <h2>Incident reconstructed automatically</h2>
                  </div>
                  <span className="collapse-note">5 pfSense views → 1 timeline</span>
                </div>
                <ol>
                  {result.timeline.map((item) => (
                    <li className={`timeline-${item.tone}`} key={`${item.time}-${item.event}`}>
                      <time>{item.time}</time>
                      <span className="timeline-node" aria-hidden="true" />
                      <div><strong>{item.event}</strong><span>{item.detail}</span></div>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}

        <form className="warden-command sci-panel" onSubmit={askWarden}>
          <div className="command-orb" aria-hidden="true"><span /></div>
          <label htmlFor="warden-query">Ask the Warden</label>
          <input id="warden-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === "nerd" ? "Correlate gateway loss with DNS latency…" : "Why is my network slow?"} autoComplete="off" />
          <button type="submit"><span>Investigate</span>➤</button>
        </form>
      </section>

      {showSettings && (
        <div className="setup-backdrop" role="presentation">
          <section className="settings-modal sci-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="remedy-heading">
              <div>
                <span className="section-index">Local configuration</span>
                <h2 id="settings-title">Network Warden settings</h2>
              </div>
              <button className="modal-close" type="button" onClick={() => { setShowSettings(false); setActiveNav("Overview"); }} aria-label="Close Network Warden settings">×</button>
            </div>
            <p>Configure this installation for the home lab it protects. These non-secret settings remain on this device and are excluded from GitHub.</p>
            <form onSubmit={saveSettings}>
              <fieldset>
                <legend>Home lab</legend>
                <label>
                  Network platform
                  <select value={settingsPlatform} disabled aria-label="Network platform">
                    <option value="pfsense">pfSense</option>
                  </select>
                  <small>OPNsense, OpenWrt, UniFi and consumer-router adapters can be added later.</small>
                </label>
                <label>
                  Firewall address
                  <input type="text" autoComplete="off" required value={settingsHost} onChange={(event) => setSettingsHost(event.target.value)} placeholder="192.168.1.1 or pfsense.home" />
                  <small>Use the local IP address or hostname for this user&apos;s firewall.</small>
                </label>
                <label>
                  Management protocol
                  <select
                    value={settingsProtocol}
                    onChange={(event) => changeSettingsProtocol(event.target.value as ManagementProtocol)}
                    aria-label="pfSense management protocol"
                  >
                    <option value="https">HTTPS (recommended)</option>
                    <option value="http">HTTP (unencrypted)</option>
                  </select>
                  <small>HTTPS protects the restricted-account password while it crosses the local network.</small>
                </label>
                <label>
                  Management port
                  <input type="text" inputMode="numeric" pattern="[0-9]*" required value={settingsPort} onChange={(event) => setSettingsPort(event.target.value.replace(/\D/g, ""))} />
                  <small>pfSense normally uses 443 for HTTPS or 80 for HTTP.</small>
                </label>
                {settingsProtocol === "http" && (
                  <div className="transport-warning" role="note">
                    <strong>HTTP compatibility mode</strong>
                    <span>The restricted pfSense username, password, and session traffic will not be encrypted. Use this only temporarily on a trusted LAN, then switch pfSense and Network Warden to HTTPS.</span>
                  </div>
                )}
              </fieldset>
              <fieldset>
                <legend>Internet plan</legend>
                <label>Expected download<input type="text" inputMode="numeric" pattern="[0-9]*" required value={downloadPlanInput} onChange={(event) => setDownloadPlanInput(event.target.value.replace(/\D/g, ""))} /><span>Mbps</span></label>
                <label>Expected upload<input type="text" inputMode="numeric" pattern="[0-9]*" required value={uploadPlanInput} onChange={(event) => setUploadPlanInput(event.target.value.replace(/\D/g, ""))} /><span>Mbps</span></label>
              </fieldset>
              <div className="settings-privacy">
                <strong>No credentials are saved here.</strong>
                <span>The restricted pfSense password is requested only when connecting and stays in memory for that session.</span>
              </div>
              {settingsError && <p className="pfsense-setup-error" role="alert">{settingsError}</p>}
              <div className="remedy-actions">
                <button className="text-button" type="button" onClick={() => { setShowSettings(false); setActiveNav("Overview"); }}>Cancel</button>
                <button className="action-button primary" type="submit" disabled={settingsSaving}>
                  {settingsSaving ? "Saving local settings…" : "Save local settings"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {showPfSenseSetup && (
        <div className="setup-backdrop" role="presentation">
          <section className="pfsense-setup-modal sci-panel" role="dialog" aria-modal="true" aria-labelledby="pfsense-setup-title">
            <div className="remedy-heading">
              <div>
                <span className="section-index">Read-only firewall connection</span>
                <h2 id="pfsense-setup-title">Connect the restricted pfSense account</h2>
              </div>
              <button className="modal-close" type="button" onClick={closePfSenseConnection} aria-label="Close pfSense setup">×</button>
            </div>
            <p>
              Network Warden sends telemetry-only page requests to {connectorStatus?.target.host} over {pfsenseProtocol.toUpperCase()}.
              The password is never saved and disappears after sign-in.
            </p>

            {pfsenseProtocol === "https" ? (
              <div className="certificate-card">
                <span>TLS certificate</span>
                {pfsenseSetupStage === "certificate" && <strong>Inspecting the firewall certificate…</strong>}
                {pfsenseCertificate && (
                  <>
                    <strong>{pfsenseCertificate.subject}</strong>
                    <code>{pfsenseCertificate.fingerprint256}</code>
                    <small>Issuer: {pfsenseCertificate.issuer} · Trust on first use for this session only</small>
                  </>
                )}
                {!pfsenseCertificate && pfsenseSetupStage !== "certificate" && (
                  <strong>Certificate unavailable</strong>
                )}
              </div>
            ) : (
              <div className="transport-warning transport-warning-critical" role="alert">
                <strong>Unencrypted pfSense sign-in</strong>
                <span>HTTP exposes this account&apos;s password and session traffic to anyone able to observe the local network. HTTPS is strongly recommended.</span>
              </div>
            )}

            <form onSubmit={connectPfSense}>
              <label>
                Username
                <input
                  type="text"
                  autoComplete="username"
                  value={pfsenseUsername}
                  onChange={(event) => setPfSenseUsername(event.target.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  value={pfsensePassword}
                  onChange={(event) => setPfSensePassword(event.target.value)}
                  required
                />
              </label>
              {pfsenseProtocol === "https" ? (
                <label className="certificate-trust">
                  <input
                    type="checkbox"
                    checked={pfsenseTrust}
                    onChange={(event) => setPfSenseTrust(event.target.checked)}
                    disabled={!pfsenseCertificate}
                  />
                  <span>I recognize this pfSense address and trust this certificate for the current session.</span>
                </label>
              ) : (
                <label className="certificate-trust">
                  <input
                    type="checkbox"
                    checked={pfsenseHttpAcknowledged}
                    onChange={(event) => setPfSenseHttpAcknowledged(event.target.checked)}
                  />
                  <span>I understand this HTTP connection sends the pfSense password without encryption.</span>
                </label>
              )}
              {pfsenseSetupError && <p className="pfsense-setup-error" role="alert">{pfsenseSetupError}</p>}
              <div className="remedy-actions">
                <button className="text-button" type="button" onClick={closePfSenseConnection}>Cancel</button>
                <button
                  className="action-button primary"
                  type="submit"
                  disabled={
                    !pfsensePassword ||
                    pfsenseSetupStage === "connecting" ||
                    (pfsenseProtocol === "https"
                      ? !pfsenseCertificate || !pfsenseTrust
                      : !pfsenseHttpAcknowledged)
                  }
                >
                  {pfsenseSetupStage === "connecting" ? "Connecting read-only session…" : "Connect read-only session"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {showRemedy && (
        <div className="setup-backdrop" role="presentation">
          <section className="remedy-modal sci-panel" role="dialog" aria-modal="true" aria-labelledby="remedy-title">
            <div className="remedy-heading">
              <div>
                <span className="section-index">Safe recovery plan</span>
                <h2 id="remedy-title">{result.verdict}</h2>
              </div>
              <button className="modal-close" type="button" onClick={() => setShowRemedy(false)} aria-label="Close remedy review">×</button>
            </div>
            <p>Network Warden uses the least disruptive recovery steps first and verifies the WAN after every step.</p>
            <ol className="remedy-steps">
              <li><span>01</span><div><strong>Renew the WAN DHCP lease</strong><small>Ask the ISP for a fresh address without restarting the firewall.</small></div></li>
              <li><span>02</span><div><strong>Reinitialize the WAN interface</strong><small>Rebuild the interface and route only if the lease does not return.</small></div></li>
              <li><span>03</span><div><strong>Verify address, route, gateway and DNS</strong><small>Stop immediately when the connection passes all four checks.</small></div></li>
              <li><span>04</span><div><strong>Recommend a pfSense restart</strong><small>Use a full restart only if the safer recovery sequence fails.</small></div></li>
            </ol>
            <div className={`remedy-notice remedy-${remedyStage}`}>
              {remedyStage === "review" && "Demo telemetry only. No command will be sent to your firewall."}
              {remedyStage === "running" && "Simulating lease renewal and verification…"}
              {remedyStage === "complete" && "Simulation complete — WAN address and default route restored at step 01."}
            </div>
            <div className="remedy-actions">
              <button className="text-button" type="button" onClick={() => setShowRemedy(false)}>Close</button>
              <button className="action-button primary" type="button" onClick={simulateRemedy} disabled={remedyStage !== "review"}>
                {remedyStage === "review" ? "Simulate safe recovery" : remedyStage === "running" ? "Running verification…" : "Recovery verified"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
