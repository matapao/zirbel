"""The box's network, through NetworkManager's D-Bus API: whether it is online, the Wi-Fi networks it sees, joining one,
the open setup hotspot with its firewall and DNS, and the box's own Wi-Fi (own_network.py).

A password goes to NetworkManager over D-Bus, never on a command line another process could read. The hotspot is a
volatile connection NetworkManager never saves. While it runs, nftables sends its clients' port 80 to the setup page,
and lets them reach nothing else on the box or beyond it. The box's own Wi-Fi is saved, a WPA2 access point that comes
back after a reboot; its clients reach the box, and no internet.
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import dbus

from improv import Network

NM = "org.freedesktop.NetworkManager"
NM_PATH = "/org/freedesktop/NetworkManager"
PROPS = "org.freedesktop.DBus.Properties"
DEVICE = NM + ".Device"
WIRELESS = NM + ".Device.Wireless"
ACCESS_POINT = NM + ".AccessPoint"
ACTIVE = NM + ".Connection.Active"
SETTINGS_PATH = NM_PATH + "/Settings"

DEVICE_WIFI = 2
ACTIVATED = 2
DEACTIVATED = 4
AP_PRIVACY = 0x1
KEY_PSK = 0x100
KEY_8021X = 0x200
KEY_SAE = 0x400

HOTSPOT_ID = "zirbel-setup"
HOTSPOT_ADDRESS = "10.42.0.1"
ONLINE_TYPES = ("802-11-wireless", "802-3-ethernet")
# The box's own Wi-Fi, on the hotspot's address: the one radio serves one or the other.
OWN_ID = "zirbel-network"
# Above every network the box joins: after a reboot the box makes its own Wi-Fi first.
OWN_PRIORITY = 100
PMF_DISABLE = 1

# NetworkManager starts a dnsmasq for each shared connection, the hotspot and the box's own Wi-Fi alike, and has it read
# this folder as it starts. The file is there only while the hotspot starts and runs: on the hotspot every name resolves
# to the box, so a phone's captive-portal check opens the setup page, and on the box's own Wi-Fi no name resolves but the
# box's own (zirbel.local, over mDNS), so a phone finds no internet there rather than the editor. No captive-portal
# option (RFC 8910) goes out in DHCP: it names an HTTPS API (RFC 8908) the box doesn't have, and a phone that finds none
# there may close its setup window. A file left by a power cut goes at boot (zirbel-setup.tmpfiles).
DNS_FILE = Path("/etc/NetworkManager/dnsmasq-shared.d/zirbel-setup.conf")
WILDCARD = f"# The Zirbel setup hotspot's, while it runs (pi/setup/network.py).\naddress=/#/{HOTSPOT_ADDRESS}\n"


def _sv(values: dict) -> dbus.Dictionary:
    return dbus.Dictionary(values, signature="sv")


def _shared() -> dbus.Dictionary:
    """IPv4 shared from the box's own address: NetworkManager hands out addresses and answers DNS."""
    return _sv(
        {
            "method": "shared",
            "address-data": dbus.Array([_sv({"address": HOTSPOT_ADDRESS, "prefix": dbus.UInt32(24)})], signature="a{sv}"),
        }
    )


def own_network_settings(name: str, password: str) -> dbus.Dictionary:
    """The box's own Wi-Fi as NetworkManager saves it: an access point on 2.4 GHz for reach, WPA2-Personal with CCMP
    alone and management frame protection off (older phones can't do it), shared from the box's address, and connected
    automatically before any other network."""
    return dbus.Dictionary(
        {
            "connection": _sv(
                {
                    "id": OWN_ID,
                    "type": "802-11-wireless",
                    "autoconnect": True,
                    "autoconnect-priority": dbus.Int32(OWN_PRIORITY),
                }
            ),
            "802-11-wireless": _sv({"ssid": dbus.ByteArray(name.encode("utf-8")), "mode": "ap", "band": "bg"}),
            "802-11-wireless-security": _sv(
                {
                    "key-mgmt": "wpa-psk",
                    "psk": password,
                    "proto": dbus.Array(["rsn"], signature="s"),
                    "pairwise": dbus.Array(["ccmp"], signature="s"),
                    "group": dbus.Array(["ccmp"], signature="s"),
                    "pmf": dbus.Int32(PMF_DISABLE),
                }
            ),
            "ipv4": _shared(),
            "ipv6": _sv({"method": "disabled"}),
        },
        signature="sa{sv}",
    )


