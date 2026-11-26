#!/bin/sh
# The box's report on its boot partition, which a Mac reads with the card in a reader: what a box that can't be
# reached over the network says about itself, for whoever helps set it up. No password or key goes in it. The first
# report of a boot keeps the last one of the boot before as zirbel-report-previous.txt.
boot=/boot/firmware
out=$boot/zirbel-report.txt
tmp=$boot/.zirbel-report.tmp
if [ ! -e /run/zirbel-report ] && [ -e "$out" ]; then mv -f "$out" "$boot/zirbel-report-previous.txt"; fi
touch /run/zirbel-report
{
  echo "Zirbel box report, $(date -Is), up $(uptime -p | sed 's/^up //')"
  tr -d '\0' </proc/device-tree/model; echo
  echo "boots in the journal: $(journalctl --list-boots --no-pager 2>/dev/null | wc -l); power: $(vcgencmd get_throttled 2>/dev/null)"
  echo "== addresses"; ip -br addr
  echo "== routes"; ip route; ip -6 route | head -20
  echo "== reverse path filter: all $(sysctl -n net.ipv4.conf.all.rp_filter), wlan0 $(sysctl -n net.ipv4.conf.wlan0.rp_filter 2>/dev/null)"
  echo "== connections"; nmcli -t -f NAME,TYPE,DEVICE,STATE connection show --active; nmcli -t -f NAME,TYPE,AUTOCONNECT connection show
  echo "== Wi-Fi"; iw dev wlan0 link 2>&1; iw dev wlan0 get power_save 2>&1
  # The box's own Wi-Fi (pi/setup/own_network.py): whether it runs and how many devices are on it, never its password.
  if nmcli -t -f NAME connection show --active | grep -qx zirbel-network; then
    echo "own Wi-Fi: on, $(nmcli -g 802-11-wireless.ssid connection show zirbel-network), $(iw dev wlan0 station dump 2>/dev/null | grep -c '^Station') clients"
  elif nmcli -t -f NAME connection show | grep -qx zirbel-network; then echo "own Wi-Fi: saved, not running"
  else echo "own Wi-Fi: off"; fi
  # The security the connection negotiated (WPA2 or WPA3, its ciphers, management frame protection): never a key.
  wpa_cli -i wlan0 status 2>&1 | grep -E "^(wpa_state|key_mgmt|pairwise_cipher|group_cipher|pmf|sae_group|freq)="
  ip -s link show wlan0 2>&1 | sed -n '3,6p'
  echo "== reaching out: traffic addressed to the box comes back only where unicast works"
  gateway=$(ip route show default | awk '{ print $3; exit }')
  [ -n "$gateway" ] && ping -c 3 -W 2 "$gateway" 2>&1 | tail -2
  curl -s -o /dev/null -m 8 -w "internet: HTTP %{http_code} in %{time_total}s\n" https://downloads.raspberrypi.com/ 2>&1
  echo "== firewall tables"; nft list tables 2>&1
  echo "== radio switches"; rfkill list 2>&1
  echo "== services"; systemctl is-active zirbel zirbel-setup zirbel-tv NetworkManager avahi-daemon ssh | paste -sd' '
  systemctl --failed --no-legend --no-pager
  echo "== listening"; ss -ltnu | head -20
  echo "== setup service, this boot"; journalctl -u zirbel-setup -b --no-pager -o short-monotonic | tail -60
  echo "== editor, this boot"; journalctl -u zirbel -b --no-pager -o short-monotonic | tail -15
  # The HDMI console (AGENTS.md): the displays plugged in, and what it and its follower said.
  echo "== TV console: displays $(grep -lx connected /sys/class/drm/card*-*/status 2>/dev/null | cut -d/ -f5 | paste -sd' ')"
  journalctl -u zirbel-tv-follow -u zirbel-tv -b --no-pager -o short-monotonic | tail -15
  # The controllers service logs the gamepads that come and go, never their input.
  echo "== controllers: $(systemctl is-active bluetooth zirbel-pads | paste -sd' ')"
  bluetoothctl show 2>&1 | grep -E "Controller|Powered|PowerState|Discovering"
  journalctl -u zirbel-pads -b --no-pager -o short-monotonic | tail -15
  echo "== warnings, this boot"; journalctl -b -p warning --no-pager -o short-monotonic | tail -40
} >"$tmp" 2>&1
mv -f "$tmp" "$out"
