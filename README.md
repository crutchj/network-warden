# Network Warden

> **Status: proof of concept, paused.** This is an unfinished home-lab project, published as-is
> to show the approach. It runs, its read-only diagnostics work, and its tests pass, but the
> AI troubleshooting layer it was built toward was never finished. Network addresses and other
> personal details have been replaced with documentation values.

## Why it exists

My pfSense firewall kept crashing, and every outage meant digging through logs by hand. The
idea behind Network Warden was simple to say and hard to build: point it at the firewall, ask
what's wrong in plain English, and have it pull every relevant log at once, find the cause,
suggest a fix or a config change, and apply nothing without approval.

The first milestone, in this repo, is the foundation that idea needs: a local-only dashboard and
a strictly read-only connector that can diagnose the common failure points (local link, gateway,
upstream path, DNS) without ever storing the firewall password.

## Why it stopped

The hardware failed first. By the time I could replace it, pfSense's direction had moved
toward its paid edition, while OPNsense offered the same open-source foundation, no
subscription, and a real REST API instead of screen-scraping status pages. So the firewall
moved to OPNsense, and this pfSense-specific build was paused. The diagnostic engine was
designed with separate platform adapters, so an OPNsense port is the logical next step if it
resumes.

Built with AI-assisted development. The build and hosting scaffolding comes from the template
the project started on.

---

Network Warden is a local-first pfSense troubleshooting and network-performance
dashboard. The first version runs on the user's computer and remains read-only
until an individual repair is reviewed and approved.

## Local dashboard

The default dashboard address is:

```text
http://localhost:7331
```

Start the local dashboard with:

```text
npm run start:local
```

The service binds to `127.0.0.1` by default. That means only the same computer
can reach it, even though the friendly browser address is shown as `localhost`.

## Windows read-only connector

The first connector milestone runs local diagnostics without storing or sending
a pfSense password. It can currently check:

- The Windows computer's active IPv4 connection
- pfSense reachability by ping and its configured HTTP or HTTPS management service
- Direct public-Internet reachability without DNS
- DNS through the computer's configured resolver
- A direct external-DNS control query
- Deterministic correlation of common local, gateway, upstream, and DNS failures

The dashboard reports collector coverage explicitly. The restricted pfSense
connection can add WAN interface, gateway-monitor, and CPU-load telemetry.
Core-service status remains intentionally unavailable because the account does
not have access to the operational Services page.

The first pfSense platform adapter is `external-probe`. Keeping the platform
adapter separate from the diagnostic engine allows later adapters for OPNsense,
OpenWrt, UniFi, and consumer-router environments without rewriting the core
rules.

It binds only to `127.0.0.1:7332`, accepts dashboard requests only from the
configured local dashboard address, and exposes no repair endpoint. pfSense
credentials are entered in the local dashboard, sent only over the loopback
connection, and are never written to disk or browser storage. The password is
discarded after sign-in; the pfSense session cookie exists only in connector
memory and is cleared on disconnect or shutdown.

To start the dashboard and connector together on Windows:

```text
npm run start:windows
```

That one command starts both local pieces, waits until they are ready, and opens
`http://localhost:7331` in the default browser.

To create a desktop shortcut during development, run:

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\install-windows-shortcut.ps1"
```

The shortcut starts `scripts\Network Warden.cmd`. A packaged installer and tray
application remain a later milestone; this shortcut still opens a small command
window while Network Warden is running.

## Configure an installation

Open **Settings** in the Network Warden dashboard to configure:

- Network platform (pfSense in the current release)
- Local firewall address, management protocol, and management port
- Expected download and upload bandwidth

The dashboard writes only non-secret home-lab settings to the ignored local
configuration file. A pfSense password is never saved; it is requested only
when starting a read-only session and remains in connector memory until
disconnect or shutdown.

The repository includes a generic example rather than any developer or end-user
network values. Each installation is responsible for entering its own local
details.

### Manual configuration and dashboard port

Copy `config/network-warden.config.example.json` to:

```text
config/network-warden.config.json
```

Then change the `port` value:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 7444
  }
}
```

Restart Network Warden and open the updated address, such as
`http://localhost:7444`.

The same file also holds the read-only connector and pfSense target. Editing it
manually is optional because the dashboard Settings area manages these values:

```json
{
  "connector": {
    "host": "127.0.0.1",
    "port": 7332
  },
  "pfsense": {
    "adapter": "external-probe",
    "host": "192.168.1.1",
    "protocol": "https",
    "port": 443
  }
}
```

Keep the connector host at `127.0.0.1`. The current milestone intentionally
refuses a LAN-facing connector.

Replace the example pfSense host with the address used by the local network.
The real configuration file is intentionally excluded from source control, so
the private gateway address stays only on that machine.

### Temporary overrides

An environment variable can override the configuration file:

```text
NETWORK_WARDEN_PORT=7444
```

The command line has the highest priority:

```text
npm run start:local -- --port 7444
```

Configuration priority is:

1. `--port`
2. `NETWORK_WARDEN_PORT`
3. `config/network-warden.config.json`
4. Default port `7331`

Network Warden accepts ports from `1024` through `65535`. If the selected port
is already being used, choose another and restart the service.

## Security note

Changing the port can reduce casual scan noise, but it does not secure the
dashboard. The important protections are:

- Local-only binding by default
- Authentication before LAN or remote access is enabled
- Firewall rules that restrict the allowed source devices
- TLS when the dashboard is made available beyond the local computer
- No direct exposure to the Internet

Network Warden refuses non-local bind addresses unless network access is
explicitly allowed. Remote management is intentionally outside the first
development phase.

pfSense CE authenticated collection requires a dedicated least-privilege
account with only the required status-page privileges and
`User - Config: Deny Config Write`. The connector uses an allowlist containing
only the login, Interfaces, Gateways, and CPU-load pages. In the recommended
HTTPS mode it pins the TLS certificate selected during setup. HTTP compatibility
mode requires an explicit warning acknowledgment because it sends the password
and session traffic without encryption. The connector keeps the session local and does not include
administrator access, shell access, service controls, configuration pages, or
repair commands.

## Development

- `npm run start:local`: start with Network Warden's configurable local settings
- `npm run connector`: start only the read-only connector
- `npm run start:windows`: start both local pieces and open the dashboard
- `npm run dev`: start the underlying development server
- `npm run lint`: check the source
- `npm run build`: create and validate the production artifact