def wildcard_dns(on: bool) -> None:
    """Every name resolving to the box, for the setup hotspot alone (DNS_FILE): written before it starts, gone with it."""
    try:
        if on:
            DNS_FILE.write_text(WILDCARD)
        else:
            DNS_FILE.unlink(missing_ok=True)
    except OSError as error:
        print(f"The setup hotspot's DNS could not be {'set' if on else 'taken away'}: {error}", flush=True)


def auth_of(flags: int, wpa: int, rsn: int) -> str:
    """An access point's security as Improv names it: WPA3, WPA2, WPA, WPA2 EAP, WEP or NO, joined by / when several."""
    kinds = []
    if rsn & KEY_8021X or wpa & KEY_8021X:
        return "WPA2 EAP"
    if wpa & KEY_PSK:
        kinds.append("WPA")
    if rsn & KEY_PSK:
        kinds.append("WPA2")
    if rsn & KEY_SAE:
        kinds.append("WPA3")
    if not kinds and flags & AP_PRIVACY:
        kinds.append("WEP")
    return "/".join(kinds) or "NO"


class NetworkManager:
    def __init__(self, bus: dbus.Bus):
        self.bus = bus
        self.nm = dbus.Interface(bus.get_object(NM, NM_PATH), NM)
        self.props = dbus.Interface(bus.get_object(NM, NM_PATH), PROPS)

    @classmethod
    def own(cls) -> "NetworkManager":
        """One with a connection of its own, without a main loop, for a worker thread's blocking calls."""
        import dbus.mainloop

        return cls(dbus.bus.BusConnection(dbus.bus.BUS_SYSTEM, mainloop=dbus.mainloop.NULL_MAIN_LOOP))

    def _get(self, path: str, interface: str, name: str):
        return self.bus.get_object(NM, path).Get(interface, name, dbus_interface=PROPS)

    def wifi_device(self) -> str | None:
        for path in self.nm.GetDevices():
            if int(self._get(path, DEVICE, "DeviceType")) == DEVICE_WIFI:
                return str(path)
        return None

    def interface(self) -> str:
        device = self.wifi_device()
        return str(self._get(device, DEVICE, "Interface")) if device else ""

    def enable_wifi(self) -> None:
        self.props.Set(NM, "WirelessEnabled", dbus.Boolean(True))

    def _activated(self) -> list[tuple[str, str]]:
        """The connections up now: each one's id and type."""
        up = []
        for path in self.props.Get(NM, "ActiveConnections"):
            try:
                if int(self._get(path, ACTIVE, "State")) == ACTIVATED:
                    up.append((str(self._get(path, ACTIVE, "Id")), str(self._get(path, ACTIVE, "Type"))))
            except dbus.DBusException:
                continue  # one that went away meanwhile
        return up

    def online(self) -> bool:
        """Whether the box is on a network: a Wi-Fi or wired connection up, other than its setup hotspot. The box's own
        Wi-Fi counts: the box is on a network of its own."""
        return any(name != HOTSPOT_ID and kind in ONLINE_TYPES for name, kind in self._activated())

    def _connections(self) -> list[tuple[str, dict]]:
        settings = dbus.Interface(self.bus.get_object(NM, SETTINGS_PATH), NM + ".Settings")
        found = []
        for path in settings.ListConnections():
            try:
                connection = dbus.Interface(self.bus.get_object(NM, path), NM + ".Settings.Connection")
                found.append((str(path), connection.GetSettings()))
            except dbus.DBusException:
                continue  # one that went away meanwhile
        return found

    def _saved(self, connections: list[tuple[str, dict]] | None = None) -> list[tuple[str, dict]]:
        """The Wi-Fi networks the box joined and saved."""
        saved = []
        for path, values in self._connections() if connections is None else connections:
            wifi = values.get("802-11-wireless", {})
            if values["connection"].get("type") == "802-11-wireless" and wifi.get("mode", "infrastructure") != "ap":
                saved.append((path, values))
        return saved

    def _own(self, connections: list[tuple[str, dict]] | None = None) -> list[str]:
        """The box's own Wi-Fi as saved: one, or none."""
        connections = self._connections() if connections is None else connections
        return [path for path, values in connections if values["connection"].get("id") == OWN_ID]

    def saved_wifi(self) -> bool:
        """Whether there is a Wi-Fi network to go back to: one the box joined, or its own."""
        connections = self._connections()
        return bool(self._saved(connections) or self._own(connections))

    def own_network_exists(self) -> bool:
        return bool(self._own())

    def own_network_active(self) -> bool:
        return any(name == OWN_ID for name, _kind in self._activated())

    def own_network_up(self, name: str, password: str, timeout: float = 30.0) -> bool:
        """Makes the box's own Wi-Fi: its saved connection set to this name and password (added the first time), then
        activated on the Wi-Fi radio, which leaves any network the box was on. Whether it came up."""
        device = self.wifi_device()
        if not device:
            return False
        values = own_network_settings(name, password)
        saved = self._own()
        for extra in saved[1:]:
            self._delete(extra)
        try:
            if saved:
                dbus.Interface(self.bus.get_object(NM, saved[0]), NM + ".Settings.Connection").Update(values)
                path = saved[0]
            else:
                settings = dbus.Interface(self.bus.get_object(NM, SETTINGS_PATH), NM + ".Settings")
                path = str(settings.AddConnection(values))
            active = self.nm.ActivateConnection(dbus.ObjectPath(path), dbus.ObjectPath(device), dbus.ObjectPath("/"))
        except dbus.DBusException as error:
            print(f"The box's own Wi-Fi did not start: {error.get_dbus_message()}", flush=True)
            return False
        return self._wait(str(active), timeout)

    def forget_wifi(self) -> int:
        """Forgets every Wi-Fi network the box joined, and its own Wi-Fi: how many there were."""
        paths = [path for path, _values in self._saved()] + self._own()
        for path in paths:
            self._delete(path)
        return len(paths)

    def own_network_down(self) -> bool:
        """Takes the box's own Wi-Fi away for good: NetworkManager goes back to the networks the box joined. Whether
        there was one."""
        saved = self._own()
        for path in saved:
            self._delete(path)
        return bool(saved)

    def scan(self, wait: float = 4.0) -> list[Network]:
        """The networks the radio sees, after asking it to look again; the strongest of each name only."""
        device = self.wifi_device()
        if not device:
            return []
        wireless = dbus.Interface(self.bus.get_object(NM, device), WIRELESS)
        try:
            wireless.RequestScan(_sv({}))
            time.sleep(wait)
        except dbus.DBusException:
            pass  # a scan just ran, or the radio is busy: what it saw last will do
        found: dict[bytes, Network] = {}
        for path in wireless.GetAllAccessPoints():
            try:
                ssid = bytes(self._get(path, ACCESS_POINT, "Ssid"))
                strength = int(self._get(path, ACCESS_POINT, "Strength"))
                auth = auth_of(*(int(self._get(path, ACCESS_POINT, name)) for name in ("Flags", "WpaFlags", "RsnFlags")))
            except dbus.DBusException:
                continue
            # NetworkManager gives a percentage; Improv wants dBm, which this approximates.
            network = Network(ssid=ssid, rssi=strength // 2 - 100, auth=auth)
            if ssid and (ssid not in found or found[ssid].rssi < network.rssi):
                found[ssid] = network
        return sorted(found.values(), key=lambda item: item.rssi, reverse=True)

    def _wait(self, active: str, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                state = int(self._get(active, ACTIVE, "State"))
            except dbus.DBusException:
                return False  # gone: it failed and NetworkManager let it go
            if state == ACTIVATED:
                return True
            if state == DEACTIVATED:
                return False
            time.sleep(0.5)
        return False

    def join(self, ssid: bytes, password: bytes, auth: str = "", timeout: float = 45.0) -> bool:
        """Joins the network and saves it, replacing what was saved for the same name; nothing is kept if it fails.
        Where the network also takes WPA2 and the box, joined, gets no traffic addressed to it back, it joins again
        with WPA3 ruled out: a Raspberry Pi's Wi-Fi that settles on WPA3 there can take broadcasts and nothing else."""
        before = [path for path, saved in self._saved() if bytes(saved["802-11-wireless"].get("ssid", b"")) == ssid]
        path = self._join(ssid, password, auth, timeout)
        if not path:
            return False
        if password and auth != "WPA3" and not reaches_out():
            print("Joined, but no traffic addressed to the box comes back: joining again with WPA2 alone.", flush=True)
            plain = self._join(ssid, password, auth, timeout, wpa2_only=True)
            if plain and reaches_out():
                self._delete(path)
                path = plain
                print("With WPA2 alone the box is reachable.", flush=True)
            else:
                # Neither got through (a network with no way out, say): the first, as the network offered it, stays.
                if plain:
                    self._delete(plain)
                self._activate(path, timeout)
        for old in before:
            self._delete(old)
        return True

    def _join(self, ssid: bytes, password: bytes, auth: str, timeout: float, wpa2_only: bool = False) -> str | None:
        """One connection to the network, saved and activated: its path, or None (and nothing saved) if it fails."""
        device = self.wifi_device()
        if not device:
            return None
        name = ssid.decode("utf-8", errors="replace")
        others = [int(saved["connection"].get("autoconnect-priority", 0)) for _path, saved in self._saved()
                  if bytes(saved["802-11-wireless"].get("ssid", b"")) != ssid]
        values = {
            "connection": _sv({"id": name, "type": "802-11-wireless", "autoconnect": True,
                               "autoconnect-priority": dbus.Int32(next_priority(others))}),
            "802-11-wireless": _sv({"ssid": dbus.ByteArray(ssid), "mode": "infrastructure"}),
            "ipv4": _sv({"method": "auto"}),
            "ipv6": _sv({"method": "auto"}),
        }
        if password:
            # A network that takes WPA3 alone needs SAE; one that also takes WPA2 is joined with its pre-shared key, and
            # with management frame protection off (1) when WPA3, which requires it, is to be ruled out.
            security = {"key-mgmt": "sae" if auth == "WPA3" else "wpa-psk", "psk": password.decode("utf-8")}
            if wpa2_only:
                security["pmf"] = dbus.Int32(1)
            values["802-11-wireless-security"] = _sv(security)
        path, active, _result = self.nm.AddAndActivateConnection2(
            dbus.Dictionary(values, signature="sa{sv}"), dbus.ObjectPath(device), dbus.ObjectPath("/"),
            _sv({"persist": "disk"}),
        )
        if not self._wait(str(active), timeout):
            self._delete(str(path))
            return None
        return str(path)

    def _activate(self, path: str, timeout: float) -> None:
        device = self.wifi_device()
        if not device:
            return
        try:
            active = self.nm.ActivateConnection(dbus.ObjectPath(path), dbus.ObjectPath(device), dbus.ObjectPath("/"))
            self._wait(str(active), timeout)
        except dbus.DBusException:
            pass

    def _delete(self, path: str) -> None:
        try:
            dbus.Interface(self.bus.get_object(NM, path), NM + ".Settings.Connection").Delete()
        except dbus.DBusException:
            pass

    def hotspot_up(self, ssid: str) -> str | None:
        """The open setup hotspot, on the box's own address, with every name resolving to it (wildcard_dns): its active
        connection, which hotspot_down takes."""
        device = self.wifi_device()
        if not device:
            return None
        values = {
            "connection": _sv({"id": HOTSPOT_ID, "type": "802-11-wireless", "autoconnect": False}),
            "802-11-wireless": _sv({"ssid": dbus.ByteArray(ssid.encode("utf-8")), "mode": "ap", "band": "bg"}),
            "ipv4": _shared(),
            "ipv6": _sv({"method": "disabled"}),
        }
        wildcard_dns(True)
        try:
            _path, active, _result = self.nm.AddAndActivateConnection2(
                dbus.Dictionary(values, signature="sa{sv}"), dbus.ObjectPath(device), dbus.ObjectPath("/"),
                _sv({"persist": "volatile"}),
            )
        except dbus.DBusException as error:
            wildcard_dns(False)
            print(f"The setup hotspot did not start: {error.get_dbus_message()}", flush=True)
            return None
        if not self._wait(str(active), 20.0):
            wildcard_dns(False)
            return None
        firewall(self.interface())
        return str(active)

    def hotspot_down(self, active: str) -> None:
        firewall(None)
        try:
            self.nm.DeactivateConnection(dbus.ObjectPath(active))
        except dbus.DBusException:
            pass  # already down
        wildcard_dns(False)


RULES = """table inet zirbel_setup {{
  chain prerouting {{
    type nat hook prerouting priority dstnat; policy accept;
    iifname "{iface}" tcp dport 80 redirect to :{port}
  }}
  chain input {{
    type filter hook input priority filter; policy accept;
    iifname "{iface}" udp dport {{ 53, 67 }} accept
    iifname "{iface}" tcp dport {{ 53, {port} }} accept
    iifname "{iface}" drop
  }}
  chain forward {{
    type filter hook forward priority filter; policy accept;
    iifname "{iface}" drop
  }}
}}
"""


def next_priority(saved: list[int]) -> int:
    """The autoconnect priority for a network joined now, from those of the networks saved before it: above them all,
    so after a reboot, with several in reach, the box goes back to the one chosen in setup last; below the box's own
    Wi-Fi, which goes first while it is on."""
    return min(OWN_PRIORITY - 1, max(saved, default=0) + 1)


def reaches_out(attempts: int = 3) -> bool:
    """Whether traffic addressed to the box comes back: its router answers a ping, or the internet a request. Either
    needs the Wi-Fi to take frames addressed to the box, which broadcasts alone don't show."""
    import urllib.request

    for _ in range(attempts):
        route = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True).stdout.split()
        gateway = route[2] if len(route) > 2 and route[0] == "default" and route[1] == "via" else ""
        if gateway and subprocess.run(["ping", "-c", "2", "-W", "2", gateway], capture_output=True).returncode == 0:
            return True
        try:
            urllib.request.urlopen(urllib.request.Request("https://downloads.raspberrypi.com/", method="HEAD"), timeout=6)
            return True
        except OSError:
            time.sleep(2)
    return False


def local_address() -> str | None:
    """The box's IPv4 address on the network it reaches the rest of the world by (no packet goes out to learn it)."""
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        try:
            probe.connect(("192.0.2.1", 9))  # TEST-NET-1: only a route is looked up
            return probe.getsockname()[0]
        except OSError:
            return None


def firewall(iface: str | None, port: int = 8081) -> None:
    """The hotspot's rules while it runs, on its interface alone; None takes them away."""
    subprocess.run(["nft", "destroy", "table", "inet", "zirbel_setup"], capture_output=True, check=False)
    if not iface and subprocess.run(["nft", "list", "table", "inet", "zirbel_setup"], capture_output=True).returncode == 0:
        print("The setup hotspot's firewall could not be taken away.", flush=True)
    if iface:
        if not iface.replace("-", "").replace("_", "").isalnum():
            raise ValueError("An unexpected interface name.")
        subprocess.run(["nft", "-f", "-"], input=RULES.format(iface=iface, port=port), text=True, check=True)
