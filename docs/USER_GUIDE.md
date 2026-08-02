# pktFlow — User Guide

This guide is for people who use pktFlow to monitor, search, and investigate NetFlow traffic — not for installing or administering the server. See [ADMIN_GUIDE.md](ADMIN_GUIDE.md) for setup, users, backups, and integrations.

## Logging in

Open the app in your browser and log in with your username and password, or "Log in with Okta" if your organization uses SSO. Your role determines what you can do:

| Action | Admin | Analyst | Viewer |
|---|---|---|---|
| View dashboards, search flows, export | ✓ | ✓ | ✓ |
| Manage devices, alert rules | ✓ | — | — |
| Manage Settings / users | ✓ | — | — |

## Navigation

Top-level pages: **Dashboard** (Analytics), **Device View**, **Flow Explorer**, **Topology**, **Geo Map**, **Traffic by Port**, **NAT Translations**, **Alerts**, **Logs**. **Settings** appears only for admins.

## Dashboard / Analytics

Live flows-per-second counter (a green dot means the WebSocket feed is live; it falls back to polling if the connection drops) plus traffic timeseries charts — short-range detail and long-range hourly/daily rollups — and a network-wide source→destination Sankey diagram.

## Device View

Per-sampler (per network device sending flow data) view: traffic history, a top-talkers table, protocol distribution, and a per-device Sankey flow map.

## Flow Explorer

The main search/investigation tool. Filter by IP, port, protocol, and time range. The **Any direction** toggle turns the source/destination IP fields into an either-side match — useful when you don't know or don't care which leg of a conversation you're looking at, or want to see the full two-way conversation between two hosts. Results page server-side with a selectable page size (25/50/75/100). Export the current filtered view as CSV, JSON, or PCAP.

Any public IP shown here (or anywhere else in the app) is clickable — see **Looking up an IP address** below.

## Network Topology

Two layouts, switchable per view:

- **Hierarchical** (default): a fixed three-band diagram per sampler — your private devices grouped into `/24` subnet boxes at top, one generic **L3** node in the middle representing the network boundary itself (not a guessed router), external destinations at bottom. Hovering a device highlights only the peers it actually talks to; hovering L3 lights up everything that sampler has seen. Clicking a device (or a private-to-private link) jumps straight into Flow Explorer, pre-filtered to that traffic for the current time window.
- **Force**: the original free-floating graph with site clustering, if you prefer that view.

Export to PNG, SVG, JSON, DOT, Draw.io, or Lucidchart (if your admin has configured a Lucidchart token under your User Keys).

## Geo Map

A dark-themed world map with traffic arcs, colored by configurable Sites, built from your admin's Private/Public NAT Mapping and Traffic Rules settings. A Site's marker color shows up on the local end of a flow via a NAT Mapping, and on the remote end too if the Site has an IP/CIDR configured that matches the remote address. Every legend section — Line Styles, Sites, and NAT Mappings — only lists entries actually present in the traffic currently on screen (plus, for Sites/NAT Mappings, only ones your admin has checked "show in legend"); it recomputes on every refresh, so an entry with no current traffic simply isn't offered.

**The legend is clickable.** Click any entry — a Line Style, a Site, or a NAT Mapping — to filter the map down to just that item and whatever it connects to (e.g. clicking a Site shows that Site's markers plus every arc touching them, still in their real colors). Click more entries to add them to the filter — everything currently selected shows, in any combination. A **Reset** button appears at the bottom of the legend whenever something's selected; click it (or just wait for the next auto-refresh) to go back to showing everything. The filter always clears on refresh, since a selected item might not even exist in the new data.

If your network's own IP shows up as more than one marker on the map, that's not a bug — a NAT Mapping can be configured to translate the same private range to a different public IP depending on where the traffic is headed (e.g. DNS queries going out one public IP, everything else out another), and each real-world identity gets its own marker.

## Traffic by Port

Protocol mix, top ports by bytes/flows, a traffic-over-time chart, and a full port inventory table.

## NAT Translations

Shows observed original-address → translated-address mappings when your network's exporters send NAT event telemetry (Cisco ASA/ISR NSEL, Juniper SRX, pfSense/OPNsense with NAT logging). If this table is empty, it's most likely because your devices don't export NAT events at all (common on consumer/prosumer gear) — that's expected, not a bug. Ask your admin if you believe NAT data should be showing up but isn't.

## Alerts

Shows every alert fired by the alert engine — silent samplers (data gap), brand-new/unregistered sources, threshold breaches, traffic-rate spikes vs. the 7-day baseline, and specific port/protocol/direction matches. Click **Investigate** on any alert to jump straight into Flow Explorer, pre-filtered to that alert's time window and details. You can acknowledge an alert (marks it as being worked, doesn't close it) if your role allows; alerts otherwise auto-resolve when the underlying condition clears.

## Logs

Search the application's own log history — filter by level and time range (including a custom range). Paginated with a selectable page size.

## Looking up an IP address

Any IP address shown anywhere in the app is a clickable link:

- **Public IPs** (search icon) open a modal combining geolocation/ASN/org data (ipinfo.io, ipapi.is), abuse reputation (AbuseIPDB), and reverse-DNS/blacklist data (MXToolbox) — pulled using **your own** API keys from Settings → User Keys. ipapi.is even works with no key at all via a built-in free-tier toggle. Any ASN shown is itself clickable for ASN-level detail. You can hide sections of the modal you don't care about from the same User Keys tab.
- **Private/internal IPs** (network icon, purple underline) open a different modal that queries a connected pktIPAM instance (if your admin has set one up) for subnet/site, inventory status, DHCP lease, DNS records, and last-seen ARP entry. If no pktIPAM connection exists yet, you'll see a link to the settings page instead of an error.

## Your account

Manage your own password from the user menu. Your personal API keys for IP lookup providers and Lucidchart live under **Settings → User Keys** — these are private to your account, not visible to anyone else including admins.

## Getting help in the app

A small blue **?** button next to almost every page heading and Settings section opens a short explainer for that specific feature, including anything non-obvious about how it behaves.
