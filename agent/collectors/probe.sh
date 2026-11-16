export LC_ALL=C
. /etc/os-release 2>/dev/null
echo "hostname=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname)"
echo "kernel=$(uname -r)"
echo "arch=$(uname -m)"
echo "os=$PRETTY_NAME"
echo "uptime=$(cut -d' ' -f1 /proc/uptime)"
echo "load=$(cut -d' ' -f1-3 /proc/loadavg)"
echo "procs=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"
echo "users=$(who 2>/dev/null | wc -l)"
echo "cpus=$(nproc)"
echo "cpumodel=$(lscpu 2>/dev/null | sed -n 's/^Model name: *//p' | head -1)"
echo "cpustat=$(head -1 /proc/stat)"
awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {gsub(":","",$1); print "mem_" $1 "=" $2*1024}' /proc/meminfo
df -B1 -P -T -x tmpfs -x devtmpfs -x efivarfs -x overlay -x squashfs -x vfat 2>/dev/null | awk 'NR>1 {print "disk=" $1 "|" $2 "|" $3 "|" $4 "|" $7}'
t=0
for f in /sys/class/thermal/thermal_zone*/temp /sys/class/hwmon/hwmon*/temp1_input; do
  [ -r "$f" ] || continue
  v=$(cat "$f" 2>/dev/null) || continue
  [ "$v" -gt "$t" ] 2>/dev/null && [ "$v" -lt 130000 ] && t=$v
done
echo "temp=$t"
awk -F'[: ]+' 'NR>2 { sub(/^ +/, ""); split($0, a, /[: ]+/); if (a[1] !~ /^(lo|veth|docker|br-|virbr|tailscale|wg|tun)/) { rx+=a[2]; tx+=a[10] } } END { print "net=" rx+0 " " tx+0 }' /proc/net/dev
ip -4 -o addr show scope global 2>/dev/null | awk '{print "addr=" $2 " " $4}'
systemctl --failed --no-legend --plain 2>/dev/null | awk '{print "failed=" $1}'
if [ -f /var/run/reboot-required ] || { [ -d /usr/lib/modules ] && [ ! -d "/usr/lib/modules/$(uname -r)" ]; }; then echo "reboot=1"; else echo "reboot=0"; fi
if command -v omarchy-update >/dev/null 2>&1; then echo pkg=omarchy
elif command -v yay >/dev/null 2>&1; then echo pkg=yay
elif command -v paru >/dev/null 2>&1; then echo pkg=paru
elif command -v pacman >/dev/null 2>&1; then echo pkg=pacman
elif command -v apt-get >/dev/null 2>&1; then echo pkg=apt
elif command -v dnf >/dev/null 2>&1; then echo pkg=dnf
else echo pkg=unknown; fi
