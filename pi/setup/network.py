"""The box's network, through NetworkManager's D-Bus API: whether it is online, the Wi-Fi networks it sees, joining one,
and the open setup hotspot with its firewall.

A password goes to NetworkManager over D-Bus, never on a command line another process could read. The hotspot is a
volatile connection NetworkManager never saves. While it runs, nftables sends its clients' port 80 to the setup page,
and lets them reach nothing else on the box or beyond it.
"""

from __future__ import annotations

import subprocess
import time

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


def _sv(values: dict) -> dbus.Dictionary:
    return dbus.Dictionary(values, signature="sv")


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

    def online(self) -> bool:
        """Whether the box is on a network: a Wi-Fi or wired connection up, other than its setup hotspot."""
        for path in self.props.Get(NM, "ActiveConnections"):
            try:
                if (
                    str(self._get(path, ACTIVE, "Id")) != HOTSPOT_ID
                    and str(self._get(path, ACTIVE, "Type")) in ONLINE_TYPES
                    and int(self._get(path, ACTIVE, "State")) == ACTIVATED
                ):
                    return True
            except dbus.DBusException:
                continue  # one that went away meanwhile
        return False

    def _saved(self) -> list[tuple[str, dict]]:
        settings = dbus.Interface(self.bus.get_object(NM, SETTINGS_PATH), NM + ".Settings")
        saved = []
        for path in settings.ListConnections():
            connection = dbus.Interface(self.bus.get_object(NM, path), NM + ".Settings.Connection")
            values = connection.GetSettings()
            wifi = values.get("802-11-wireless", {})
            if values["connection"].get("type") == "802-11-wireless" and wifi.get("mode", "infrastructure") != "ap":
                saved.append((str(path), values))
        return saved

    def saved_wifi(self) -> bool:
        return bool(self._saved())

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
        """Joins the network and saves it, replacing what was saved for the same name; nothing is kept if it fails."""
        device = self.wifi_device()
        if not device:
            return False
        name = ssid.decode("utf-8", errors="replace")
        values = {
            "connection": _sv({"id": name, "type": "802-11-wireless", "autoconnect": True}),
            "802-11-wireless": _sv({"ssid": dbus.ByteArray(ssid), "mode": "infrastructure"}),
            "ipv4": _sv({"method": "auto"}),
            "ipv6": _sv({"method": "auto"}),
        }
        if password:
            # A network that takes WPA3 alone needs SAE; one that also takes WPA2 is joined with its pre-shared key.
            values["802-11-wireless-security"] = _sv(
                {"key-mgmt": "sae" if auth == "WPA3" else "wpa-psk", "psk": password.decode("utf-8")}
            )
        before = [path for path, saved in self._saved() if bytes(saved["802-11-wireless"].get("ssid", b"")) == ssid]
        path, active, _result = self.nm.AddAndActivateConnection2(
            dbus.Dictionary(values, signature="sa{sv}"), dbus.ObjectPath(device), dbus.ObjectPath("/"),
            _sv({"persist": "disk"}),
        )
        if not self._wait(str(active), timeout):
            self._delete(str(path))
            return False
        for old in before:
            self._delete(old)
        return True

    def _delete(self, path: str) -> None:
        try:
            dbus.Interface(self.bus.get_object(NM, path), NM + ".Settings.Connection").Delete()
        except dbus.DBusException:
            pass

    def hotspot_up(self, ssid: str) -> str | None:
        """The open setup hotspot, on the box's own address, with every name resolving to it (dnsmasq-shared.conf):
        its active connection, which hotspot_down takes."""
        device = self.wifi_device()
        if not device:
            return None
        values = {
            "connection": _sv({"id": HOTSPOT_ID, "type": "802-11-wireless", "autoconnect": False}),
            "802-11-wireless": _sv({"ssid": dbus.ByteArray(ssid.encode("utf-8")), "mode": "ap", "band": "bg"}),
            "ipv4": _sv(
                {
                    "method": "shared",
                    "address-data": dbus.Array(
                        [_sv({"address": HOTSPOT_ADDRESS, "prefix": dbus.UInt32(24)})], signature="a{sv}"
                    ),
                }
            ),
            "ipv6": _sv({"method": "disabled"}),
        }
        try:
            _path, active, _result = self.nm.AddAndActivateConnection2(
                dbus.Dictionary(values, signature="sa{sv}"), dbus.ObjectPath(device), dbus.ObjectPath("/"),
            _sv({"persist": "volatile"}),
            )
        except dbus.DBusException as error:
            print(f"The setup hotspot did not start: {error.get_dbus_message()}", flush=True)
            return None
        if not self._wait(str(active), 20.0):
            return None
        firewall(self.interface())
        return str(active)

    def hotspot_down(self, active: str) -> None:
        firewall(None)
        try:
            self.nm.DeactivateConnection(dbus.ObjectPath(active))
        except dbus.DBusException:
            pass  # already down


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
