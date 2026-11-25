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
  echo "== firewall tables"; nft list tables 2>&1
  echo "== radio switches"; rfkill list 2>&1
  echo "== Bluetooth"; bluetoothctl show 2>&1 | grep -E "Controller|Powered|Discoverable|Pairable|Alias|PowerState"
  echo "== services"; systemctl is-active zirbel zirbel-setup bluetooth NetworkManager avahi-daemon ssh | paste -sd' '
  systemctl --failed --no-legend --no-pager
  echo "== listening"; ss -ltnu | head -20
  echo "== setup service, this boot"; journalctl -u zirbel-setup -b --no-pager -o short-monotonic | tail -60
  echo "== editor, this boot"; journalctl -u zirbel -b --no-pager -o short-monotonic | tail -15
  echo "== warnings, this boot"; journalctl -b -p warning --no-pager -o short-monotonic | tail -40
} >"$tmp" 2>&1
mv -f "$tmp" "$out"
